import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { attachAcpSession } from '../src/acp.js';

const SESSION = 'session_f200b5fd-a757-460d-89dd-969036f9c873';
// Sanitized Kimi 0.27.0 session-log format from the diagnosis, including the
// escaped provider error recorded immediately before the empty ACP end_turn.
function fixture(statusCode: number, message: string) {
  const error = JSON.stringify({ code: 'provider.api_error', message: `${statusCode} ${message}`, details: { statusCode }, retryable: false });
  return `2026-10-06T06:26:14.902Z WARN  llm request failed  errorMessage=${JSON.stringify(`${statusCode} ${message}`)} statusCode=${statusCode}\n` +
    `2026-10-06T06:26:14.959Z WARN  acp: turn ended with failed reason  error=${JSON.stringify(error)}\n`;
}
const QUOTA = fixture(403, "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.");
const AUTH = fixture(401, 'Invalid API key sk-secret12345678901234567890 for account owner@example.com');

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill() { this.killed = true; return true; }
}
function result(child: Child, id: number, value: unknown) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
}
function exercise(log: string | null, nativeExit: false | 'before' | 'after' = false, sessionId = SESSION, output = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-kimi-'));
  try {
    const logs = path.join(home, '.kimi-code', 'sessions', 'wd_project_123456789012', SESSION, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    if (log !== null) fs.writeFileSync(path.join(logs, 'kimi-code.log'), log);
    const child = new Child();
    const errors: Array<{ message: string; error: { code: string; details?: Record<string, unknown> } }> = [];
    const session = attachAcpSession({
      child: child as never, prompt: 'hello', rejectEmptyPromptCompletion: true,
      env: { USERPROFILE: home, HOME: home },
      send: (event, payload) => { if (event === 'error') errors.push(payload as typeof errors[number]); },
    });
    result(child, 1, {});
    result(child, 2, { sessionId });
    if (output) child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } })}\n`);
    if (nativeExit !== 'before') result(child, 3, { stopReason: 'end_turn' });
    child.emit('close', nativeExit ? 0xc0000409 : 0, null);
    return { errors, fatal: session.hasFatalError(), succeeded: session.completedSuccessfully() };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('Kimi empty turn recovers quota 403 from its session log', () => {
  const { errors, fatal, succeeded } = exercise(QUOTA);
  assert.equal(fatal, true);
  assert.equal(succeeded, false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'RATE_LIMITED');
  assert.equal(errors[0].error.details?.statusCode, 403);
  assert.equal(errors[0].error.details?.reset, 'current 7-day window ends');
});
test('Kimi empty turn recovers auth 401 without leaking credentials or account', () => {
  const { errors } = exercise(AUTH);
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'AGENT_AUTH_REQUIRED');
  assert.equal(errors[0].error.details?.action, 'login');
  assert.equal(JSON.stringify(errors).includes('sk-secret'), false);
  assert.equal(JSON.stringify(errors).includes('owner@example.com'), false);
});
test('Kimi absent session log retains generic execution failure', () => {
  const { errors } = exercise(null);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'AGENT_EXECUTION_FAILED');
});
test('Kimi native assertion exit before prompt response recovers provider reason', () => {
  const { errors, fatal } = exercise(QUOTA, 'before');
  assert.equal(fatal, true);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'RATE_LIMITED');
});
test('Kimi native assertion after empty end_turn does not replace the provider reason', () => {
  const { errors, fatal } = exercise(QUOTA, 'after');
  assert.equal(fatal, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.error.code, 'RATE_LIMITED');
});
test('Kimi quota reset timestamp is included as safe structured data', () => {
  const { errors } = exercise(fixture(403, 'Usage limit reached. Quota resets at 2026-10-07T00:00:00Z. account=secret'));
  assert.equal(errors[0]?.error.details?.reset, '2026-10-07T00:00:00Z');
  assert.equal(JSON.stringify(errors).includes('secret'), false);
});
test('Kimi forbidden response without quota evidence is not labeled a usage limit', () => {
  const { errors } = exercise(fixture(403, 'Permission denied'));
  assert.equal(errors[0]?.error.code, 'AGENT_EXECUTION_FAILED');
  assert.equal(errors[0]?.error.details?.statusCode, 403);
});
test('Kimi session correlation never borrows another session failure', () => {
  const { errors } = exercise(QUOTA, false, 'session_00000000-0000-4000-8000-000000000000');
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'AGENT_EXECUTION_FAILED');
});
test('Kimi malformed log safely falls back', () => {
  assert.equal(exercise('acp: turn ended with failed reason error="not json"').errors[0]?.error.code, 'AGENT_EXECUTION_FAILED');
});
test('Kimi rejects path traversal session IDs', () => {
  assert.equal(exercise(QUOTA, false, '../' + SESSION).errors[0]?.error.code, 'AGENT_EXECUTION_FAILED');
});
test('Kimi other HTTP errors carry status and a sanitized provider message', () => {
  const { errors } = exercise(fixture(502, 'Bad gateway for account=private-account token=supersecret owner@example.com https://secret.invalid/?key=secret'));
  assert.ok(errors[0]);
  assert.equal(errors[0].error.code, 'AGENT_EXECUTION_FAILED');
  assert.equal(errors[0].error.details?.statusCode, 502);
  for (const secret of ['private-account', 'supersecret', 'owner@example.com', 'secret.invalid']) assert.equal(JSON.stringify(errors).includes(secret), false);
});
test('Kimi last failure wins over earlier retry failures in the same log', () => {
  assert.equal(exercise(AUTH + QUOTA).errors[0]?.error.code, 'RATE_LIMITED');
});
test('Kimi bounded tail reads recover a failure in a large session log', () => {
  assert.equal(exercise('x'.repeat(300_000) + '\n' + QUOTA).errors[0]?.error.code, 'RATE_LIMITED');
});
test('Kimi provider errors are not inferred after a substantive response', () => {
  const { errors, succeeded } = exercise(QUOTA, false, SESSION, true);
  assert.deepEqual(errors, []);
  assert.equal(succeeded, true);
});
