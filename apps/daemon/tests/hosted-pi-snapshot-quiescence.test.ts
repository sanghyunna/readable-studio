import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getAgentSession,
  insertConversation,
  insertProject,
  upsertAgentSession,
} from '../src/db.js';
import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotFailpoint,
} from '../src/hosted-snapshots.js';
import { attachPiRpcSession } from '../src/pi-rpc.js';

type MockChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};

const roots: string[] = [];
const storages: Array<ReturnType<typeof createHostedRuntimeStorage>> = [];
const identity = {
  storageKey: 'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a',
  userKey: 'user-a',
} as const;

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function readCommands(child: MockChild): Array<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = child.stdin.read() as Buffer | null) !== null) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text
    ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

function feed(child: MockChild, values: ReadonlyArray<Record<string, unknown>>): void {
  child.stdout.write(`${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

function versionNames(runtimeRoot: string): string[] {
  return readdirSync(
    path.join(runtimeRoot, 'snapshots', identity.storageKey, 'versions'),
  ).filter((name) => /^\d{20}$/u.test(name));
}

function createRuntime() {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'readable-hosted-pi-quiescence-'));
  roots.push(runtimeRoot);
  const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
  storages.push(storage);
  const now = Date.now();
  insertProject(storage.database, {
    createdAt: now,
    id: 'project-a',
    name: 'Project A',
    updatedAt: now,
  });
  insertConversation(storage.database, {
    createdAt: now,
    id: 'conversation-a',
    projectId: 'project-a',
    updatedAt: now,
  });
  const projectRoot = path.join(storage.roots.projectsRoot, 'project-a');
  mkdirSync(projectRoot);
  return { projectRoot, runtimeRoot, storage };
}

describe('hosted Pi snapshot quiescence', () => {
  it('resumes the relocated restored session before sending the original prompt', async () => {
    const { projectRoot, runtimeRoot, storage } = createRuntime();
    const sessionPath = path.join(storage.roots.sessionsRoot, 'session.jsonl');
    const historicalTranscript = 'historical-transcript-must-not-be-replayed';
    const originalPrompt = 'continue from the restored session';
    writeFileSync(sessionPath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'restored-session',
        timestamp: '2026-08-06T00:00:00.000Z',
        cwd: projectRoot,
      }),
      JSON.stringify({ type: 'message', role: 'assistant', content: historicalTranscript }),
      '',
    ].join('\n'));
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: sessionPath,
    });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();

    const restored = await snapshots.restore();
    expect(restored).not.toBeNull();
    if (restored == null) return;
    try {
      const restoredSession = getAgentSession(
        restored.storage.database,
        'conversation-a',
        'pi',
      );
      expect(restoredSession).toBe(path.join(restored.storage.roots.sessionsRoot, 'session.jsonl'));
      const child = createMockChild();
      attachPiRpcSession({
        child: child as unknown as ChildProcess,
        cwd: path.join(restored.storage.roots.projectsRoot, 'project-a'),
        prompt: originalPrompt,
        resumeSession: {
          path: restoredSession!,
          root: restored.storage.roots.sessionsRoot,
        },
        send: () => {},
      });

      const initial = readCommands(child);
      expect(initial).toEqual([expect.objectContaining({
        sessionPath: restoredSession,
        type: 'switch_session',
      })]);
      expect(initial.some((command) => command.type === 'new_session')).toBe(false);
      expect(readCommands(child)).toEqual([]);

      feed(child, [{
        command: 'switch_session',
        data: { cancelled: false },
        id: initial[0]?.id,
        success: true,
        type: 'response',
      }]);
      const afterResume = readCommands(child);
      expect(afterResume).toEqual([expect.objectContaining({
        message: originalPrompt,
        type: 'prompt',
      })]);
      expect(JSON.stringify(afterResume)).not.toContain(historicalTranscript);
      expect(afterResume.some((command) => command.type === 'new_session')).toBe(false);
      child.emit('close', 0, null);
    } finally {
      restored.storage.close();
    }
  });

  it('does not begin publication until validated state capture and child close', async () => {
    const { projectRoot, runtimeRoot, storage } = createRuntime();
    const sessionPath = path.join(storage.roots.sessionsRoot, 'session.jsonl');
    writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', cwd: projectRoot })}\n`);
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: sessionPath,
    });
    const stages: HostedSnapshotFailpoint[] = [];
    const snapshots = createHostedSnapshotStore({
      failpoint: (stage) => { stages.push(stage); },
      identity,
      runtimeRoot,
    });
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      cwd: projectRoot,
      prompt: 'turn',
      send: () => {},
      sessionDir: storage.roots.sessionsRoot,
    });
    readCommands(child);
    const publication = snapshots.publish({
      quiesce: session.waitForQuiescence,
      storage,
    });

    feed(child, [{ type: 'agent_end' }, { type: 'agent_settled' }]);
    const [getState] = readCommands(child);
    feed(child, [{
      command: 'get_state',
      data: { sessionFile: sessionPath },
      id: getState?.id,
      success: true,
      type: 'response',
    }]);
    await Promise.resolve();
    expect(stages).toEqual([]);
    expect(versionNames(runtimeRoot)).toEqual([]);

    child.emit('close', 0, null);
    await expect(publication).resolves.toMatchObject({ sequence: '00000000000000000001' });
    expect(stages[0]).toBe('after-session-copy');
    storage.close();
  });

  it('does not publish after a crash without safely captured session state', async () => {
    const { projectRoot, runtimeRoot, storage } = createRuntime();
    const stages: HostedSnapshotFailpoint[] = [];
    const snapshots = createHostedSnapshotStore({
      failpoint: (stage) => { stages.push(stage); },
      identity,
      runtimeRoot,
    });
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      cwd: projectRoot,
      prompt: 'turn',
      send: () => {},
      sessionDir: storage.roots.sessionsRoot,
    });
    readCommands(child);
    const publication = snapshots.publish({
      quiesce: session.waitForQuiescence,
      storage,
    });

    child.emit('close', 1, null);

    await expect(publication).rejects.toThrow(/without a safely captured session/u);
    expect(stages).toEqual([]);
    expect(versionNames(runtimeRoot)).toEqual([]);
    storage.close();
  });

  it('publishes canceled state only after the safe exit fallback and child close', async () => {
    const { projectRoot, runtimeRoot, storage } = createRuntime();
    const sessionPath = path.join(storage.roots.sessionsRoot, 'canceled.jsonl');
    const stages: HostedSnapshotFailpoint[] = [];
    const snapshots = createHostedSnapshotStore({
      failpoint: (stage) => { stages.push(stage); },
      identity,
      runtimeRoot,
    });
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      cwd: projectRoot,
      prompt: 'turn',
      send: () => {},
      sessionDir: storage.roots.sessionsRoot,
    });
    readCommands(child);
    const publication = snapshots.publish({
      quiesce: session.waitForQuiescence,
      storage,
    });

    session.abort();
    readCommands(child);
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'session', cwd: projectRoot }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'partial-safe-state' }),
      '',
    ].join('\n'));
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: sessionPath,
    });
    await Promise.resolve();
    expect(stages).toEqual([]);

    child.emit('close', null, 'SIGTERM');

    await expect(publication).resolves.toBeDefined();
    expect(stages[0]).toBe('after-session-copy');
    storage.close();
  });
});
