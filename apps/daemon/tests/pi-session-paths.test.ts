import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

import {
  attachPiRpcSession,
  makePortablePiSessionPath,
  resolvePortablePiSessionPath,
} from '../src/pi-rpc.js';

type JsonRecord = Record<string, unknown>;
type TestSentEvent = JsonRecord & { channel?: string };
type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};
type MockWritable = Pick<Writable, 'write'>;

function createMockChild(options: { closeOn?: NodeJS.Signals | 'any' } = {}): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killed = true;
    if ((options.closeOn ?? 'any') === 'any' || options.closeOn === signal) {
      child.emit('close', null, signal);
    }
    return true;
  };
  return child;
}

function parseJsonRecord(line: string): JsonRecord {
  const parsed = JSON.parse(line) as unknown;
  assert.ok(parsed && typeof parsed === 'object');
  return parsed as JsonRecord;
}

function readCommands(child: MockChildProcess): JsonRecord[] {
  const chunk = child.stdin.read();
  return chunk
    ? chunk.toString().trim().split('\n').filter(Boolean).map((line: string) => parseJsonRecord(line))
    : [];
}

async function createSessionFixture(options: {
  projectDir: string;
  root: string;
  parentSession?: string;
}) {
  const fsp = fs.promises;
  await fsp.mkdir(options.projectDir, { recursive: true });
  await fsp.mkdir(options.root, { recursive: true });
  const sessionPath = path.join(options.root, 'session.jsonl');
  await fsp.writeFile(
    sessionPath,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'fixture-session',
      timestamp: '2026-08-06T00:00:00.000Z',
      cwd: options.projectDir,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    })}\n`,
  );
  return { sessionPath };
}

// ─── portable path helpers ─────────────────────────────────────────────────

test('makePortablePiSessionPath stores a session file path relative to its owner root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-root-'));
  const sessionPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(sessionPath, '{}');
  try {
    const stored = makePortablePiSessionPath(sessionPath, root);
    assert.equal(path.isAbsolute(stored), false, 'stored reference must be relative');
    assert.equal(stored, 'session.jsonl');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePortablePiSessionPath survives a move of the owner root', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-root-a-'));
  const sessionPath = path.join(rootA, 'session.jsonl');
  fs.writeFileSync(sessionPath, '{}');
  const stored = makePortablePiSessionPath(sessionPath, rootA);
  const rootB = path.join(path.dirname(rootA), `${path.basename(rootA)}-moved`);
  fs.renameSync(rootA, rootB);
  try {
    const resolved = resolvePortablePiSessionPath(stored, rootB);
    assert.equal(resolved, path.join(rootB, 'session.jsonl'));
    assert.equal(fs.existsSync(resolved), true);
  } finally {
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('resolvePortablePiSessionPath accepts legacy absolute paths unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-root-'));
  const sessionPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(sessionPath, '{}');
  try {
    const resolved = resolvePortablePiSessionPath(sessionPath, root);
    assert.equal(resolved, sessionPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── integration: resume path portability ──────────────────────────────────

test('attachPiRpcSession resumes after its owner root is moved using a relative stored path', async () => {
  const fsp = fs.promises;
  const tmpBase = os.tmpdir();
  const projectDir = fs.mkdtempSync(path.join(tmpBase, 'pi-session-project-'));
  const rootA = fs.mkdtempSync(path.join(tmpBase, 'pi-session-root-a-'));
  let rootB: string | undefined;
  try {
    const { sessionPath } = await createSessionFixture({ projectDir, root: rootA });
    const storedPath = makePortablePiSessionPath(sessionPath, rootA);

    rootB = path.join(path.dirname(rootA), `${path.basename(rootA)}-moved`);
    await fsp.rename(rootA, rootB);

    const resolvedPath = resolvePortablePiSessionPath(storedPath, rootB);
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'resume after move',
      cwd: projectDir,
      sessionDir: rootB,
      resumeSession: { path: resolvedPath, root: rootB },
      send: (channel, payload) => events.push({ channel, ...payload }),
    });

    const [resume] = readCommands(child);
    assert.equal(resume?.type, 'switch_session');
    assert.equal(resume?.sessionPath, resolvedPath);
    assert.equal(events.find((e) => e.channel === 'error'), undefined);
  } finally {
    await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    if (rootB) await fsp.rm(rootB, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(rootA, { recursive: true, force: true }).catch(() => {});
  }
});

test('attachPiRpcSession resumes a legacy absolute stored path when the root has not moved', async () => {
  const fsp = fs.promises;
  const tmpBase = os.tmpdir();
  const projectDir = fs.mkdtempSync(path.join(tmpBase, 'pi-session-project-'));
  const root = fs.mkdtempSync(path.join(tmpBase, 'pi-session-root-'));
  try {
    const { sessionPath } = await createSessionFixture({ projectDir, root });

    const events: TestSentEvent[] = [];
    const child = createMockChild();
    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'resume legacy absolute path',
      cwd: projectDir,
      sessionDir: root,
      resumeSession: { path: sessionPath, root },
      send: (channel, payload) => events.push({ channel, ...payload }),
    });

    const [resume] = readCommands(child);
    assert.equal(resume?.type, 'switch_session');
    assert.equal(resume?.sessionPath, sessionPath);
    assert.equal(events.find((e) => e.channel === 'error'), undefined);
  } finally {
    await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
