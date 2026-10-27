import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { HELD_QUESTION_RUN, type FakeAgentRuntime } from '../fake-agents.ts';

/** Generated CommonJS and cmd files exercise the real external Windows CLI boundary. */
export async function createDirectEditHeldAgent(root: string): Promise<FakeAgentRuntime> {
  if (!isAbsolute(root)) throw new Error('Held agent fixture root must be absolute');
  await mkdir(root, { recursive: true });
  const script = join(root, 'direct-edit-codex.cjs');
  const bin = join(root, 'direct-edit-codex.cmd');
  await writeFile(script, `#!/usr/bin/env node
const { existsSync, readFileSync, watch } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const held = ${JSON.stringify(HELD_QUESTION_RUN)};
if (process.argv.includes('--version')) {
  process.stdout.write('codex-e2e 0.0.0\\n');
} else if (process.argv[2] === 'app-server') {
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const text = delta => send({ method: 'item/agentMessage/delta', params: { itemId: 'held-message', delta } });
  let project = process.env.READABLE_PROJECT_DIR || process.cwd();
  let watcher, timeout, settled = true;
  const cleanup = () => { watcher?.close(); clearTimeout(timeout); watcher = undefined; timeout = undefined; };
  const finish = (status, message) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (status === 'completed') text('\\n<!-- readable:no-document-required reason="question" -->');
    send({ method: 'turn/completed', params: { turn: { id: 'held-turn', status,
      ...(message ? { error: { message } } : {}) } } });
  };
  function startHeldTurn() {
    const release = join(project, held.releaseFile);
    if (existsSync(release)) throw new Error('Held run requires a fresh project release file');
    settled = false;
    function check() {
      if (settled) return;
      try { if (readFileSync(release, 'utf8') === held.releaseToken) finish('completed'); }
      catch (error) { if (error.code !== 'ENOENT') finish('failed', error.message); }
    }
    watcher = watch(project, (_event, filename) => {
      if (filename === null || String(filename) === held.releaseFile) check();
    });
    watcher.on('error', error => finish('failed', error.message));
    timeout = setTimeout(() => finish('failed', 'Held agent release timed out'), held.timeoutMs);
    // The rendered form is the acknowledgement that the release watcher is armed.
    text('<question-form id="' + held.formId + '" title="Held run brief">' + JSON.stringify(held.form) + '</question-form>');
    check();
  }
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { userAgent: 'direct-edit-held-fixture' }; break;
      case 'account/read': result = { account: { type: 'apiKey' } }; break;
      case 'model/list': result = { data: [{ id: 'gpt-5.4-mini', displayName: 'E2E Codex' }], nextCursor: null }; break;
      case 'thread/start':
      case 'thread/resume':
        project = request.params?.cwd || project;
        result = { thread: { id: request.params?.threadId || 'direct-edit-held-thread', turns: [] } };
        break;
      case 'turn/start':
        if (!JSON.stringify(request.params).includes(held.prompt)) throw new Error('Unexpected held agent prompt');
        if (!settled) throw new Error('Held agent turn is already running');
        send({ id: request.id, result: { turn: { id: 'held-turn' } } });
        send({ method: 'turn/started', params: { turn: { id: 'held-turn' } } });
        startHeldTurn();
        return;
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
  process.stderr.write('Held agent fixture requires the native app-server transport\\n');
  process.exitCode = 1;
}
`, { flag: 'wx' });
  await writeFile(bin, '@echo off\r\nnode "%~dp0%~n0.cjs" %*\r\n', { flag: 'wx' });
  return { agentId: 'codex', bin, envKey: 'CODEX_BIN', env: { CODEX_BIN: bin } };
}
