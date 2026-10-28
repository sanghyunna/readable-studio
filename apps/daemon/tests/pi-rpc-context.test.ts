import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
import { readContextUsageSnapshot, selectContextUsage } from '../src/context-usage.js';
import { normalizeResource } from '../src/databricks/catalogue.js';
import { servingTask } from '../src/databricks/serving-task.js';
import { attachPiRpcSession } from '../src/pi-rpc.js';
import { getDatabricksContextLimit } from '../src/runtimes/pi-databricks.js';

type Record = { [key: string]: unknown };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(contextLimit?: ReturnType<typeof getDatabricksContextLimit>) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-context-'));
  roots.push(root);
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const sessionFile = path.join(root, 'session.jsonl');
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: 'native-owned', cwd })}\n`);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { child.emit('close', null, 'SIGTERM'); return true; },
  });
  const events: Record[] = [];
  const session = attachPiRpcSession({ child: child as unknown as ChildProcess,
    prompt: 'source', cwd, sessionDir: root, model: 'dbm_canonical', ...(contextLimit ? { contextLimit } : {}),
    send: (_channel, event) => events.push(event) });
  const commands = () => {
    const bytes = child.stdin.read();
    return bytes ? String(bytes).trim().split('\n').map(line => JSON.parse(line) as Record) : [];
  };
  const feed = (...events: Record[]) => child.stdout.write(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  const snapshots = () => events.filter(event => event.type === 'context_usage').map(event => event.snapshot as Record);
  commands();
  return { child, session, events, commands, feed, snapshots, sessionFile };
}

test.each([
  { limit: { tokens: 500_000, source: 'metadata' as const }, expected: 500_000 },
  { limit: { tokens: null, source: 'default' as const }, expected: null },
])('Pi reports occupancy with $limit.source provenance and retains canonical model identity', async ({ limit, expected }) => {
  const f = await fixture(limit);
  f.feed({ type: 'turn_end', message: { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  const stats = f.commands().find(command => command.type === 'get_session_stats');
  assert.ok(stats, 'a completed turn requests current occupancy');
  f.feed({ type: 'agent_end' }, { type: 'agent_settled' });
  const state = f.commands().find(command => command.type === 'get_state');
  assert.ok(state);
  f.feed({ type: 'response', id: stats.id, command: 'get_session_stats', success: true,
    data: { tokens: { total: 9_000_000 }, contextUsage: { tokens: 284_000, contextWindow: 1_000_000 } } });
  assert.equal(f.snapshots().at(-1)?.usedTokens, 284_000);
  assert.equal(f.snapshots().at(-1)?.limitTokens, expected);
  f.feed({ type: 'response', id: state.id, command: 'get_state', success: true,
    data: { sessionFile: f.sessionFile, sessionId: 'native-owned', model: { id: 'provider-alias' } } });
  assert.equal(f.snapshots().at(-1)?.model, 'dbm_canonical');
  assert.equal(f.snapshots().at(-1)?.sessionId, 'native-owned');
  assert.equal(f.snapshots().at(-1)?.state, 'estimated');
  f.child.emit('close', 0, null);
  await f.session.waitForQuiescence();
});

// Unmodified captured Foundation endpoints: prose-advertised windows and endpoints with only a planning default.
const { observedDetails } = JSON.parse(await readFile(new URL('./databricks/fixtures/serving-wire.json', import.meta.url), 'utf8')) as { observedDetails: Record[] };
const capabilities = (metadata: Record) => normalizeResource('test-secret', `dbc_${'a'.repeat(32)}`,
  { kind: 'serving-endpoint', name: String(metadata.name), metadata }).endpoint.capabilities;

test.each([
  { source: 'advertised', piWindow: 128_000, expected: { limitTokens: 128_000, limitSource: 'advertised' } },
  // Pi's models.json carries the 1,000,000 planning fallback here; it must never be displayed.
  { source: 'default', piWindow: 1_000_000, expected: { limitTokens: null, limitSource: 'default' } },
])('a captured Databricks $source endpoint reaches the restored snapshot through Pi', async ({ source, piWindow, expected }) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const endpoint = observedDetails.find(row => servingTask(row) === 'llm/v1/chat' && capabilities(row).limitSources?.contextWindow === source);
  assert.ok(endpoint, `the captured wire has a ${source} chat endpoint`);
  const f = await fixture(getDatabricksContextLimit(capabilities(endpoint)));
  f.feed({ type: 'turn_end', message: { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  const stats = f.commands().find(command => command.type === 'get_session_stats');
  assert.ok(stats);
  f.feed({ type: 'response', id: stats.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 5, contextWindow: piWindow } } });
  const snapshot = readContextUsageSnapshot(f.snapshots().at(-1));
  const restored = selectContextUsage({ projectId: 'p', conversationId: 'c', agentId: 'databricks', model: 'dbm_canonical', runs: [],
    persisted: { id: 'r', agentId: 'databricks', createdAt: 1, events: [{ kind: 'context_usage', snapshot }] } }).snapshot;
  assert.deepEqual({ state: restored.state, usedTokens: restored.usedTokens, limitTokens: restored.limitTokens, limitSource: restored.limitSource },
    { state: 'estimated', usedTokens: 5, ...expected });
  f.session.abort(); f.child.emit('close', 0, null);
});

test('compaction invalidates old estimates and ignores the outstanding pre-compaction response', async () => {
  const f = await fixture();
  f.feed({ type: 'turn_end', message: { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  const old = f.commands().find(command => command.type === 'get_session_stats');
  assert.ok(old);
  f.feed({ type: 'auto_compaction_start' });
  assert.equal(f.snapshots().at(-1)?.reason, 'compacting');
  f.feed({ type: 'auto_compaction_end' });
  assert.equal(f.snapshots().at(-1)?.reason, 'compacted');
  const current = f.commands().find(command => command.type === 'get_session_stats');
  assert.ok(current);
  f.feed({ type: 'response', id: old.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 900, contextWindow: 1000 } } });
  assert.equal(f.snapshots().at(-1)?.usedTokens, null);
  f.feed({ type: 'response', id: current.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 100, contextWindow: 1000 } } });
  assert.equal(f.snapshots().at(-1)?.usedTokens, 100);
  f.session.abort(); f.child.emit('close', 0, null);
});

test('missing occupancy responses do not prevent authoritative session capture or completion', async () => {
  const f = await fixture();
  f.feed({ type: 'agent_end' }, { type: 'agent_settled' });
  const commands = f.commands();
  assert.equal(commands.filter(command => command.type === 'get_session_stats').length, 1);
  const state = commands.find(command => command.type === 'get_state');
  assert.ok(state);
  f.feed({ type: 'response', id: state.id, command: 'get_state', success: true, data: { sessionFile: f.sessionFile } });
  assert.equal(f.child.stdin.writableEnded, true);
  f.child.emit('close', 0, null);
  await f.session.waitForQuiescence();
  assert.equal(f.session.hasFatalError(), false);
});

test('late occupancy after cancellation cannot overwrite the replacement run snapshot', async () => {
  const f = await fixture();
  f.feed({ type: 'turn_end', message: { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  const stats = f.commands().find(command => command.type === 'get_session_stats');
  assert.ok(stats);
  f.session.abort(); f.commands();
  const before = f.events.length;
  f.feed({ type: 'response', id: stats.id, command: 'get_session_stats', success: true,
    data: { contextUsage: { tokens: 100, contextWindow: 1000 } } });
  assert.equal(f.events.length, before);
  f.child.emit('close', 0, null);
});
