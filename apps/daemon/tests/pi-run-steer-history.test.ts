import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ run: 0, hold: false, invalidCapture: false, gateCapture: false, log: '',
  captured: undefined as (() => void) | undefined, releaseCapture: undefined as (() => void) | undefined,
  queued: undefined as (() => void) | undefined }));

vi.mock('../src/agent-session-resume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent-session-resume.js')>();
  return { ...actual, createAgentSessionQueue: () => {
    const queue = actual.createAgentSessionQueue();
    return (conversationId: string, agentId: string, work: () => Promise<unknown>) => {
      fixture.queued?.();
      return queue(conversationId, agentId, work);
    };
  } };
});

vi.mock('../src/pi-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi-rpc.js')>();
  const { createInterface } = await import('node:readline');
  return { ...actual, attachPiRpcSession: (options: Parameters<typeof actual.attachPiRpcSession>[0]) => {
    const reader = createInterface({ input: options.child.stdout! });
    reader.on('line', (line) => {
      if (JSON.parse(line).type === 'fixture_capture_pending') {
        fixture.releaseCapture = () => { options.child.stdin!.write('{"type":"fixture_release_capture"}\n'); };
        fixture.captured?.();
      }
    });
    options.child.once('close', () => reader.close());
    return actual.attachPiRpcSession(options);
  } };
});

vi.mock('../src/databricks/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/databricks/service.js')>();
  const { runtimeServiceFixture } = await import('./databricks/runtime-fixture.js');
  return { ...actual, createDatabricksService: () => runtimeServiceFixture().service };
});

vi.mock('../src/runtimes/pi-databricks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/pi-databricks.js')>();
  return { ...actual, createDatabricksPiRuntime: async (options: { dataRoot: string; sessionKey: string; cwd: string }) => {
    const sessionDir = path.join(options.dataRoot, 'databricks', 'sessions', createHash('sha256').update(options.sessionKey).digest('hex'));
    mkdirSync(sessionDir, { recursive: true });
    return { invocation: { command: process.execPath, args: ['-e', rpcChild], cwd: options.cwd,
      env: { ...process.env, FIXTURE_RUN: String(++fixture.run), FIXTURE_HOLD: fixture.hold ? '1' : '0',
        FIXTURE_INVALID_CAPTURE: fixture.invalidCapture ? '1' : '0', FIXTURE_GATE_CAPTURE: fixture.gateCapture ? '1' : '0',
        FIXTURE_SESSION_DIR: sessionDir, FIXTURE_LOG: fixture.log },
      packageRoot: options.cwd, entrypoint: process.execPath, agentDir: sessionDir, sessionDir }, close: async () => {} };
  } };
});

import { startServer } from '../src/server.js';
import { closeHttpServer } from '../src/daemon-startup.js';
import { getAgentSessionRecord, listMessages, openDatabase } from '../src/db.js';

const rpcChild = `
const fs = require('node:fs');
const path = require('node:path');
const run = process.env.FIXTURE_RUN;
const root = process.env.FIXTURE_SESSION_DIR;
let file = path.join(root, 'session-' + run + '.jsonl');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const append = value => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
const settle = () => { send({type:'agent_end'}); send({type:'agent_settled'}); };
let stateRequest;
const capture = request => send({type:'response',id:request.id,command:'get_state',success:true,
  data:{sessionFile:process.env.FIXTURE_INVALID_CAPTURE === '1' ? path.join(root,'..','unowned.jsonl') : file}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.type === 'switch_session') file = request.sessionPath;
 fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({run, ...request, file,
   nativeHistory: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}) + '\\n');
 if (request.type === 'switch_session') send({type:'response',id:request.id,command:request.type,success:true});
 else if (request.type === 'prompt') {
   if (!fs.existsSync(file)) append({type:'session',version:3,id:'native-' + run,cwd:process.cwd(),timestamp:'2026-10-26T00:00:00Z'});
   append({type:'message',message:{role:'user',content:request.message}});
   append({type:'message',message:{role:'assistant',content:'PowerShell was garbled. Use UTF-8 read.'}});
   append({type:'message',message:{role:'toolResult',toolCallId:'read-' + run,content:'READ_UTF8_SUCCESS_' + run}});
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PowerShell was garbled. Use UTF-8 read.'}});
   send({type:'tool_execution_start',toolCallId:'read-' + run,toolName:'read',args:{path:'source.md'}});
   send({type:'tool_execution_end',toolCallId:'read-' + run,result:{content:[{type:'text',text:'READ_UTF8_SUCCESS_' + run}]},isError:false});
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'\\n<!-- readable:no-document-required reason="question" -->'}});
   if (process.env.FIXTURE_HOLD !== '1') {
     send({type:'turn_end',message:{stopReason:'stop',content:[{type:'text',text:'Done'}],usage:{input:1,output:1}}});
     settle();
   }
 } else if (request.type === 'abort') settle();
 else if (request.type === 'get_session_stats') send({type:'response',id:request.id,command:request.type,success:true,data:{contextUsage:{tokens:12,contextWindow:128000,percent:0.01}}});
 else if (request.type === 'get_state') {
   stateRequest = request;
   if (process.env.FIXTURE_GATE_CAPTURE === '1') send({type:'fixture_capture_pending'});
   else capture(request);
 } else if (request.type === 'fixture_release_capture') capture(stateRequest);
}).on('close', () => process.exit(0));
`;

type Started = { url: string; server: Server; shutdown: () => Promise<void> };
type Command = { run: string; type: string; message?: string; file: string; nativeHistory: string };
let started: Started | undefined;
let temp: string | undefined;

afterEach(async () => {
  fixture.releaseCapture?.();
  fixture.releaseCapture = undefined;
  fixture.captured = undefined;
  fixture.queued = undefined;
  await started?.shutdown();
  if (started) await closeHttpServer(started.server);
  started = undefined;
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = undefined;
});

async function post(route: string, body: unknown = {}) {
  return fetch(`${started!.url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function prepare() {
  fixture.run = 0;
  fixture.invalidCapture = false;
  fixture.gateCapture = false;
  temp = await mkdtemp(path.join(os.tmpdir(), 'pi-steer-history-'));
  fixture.log = path.join(temp, 'commands.jsonl');
  started = await startServer({ port: 0, returnServer: true }) as Started;
  const created = await post('/api/projects', { id: `steer-${path.basename(temp)}`, name: 'Steer', skipDiscoveryBrief: true });
  expect(created.status).toBe(200);
  const { conversationId } = await created.json() as { conversationId: string };
  return { projectId: `steer-${path.basename(temp)}`, conversationId,
    db: openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! }) };
}

async function turn(owner: { projectId: string; conversationId: string }, index: number, cancel: boolean) {
  fixture.hold = cancel;
  const currentPrompt = index === 0 ? 'Make a deck from the attached MD and ZIP.' : `Steer ${index}: revise the deck.`;
  const accepted = await post('/api/runs', { ...owner, agentId: 'databricks', model: 'dbm_opaque_model', reasoning: 'high',
    message: index ? `## user\nOriginal deck request\n\n## assistant\nPowerShell was garbled. Use UTF-8 read.\n\n## user\n${currentPrompt}` : currentPrompt,
    currentPrompt });
  expect(accepted.status, await accepted.clone().text()).toBe(202);
  const { runId } = await accepted.json() as { runId: string };
  const stream = await fetch(`${started!.url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(10_000) });
  const reader = stream.body!.getReader();
  let output = '';
  let canceled = false;
  const decoder = new TextDecoder();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    output += decoder.decode(part.value, { stream: true });
    if (cancel && !canceled && output.includes('READ_UTF8_SUCCESS_')) {
      canceled = true;
      expect((await post(`/api/runs/${runId}/cancel`)).status).toBe(200);
    }
  }
  const status = await fetch(`${started!.url}/api/runs/${runId}`).then(response => response.json()) as { status: string };
  expect(status.status, output).toBe(cancel ? 'canceled' : 'succeeded');
  const commands = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Command);
  return commands.filter(command => command.run === String(fixture.run));
}

test.each([false, true])('steering twice preserves completed reads when initial success is %s', async (initialSuccess) => {
  const owner = await prepare();
  const snapshots = [];
  for (let index = 0; index < 3; index++) {
    const commands = await turn(owner, index, index === 0 ? !initialSuccess : index === 1);
    snapshots.push({ commands, record: getAgentSessionRecord(owner.db, owner.conversationId, 'databricks') });
  }
  expect(snapshots.map(snapshot => snapshot.record?.sessionId)).toEqual(['session-1.jsonl', 'session-1.jsonl', 'session-1.jsonl']);
  for (const snapshot of snapshots.slice(1)) {
    expect(snapshot.commands[0]?.type).toBe('switch_session');
    expect(snapshot.commands.find(command => command.type === 'prompt')?.nativeHistory).toContain('READ_UTF8_SUCCESS_1');
  }
  expect(snapshots[2]!.commands.find(command => command.type === 'prompt')?.nativeHistory).toContain('READ_UTF8_SUCCESS_2');
  const contextResponse = await fetch(`${started!.url}/api/projects/${owner.projectId}/conversations/${owner.conversationId}/context-usage?agentId=databricks&model=dbm_opaque_model`);
  expect(contextResponse.status).toBe(200);
  expect(await contextResponse.json()).toMatchObject({ snapshot: { source: 'pi', state: 'estimated',
    usedTokens: 12, limitTokens: 128_000, model: 'dbm_opaque_model' } });
  const assistant = listMessages(owner.db, owner.conversationId).filter(message => message.role === 'assistant').at(-1);
  expect(assistant?.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'context_usage',
    snapshot: expect.objectContaining({ state: 'estimated', usedTokens: 12 }) })]));
});

test('cancellation with an invalid session capture preserves the previous owned session reference', async () => {
  const owner = await prepare();
  await turn(owner, 0, false);
  const saved = getAgentSessionRecord(owner.db, owner.conversationId, 'databricks');
  fixture.invalidCapture = true;
  await turn(owner, 1, true);
  expect(getAgentSessionRecord(owner.db, owner.conversationId, 'databricks')).toEqual(saved);
});

test('a replacement run waits for the canceled child to capture its native session', async () => {
  const owner = await prepare();
  fixture.gateCapture = true;
  const pendingCapture = new Promise<void>((resolve) => { fixture.captured = resolve; });
  const canceled = turn(owner, 0, true);
  await pendingCapture;
  expect(getAgentSessionRecord(owner.db, owner.conversationId, 'databricks')).toBeNull();
  fixture.gateCapture = false;
  let acknowledgeQueued!: () => void;
  const queued = new Promise<void>((resolve) => { acknowledgeQueued = resolve; });
  fixture.queued = acknowledgeQueued;
  const replacement = turn(owner, 1, false);
  await queued;
  expect(fixture.run).toBe(1);
  fixture.releaseCapture!();
  await canceled;
  const commands = await replacement;
  expect(commands[0]?.type).toBe('switch_session');
  expect(commands.find(command => command.type === 'prompt')?.nativeHistory).toContain('READ_UTF8_SUCCESS_1');
});
