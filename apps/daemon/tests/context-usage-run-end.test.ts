import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase, listMessages, openDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { cleanupFakeAgentDir, writeExecutableScript } from './helpers/fake-agent.js';

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));

type Snapshot = { state: string; reason?: string };
const daemonRoot = path.resolve(import.meta.dirname, '..');
const cursorFixture = fileURLToPath(new URL('../../../mocks/fixtures/cursor-agent/thinking-tool-segments.jsonl', import.meta.url));
const codexFixture = fileURLToPath(new URL('../../../mocks/fixtures/context-usage/codex-app-server.jsonl', import.meta.url));

const cursorAgent = `
if (process.argv.includes('--version')) { console.log('cursor-agent 1.0.0'); process.exit(0); }
process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(cursorFixture)}));
`;

// Recorded occupancy, then a compaction with no later measurement before the turn completes.
const codexAppServer = `
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(codexFixture)}));
    send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'done' } });
    send({ method: 'thread/compacted', params: { threadId: 'thread' } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
}).on('close', () => process.exit(0));
`;

// Pi fails the turn (no occupancy request) or, when told to stall, waits for an abort.
const pi = (mode: 'fail' | 'stall') => `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('pi 1.0.0'); process.exit(0); }
if (process.argv.includes('--list-models')) { console.log('provider model context max-out thinking images\\nanthropic claude-sonnet-4-5 200K 64K yes yes'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--mode rpc --model'); process.exit(0); }
const encoded = '--' + process.cwd().replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--';
const sessionDir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', encoded);
const sessionFile = path.join(sessionDir, 'context-session.jsonl');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const settle = () => { send({ type: 'agent_end' }); send({ type: 'agent_settled' }); };
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'prompt') {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'context-session', timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\\n');
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Partial answer.' } });
    if (${JSON.stringify(mode)} === 'fail') {
      send({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'Invalid request: the model rejected the prompt' } });
      send({ type: 'turn_end', message: { stopReason: 'error' } });
      settle();
    }
  } else if (request.type === 'abort') {
    settle();
  } else if (request.type === 'get_state') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile } });
  }
}).on('close', () => process.exit(0));
`;

function runCli(base: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'chat', 'context-usage', ...args, '--daemon-url', base, '--json'],
      { cwd: daemonRoot, timeout: 15_000 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
  });
}

describe('context occupancy at the end of a real daemon run', () => {
  let server: Server;
  let base: string;
  let binDir: string;
  const piDir = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'readable-context-end-'));
    process.env.PI_CODING_AGENT_DIR = path.join(binDir, 'pi-home');
    const started = await startServer({ port: 0, returnServer: true,
      isolatedAgentProbe: async () => ({ supported: false, reason: 'Test uses direct stdio peers' }) }) as { url: string; server: Server };
    server = started.server;
    base = started.url;
  });

  afterAll(async () => {
    await closeHttpServer(server);
    closeDatabase();
    await cleanupFakeAgentDir(binDir);
    if (piDir.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = piDir.PI_CODING_AGENT_DIR;
  });

  async function configure(agentId: string, binKey: string, script: string, model: string) {
    const bin = await writeExecutableScript(binDir, `${agentId}-${randomUUID().slice(0, 8)}`, script);
    const response = await fetch(`${base}/api/app-config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, model, agentCliEnv: { [agentId]: { [binKey]: bin } } }) });
    expect(response.status).toBe(200);
  }

  async function run(agentId: string, model: string, cancelOn?: string) {
    const projectId = `context-end-${randomUUID()}`;
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Context occupancy end state' }) }).then(response => response.json()) as { conversationId: string };
    const conversationId = project.conversationId;
    const assistantMessageId = `assistant_${randomUUID()}`;
    const accepted = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, conversationId, assistantMessageId, agentId, model, message: 'test', clientRequestId: randomUUID() }) });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json() as { runId: string };
    const response = await fetch(`${base}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(15_000) });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    let cancellation: Promise<Response> | undefined;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
      if (cancelOn && !cancellation && stream.includes(cancelOn)) cancellation = fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    }
    await cancellation;
    const status = await fetch(`${base}/api/runs/${runId}`).then(response => response.json()) as { status: string };
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    const message = listMessages(db, conversationId).find(entry => entry.id === assistantMessageId);
    const persisted = ((message?.events ?? []) as { kind?: string; snapshot?: Snapshot }[])
      .filter(event => event.kind === 'context_usage').map(event => event.snapshot!);
    const route = await fetch(`${base}/api/projects/${projectId}/conversations/${conversationId}/context-usage?agentId=${agentId}`)
      .then(response => response.json()) as { snapshot: Snapshot };
    return { projectId, conversationId, status: status.status, stream, persisted, route: route.snapshot };
  }

  it('Cursor never reports occupancy, so the UI route and CLI say not-reported, never refreshing', async () => {
    await configure('cursor-agent', 'CURSOR_AGENT_BIN', cursorAgent, 'auto');
    const result = await run('cursor-agent', 'auto');
    expect(result.status, result.stream).toBe('succeeded');
    expect(result.persisted.map(snapshot => snapshot.reason)).toEqual(['not-reported']);
    expect(result.route).toMatchObject({ state: 'unknown', reason: 'not-reported' });
    const cli = await runCli(base, ['--project', result.projectId, '--conversation', result.conversationId, '--agent', 'cursor-agent', '--model', 'auto']);
    expect(cli.code, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).snapshot).toMatchObject({ state: 'unknown', reason: 'not-reported' });
  });

  it('Codex ending on a compaction marker persists a final not-reported snapshot', async () => {
    await configure('codex', 'CODEX_BIN', codexAppServer, 'fixture-model');
    const result = await run('codex', 'fixture-model');
    expect(result.status, result.stream).toBe('succeeded');
    expect(result.persisted.map(snapshot => snapshot.reason ?? snapshot.state)).toEqual(
      ['run-started', 'measured', 'compacting', 'compacted', 'measured', 'compacted', 'not-reported']);
    expect(result.route).toMatchObject({ state: 'unknown', reason: 'not-reported' });
  });

  it.each([
    { mode: 'fail' as const, expected: 'failed', cancelOn: undefined },
    { mode: 'stall' as const, expected: 'canceled', cancelOn: 'Partial answer.' },
  ])('a Pi turn that ends $expected without occupancy persists a final not-reported snapshot', async ({ mode, expected, cancelOn }) => {
    await configure('pi', 'PI_BIN', pi(mode), 'anthropic/claude-sonnet-4-5');
    const result = await run('pi', 'anthropic/claude-sonnet-4-5', cancelOn);
    expect(result.status, result.stream).toBe(expected);
    expect(result.stream).not.toContain('"label":"retrying"');
    expect(result.persisted.map(snapshot => snapshot.reason)).toEqual(['run-started', 'not-reported']);
    expect(result.route).toMatchObject({ state: 'unknown', reason: 'not-reported' });
  });
});
