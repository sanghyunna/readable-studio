import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { attachPiRpcSession, defaultPiSessionDirectory } from '../../src/pi-rpc.js';

test('local Pi capture uses the CLI default encoded-cwd session directory, not cwd/.pi/sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-session-location-'));
  const cwd = path.join(root, 'project');
  const agentDir = path.join(root, 'direct-pi-home');
  const encoded = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = path.join(agentDir, 'sessions', encoded);
  await mkdir(cwd);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'session.jsonl');
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  try {
    assert.equal(defaultPiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }), sessionDir);
    const events: unknown[] = [];
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess, prompt: 'hello', cwd,
      env: { PI_CODING_AGENT_DIR: agentDir }, send: (_channel, event) => events.push(event),
    });
    child.stdin.read();
    await writeFile(sessionFile, `${JSON.stringify({ type: 'session', version: 3, cwd, id: 'local-pi' })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'agent_end' })}\n${JSON.stringify({ type: 'agent_settled' })}\n`);
    const command = JSON.parse(String(child.stdin.read()).trim());
    assert.equal(command.type, 'get_state');
    const settled = session.waitForQuiescence();
    child.stdout.write(`${JSON.stringify({ type: 'response', command: 'get_state', id: command.id, success: true, data: { sessionFile } })}\n`);
    child.emit('close', 0, null);
    await settled;
    assert.equal(session.hasFatalError(), false, JSON.stringify(events));
    assert.equal(session.getLastSessionPath(), sessionFile);
    assert.equal(defaultPiSessionDirectory(cwd, { PI_CODING_AGENT_SESSION_DIR: root }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
