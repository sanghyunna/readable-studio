import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FakeAgentRuntime } from '../fake-agents.ts';

// Codex app-server fixture: the held prompt stays running until
// POST /api/projects/:id/files writes releaseFile/releaseToken; every turn
// carrying queuedMarker (and anything else) completes at once.
export const QUEUED_EDIT_RUN = {
  heldPrompt: 'Hold this run open until the queued-edit release file appears',
  heldAck: 'Queued-edit hold is armed.',
  queuedMarker: 'readable-e2e:queued-edit:',
  queuedReply: 'Queued turn handled.',
  releaseFile: 'e2e-queued-edit.release',
  releaseToken: 'readable-e2e-queued-edit:release:v1',
  timeoutMs: 120_000,
} as const;

/** Generated CommonJS and cmd files exercise the real external Windows CLI boundary. */
export async function createQueuedEditAgent(root: string): Promise<FakeAgentRuntime> {
  if (!isAbsolute(root)) throw new Error('Queued-edit agent fixture root must be absolute');
  await mkdir(root, { recursive: true });
  const script = join(root, 'queued-edit-codex.cjs');
  const bin = join(root, 'queued-edit-codex.cmd');
  await writeFile(script, `#!/usr/bin/env node
const { readFileSync, watch } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const run = ${JSON.stringify(QUEUED_EDIT_RUN)};
const done = '\\n<!-- readable:no-document-required reason="read-only" -->';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-e2e 0.0.0\\n');
} else if (process.argv[2] === 'app-server') {
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const text = delta => send({ method: 'item/agentMessage/delta', params: { itemId: 'queued-edit-message', delta } });
  const complete = (status, message) => send({ method: 'turn/completed', params: { turn: { id: 'queued-edit-turn', status,
    ...(message ? { error: { message } } : {}) } } });
  let project = process.env.READABLE_PROJECT_DIR || process.cwd();
  let watcher, timeout, settled = true;
  const cleanup = () => { watcher?.close(); clearTimeout(timeout); watcher = undefined; timeout = undefined; };
  const finish = (status, message) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (status === 'completed') text(done);
    complete(status, message);
  };
  function hold() {
    const release = join(project, run.releaseFile);
    settled = false;
    function check() {
      if (settled) return;
      try { if (readFileSync(release, 'utf8') === run.releaseToken) finish('completed'); }
      catch (error) { if (error.code !== 'ENOENT') finish('failed', error.message); }
    }
    watcher = watch(project, (_event, filename) => {
      if (filename === null || String(filename) === run.releaseFile) check();
    });
    watcher.on('error', error => finish('failed', error.message));
    timeout = setTimeout(() => finish('failed', 'Queued-edit hold timed out'), run.timeoutMs);
    // The rendered text is the acknowledgement that the release watcher is armed.
    text(run.heldAck);
    check();
  }
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { userAgent: 'queued-edit-fixture' }; break;
      case 'account/read': result = { account: { type: 'apiKey' } }; break;
      case 'model/list': result = { data: [{ id: 'gpt-5.4-mini', displayName: 'E2E Codex' }], nextCursor: null }; break;
      case 'thread/start':
      case 'thread/resume':
        project = request.params?.cwd || project;
        result = { thread: { id: request.params?.threadId || 'queued-edit-thread', turns: [] } };
        break;
      case 'turn/start': {
        const prompt = JSON.stringify(request.params);
        send({ id: request.id, result: { turn: { id: 'queued-edit-turn' } } });
        send({ method: 'turn/started', params: { turn: { id: 'queued-edit-turn' } } });
        if (prompt.includes(run.heldPrompt) && !prompt.includes(run.queuedMarker)) hold();
        else { text(run.queuedReply + done); complete('completed'); }
        return;
      }
      case 'turn/interrupt':
        send({ id: request.id, result: {} });
        finish('interrupted');
        return;
      default:
        send({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method: ' + request.method } });
        return;
    }
    send({ id: request.id, result });
  }).on('close', () => { cleanup(); process.exit(0); });
} else {
  process.stderr.write('Queued-edit agent fixture requires the native app-server transport\\n');
  process.exitCode = 1;
}
`, { flag: 'wx' });
  await writeFile(bin, '@echo off\r\nnode "%~dp0%~n0.cjs" %*\r\n', { flag: 'wx' });
  return { agentId: 'codex', bin, envKey: 'CODEX_BIN', env: { CODEX_BIN: bin } };
}
