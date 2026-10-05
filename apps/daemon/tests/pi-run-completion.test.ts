import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'vitest';

// A real RPC child completes only after get_state and stdin EOF, without timers.
const rpcChild = `
const fs = require('node:fs');
const path = require('node:path');
const input = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
const sessionFile = path.join(process.env.P0_SESSION_DIR, 'session.jsonl');
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'switch_session') {
    if (request.sessionPath !== sessionFile) throw new Error('Resume did not resolve against the owner root');
    fs.writeFileSync(path.join(process.env.P0_SESSION_DIR, 'resumed'), request.sessionPath);
    send({ type: 'response', id: request.id, command: request.type, success: true });
  } else if (request.type === 'prompt') {
    fs.appendFileSync(path.join(process.env.P0_SESSION_DIR, 'prompts.jsonl'), JSON.stringify(request) + String.fromCharCode(10));
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
      id: 'completion-session', timestamp: new Date().toISOString(), cwd: process.cwd() }) + String.fromCharCode(10));
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'completed' } });
    send({ type: 'turn_end', message: { stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2 } } });
    send({ type: 'agent_end' });
    send({ type: 'agent_settled' });
  } else if (request.type === 'get_state') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile } });
  }
});
`;

test.each([
  { label: 'different text', secondMessage: 'Summarize the next task', explicitCurrentPrompt: false },
  { label: 'same text', secondMessage: 'Complete this turn', explicitCurrentPrompt: false },
  { label: 'explicit latest turn', secondMessage: 'Summarize the next task', explicitCurrentPrompt: true },
])('successful Pi completion preserves $label on resume and persists its owned session', async ({ secondMessage, explicitCurrentPrompt }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-pi-completion-'));
  const logPath = path.join(root, 'daemon.log');
  const fd = fs.openSync(logPath, 'a');
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { startDaemonRuntime } from './src/daemon-startup.ts';
    const runtime = await startDaemonRuntime({ port: 0,
      hostedRequestBoundary: { testComposition: true, resolveIdentity: async () => ({ userKey: 'completion-user', storageKey: 'completion' }) },
      hostedPiRuntime: async request => {
        const sessionDir = path.join(request.cwd, '.pi', 'sessions', 'owned');
        fs.mkdirSync(sessionDir, { recursive: true });
        return { invocation: { command: process.execPath, args: ['-e', ${JSON.stringify(rpcChild)}],
          cwd: request.cwd, env: { ...process.env, P0_SESSION_DIR: sessionDir },
          packageRoot: request.cwd, entrypoint: process.execPath, agentDir: sessionDir, sessionDir }, close: async () => {} };
      }
    });
    process.on('message', async message => { if (message === 'stop') { await runtime.stop(); process.exit(0); } });
    process.send({ url: runtime.url });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, READABLE_DATA_DIR: path.join(root, 'data'), READABLE_INSTALLATION_DIR: root },
  });
  const exited = once(child, 'exit');
  let failure: unknown;
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
    const url = (ready as { url: string }).url;
    const post = async (route: string, body: unknown) => fetch(`${url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const created = await post('/api/projects', { id: 'completion-project', name: 'Completion' });
    assert.equal(created.status, 200);
    const { conversationId } = await created.json() as { conversationId: string };
    // A second turn also exercises reading the portable session written by close.
    for (let turn = 0; turn < 2; turn++) {
      const message = turn === 0 ? 'Complete this turn' : secondMessage;
      const accepted = await post('/api/runs', { projectId: 'completion-project', conversationId,
        agentId: 'pi', model: 'anthropic/claude-sonnet-4-5', message,
        ...(explicitCurrentPrompt ? { currentPrompt: message } : {}) });
      assert.equal(accepted.status, 202);
      const { runId } = await accepted.json() as { runId: string };
      // The replaying SSE surface closes on the exact terminal run event.
      const events = await fetch(`${url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(10_000) });
      await events.text();
      const status = await fetch(`${url}/api/runs/${runId}`).then(response => response.json()) as { status: string };
      assert.equal(status.status, 'succeeded');
      assert.equal((await fetch(`${url}/api/health`)).status, 200);
      const db = new Database(path.join(root, 'data', 'app.sqlite'), { readonly: true, fileMustExist: true });
      try {
        const stored = db.prepare('SELECT session_id FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?')
          .get(conversationId, 'pi') as { session_id: string };
        assert.equal(stored.session_id, path.join('owned', 'session.jsonl'));
        assert.equal(path.isAbsolute(stored.session_id), false);
      } finally {
        db.close();
      }
      const projectsDir = path.join(root, 'data', 'projects');
      const files = fs.readdirSync(projectsDir, { recursive: true });
      if (turn === 1) {
        const resumed = files.find(file => String(file).endsWith(`${path.sep}resumed`));
        assert.ok(resumed, 'second turn must switch to the persisted owned session');
      }
      const promptsFile = files.find(file => String(file).endsWith(`${path.sep}prompts.jsonl`));
      assert.ok(promptsFile, 'RPC child must record the actual prompt command');
      const prompts = fs.readFileSync(path.join(projectsDir, String(promptsFile)), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line) as { message: string });
      assert.equal(prompts.length, turn + 1);
      const prompt = prompts[turn];
      assert.ok(prompt, 'each accepted turn must have a captured RPC prompt');
      assert.equal(prompt.message.split('# User request\n\n').at(-1), message,
        'typed instruction must reach Pi verbatim, including on resumed identical turns');
    }
  } catch (error) {
    failure = error;
  } finally {
    if (child.connected) child.send('stop');
    const deadline = setTimeout(() => child.kill(), 10_000);
    await exited;
    clearTimeout(deadline);
    fs.closeSync(fd);
    const log = fs.readFileSync(logPath, 'utf8');
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(child.exitCode, 0, log);
    if (failure) throw failure;
  }
}, 45_000);
