import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import type { spawnIsolatedAgent } from '@readable-studio/platform';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeHttpServer } from '../src/daemon-startup.js';
import { listConversations, listMessages, openDatabase, upsertMessage } from '../src/db.js';
import { startServer } from '../src/server.js';
import { cleanupFakeAgentDir, writeExecutableScript } from './helpers/fake-agent.js';

const retryClock = vi.hoisted(() => ({
  delay: vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(),
}));

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
vi.mock('../src/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runs.js')>();
  return {
    ...actual,
    createChatRunService: (options: Parameters<typeof actual.createChatRunService>[0]) =>
      actual.createChatRunService({ ...options, retryDelay: retryClock.delay }),
  };
});

type Started = { url: string; server: Server; shutdown: () => Promise<void> };
type Event = { event: string; data: Record<string, unknown> };
type Status = { id: string; status: string; assistantMessageId: string; conversationId: string; error: string | null };
type Request = { attempt: number; method: string; params: Record<string, unknown> };
type Run = { runId: string; projectId: string; conversationId: string; assistantMessageId: string };

describe('provider retries after one-shot Codex isolation recovery', () => {
  let started: Started | undefined;
  let binDir: string | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.READABLE_DESKTOP_APPROVAL_TOKEN;
    process.env.READABLE_DESKTOP_APPROVAL_TOKEN = 'desktop-isolation-retry-test';
    retryClock.delay.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await started?.shutdown();
    if (started) await closeHttpServer(started.server);
    started = undefined;
    if (binDir) await cleanupFakeAgentDir(binDir);
    binDir = undefined;
    if (originalToken === undefined) delete process.env.READABLE_DESKTOP_APPROVAL_TOKEN;
    else process.env.READABLE_DESKTOP_APPROVAL_TOKEN = originalToken;
  });

  async function prepare(failures = 1, committed = false) {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'readable-isolation-retry-'));
    const counter = path.join(binDir, 'attempts');
    const requestsPath = path.join(binDir, 'requests.jsonl');
    const bin = await writeExecutableScript(binDir, 'codex-isolation-retry', `
const fs=require('node:fs');
const path=require('node:path');
if(process.argv.includes('--version')){console.log('codex 1.0.0');process.exit(0);}
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
let attempt=0;
let threadId='';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize'){
  let previous=0;try{previous=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'));}catch{}
  attempt=previous+1;
  fs.writeFileSync(${JSON.stringify(counter)},String(attempt));
 }
 fs.appendFileSync(${JSON.stringify(requestsPath)},JSON.stringify({attempt,...message})+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 if(message.method==='thread/start'){
  if(${committed}&&attempt>1)throw new Error('Committed tool work must resume its native thread');
  threadId='saved-thread';
  send({id:message.id,result:{thread:{id:threadId}}});
 }
 if(message.method==='thread/resume'){
  if(message.params.threadId!=='saved-thread')throw new Error('Wrong retry thread');
  threadId=message.params.threadId;
  send({id:message.id,result:{thread:{id:threadId,turns:[{items:[{id:'committed-tool',type:'commandExecution',command:'already written'}]}]}}});
 }
 if(message.method==='turn/start'){
  send({id:message.id,result:{turn:{id:'turn-'+attempt}}});
  if(attempt<=${failures}){
   if(${committed}){
    send({method:'item/agentMessage/delta',params:{itemId:'partial',delta:'Partial answer.\\nThe completed action remains saved.\\n'}});
    send({method:'item/started',params:{item:{id:'committed-tool',type:'commandExecution',command:'write notes.txt'}}});
    fs.appendFileSync(path.join(process.cwd(),'notes.txt'),'saved once\\n');
    send({method:'item/completed',params:{item:{id:'committed-tool',type:'commandExecution',aggregatedOutput:'saved once',exitCode:0,status:'completed'}}});
   }
   send({method:'turn/completed',params:{turn:{status:'failed',error:{message:${JSON.stringify(committed ? 'ECONNRESET while streaming after committed work' : 'HTTP 503 Service Unavailable')}}}}});
  }else{
   send({method:'item/agentMessage/delta',params:{itemId:'recovered',delta:'Recovered.\\n<!-- readable:no-document-required reason="question" -->'}});
   send({method:'turn/completed',params:{turn:{status:'completed'}}});
  }
 }
}).on('close',()=>process.exit(0));
`);
    const isolatedAgentSpawn = vi.fn<typeof spawnIsolatedAgent>(async () => {
      throw new Error('Windows AppContainer helper did not become ready');
    });
    started = await startServer({
      port: 0, returnServer: true, isolatedAgentSpawn,
      isolatedAgentProbe: async () => ({ supported: true, capabilities: {
        appContainer: true, filesystemAcl: true, internetClient: true, killOnJobClose: true, loopbackDenied: true,
      } }),
    }) as Started;
    const configured = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'codex', model: 'gpt-5.4', agentCliEnv: { codex: { CODEX_BIN: bin } } }),
    });
    expect(configured.status).toBe(200);
    return { counter, requestsPath, isolatedAgentSpawn };
  }

  async function launch(): Promise<Run> {
    const projectId = `isolation_retry_${randomUUID()}`;
    const created = await fetch(`${started!.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Isolation retry', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    const message = 'Answer the question and preserve completed actions.';
    upsertMessage(db, conversationId, { id: `user_${randomUUID()}`, role: 'user', content: message });
    const assistantMessageId = `assistant_${randomUUID()}`;
    const accepted = await fetch(`${started!.url}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, conversationId, assistantMessageId, agentId: 'codex', model: 'gpt-5.4',
        message, currentPrompt: message, clientRequestId: randomUUID() }),
    });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json() as { runId: string };
    return { runId, projectId, conversationId, assistantMessageId };
  }

  async function finish(run: Run) {
    const stream = await fetch(`${started!.url}/api/runs/${run.runId}/events`, { signal: AbortSignal.timeout(15_000) }).then(response => response.text());
    const events = stream.split(/\r?\n\r?\n/).flatMap((frame): Event[] => {
      const event = /^event: ?(.+)$/m.exec(frame)?.[1];
      const data = /^data: ?(.+)$/m.exec(frame)?.[1];
      return event && data ? [{ event, data: JSON.parse(data) }] : [];
    });
    const status = await fetch(`${started!.url}/api/runs/${run.runId}`).then(response => response.json()) as Status;
    expect(status).toMatchObject({ id: run.runId, assistantMessageId: run.assistantMessageId, conversationId: run.conversationId });
    expect(events.filter(event => event.event === 'end')).toHaveLength(1);
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    expect(listConversations(db, run.projectId)).toHaveLength(1);
    const messages = listMessages(db, run.conversationId);
    expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
    return { status, events, messages };
  }

  it('cancels isolated preparation and terminates a child returned after cancellation', async () => {
    const { isolatedAgentSpawn } = await prepare();
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let startedSpawn: (signal: AbortSignal | undefined) => void = () => {};
    const pendingSpawn = new Promise<AbortSignal | undefined>(resolve => { startedSpawn = resolve; });
    let lateClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { lateClosed = resolve; });
    let latePid: number | undefined;
    isolatedAgentSpawn.mockImplementationOnce(async options => {
      startedSpawn(options.signal);
      await held;
      const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe', windowsHide: true });
      latePid = child.pid;
      child.once('close', lateClosed);
      return child;
    });
    const run = await launch();
    try {
      const signal = await pendingSpawn;
      const response = await fetch(`${started!.url}/api/runs/${run.runId}/cancel`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(signal?.aborted).toBe(true);
      release();
      await closed;
      expect(latePid).toBeDefined();
      expect(() => process.kill(latePid!, 0)).toThrow();
      const status = await fetch(`${started!.url}/api/runs/${run.runId}`).then(response => response.json()) as Status;
      expect(status.status).toBe('canceled');
      expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
    } finally { release(); }
  });

  it.each([false, true])('joins isolated preparation cleanup during daemon shutdown (already canceled: %s)', async (alreadyCanceled) => {
    const { isolatedAgentSpawn } = await prepare();
    let release!: () => void;
    const cleanupHeld = new Promise<void>(resolve => { release = resolve; });
    let entered!: (signal: AbortSignal | undefined) => void;
    const preparing = new Promise<AbortSignal | undefined>(resolve => { entered = resolve; });
    const cleaned = vi.fn();
    isolatedAgentSpawn.mockImplementationOnce(async options => {
      entered(options.signal);
      await cleanupHeld;
      cleaned();
      throw new DOMException('Isolated helper cleanup completed', 'AbortError');
    });
    const run = await launch();
    const signal = await preparing;
    if (alreadyCanceled) {
      const response = await fetch(`${started!.url}/api/runs/${run.runId}/cancel`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(signal?.aborted).toBe(true);
      expect(cleaned).not.toHaveBeenCalled();
    }
    const shutdown = started!.shutdown();
    try {
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(await Promise.race([
        shutdown.then(() => 'shutdown'),
        new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 50)),
      ])).toBe('waiting');
      expect(cleaned).not.toHaveBeenCalled();
    } finally {
      release();
      await shutdown;
    }
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('recovers a provider failure after fallback (committed work: %s)', async (committed) => {
    const { counter, requestsPath, isolatedAgentSpawn } = await prepare(1, committed);
    const run = await launch();
    const { status, events, messages } = await finish(run);
    expect(status, JSON.stringify(events)).toMatchObject({ status: 'succeeded', error: null });
    expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect(retryClock.delay.mock.calls.map(([ms]) => ms)).toEqual([5000]);
    expect(events.filter(event => event.event === 'error')).toHaveLength(0);
    const expectedText = (committed ? 'Partial answer.\nThe completed action remains saved.\n' : '') + 'Recovered.\n<!-- readable:no-document-required reason="question" -->';
    expect(events.filter(event => event.data.type === 'text_delta').map(event => event.data.delta).join('')).toBe(expectedText);
    expect(messages.find(message => message.id === run.assistantMessageId)?.content).toBe(expectedText);
    const requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Request);
    expect(requests.filter(request => request.attempt === 2).map(request => request.method))
      .toEqual(['initialize', 'initialized', committed ? 'thread/resume' : 'thread/start', 'turn/start']);
    expect(events.filter(event => event.data.type === 'tool_use')).toHaveLength(committed ? 1 : 0);
    if (committed) {
      expect(requests.find(request => request.method === 'thread/resume')?.params.threadId).toBe('saved-thread');
      const cwd = String(requests.find(request => request.method === 'thread/start')!.params.cwd);
      expect(await readFile(path.join(cwd, 'notes.txt'), 'utf8')).toBe('saved once\n');
    }
  });

  it('cancels during the post-fallback retry wait without another provider or isolation attempt', async () => {
    const { counter, isolatedAgentSpawn } = await prepare(11);
    let signal: AbortSignal | undefined;
    let enterWait!: () => void;
    const waiting = new Promise<'waiting'>(resolve => { enterWait = () => resolve('waiting'); });
    retryClock.delay.mockImplementation((_ms, retrySignal) => {
      signal = retrySignal;
      enterWait();
      return new Promise<void>((_resolve, reject) => retrySignal.addEventListener('abort', () => reject(retrySignal.reason), { once: true }));
    });
    const run = await launch();
    const completed = finish(run);
    expect(await Promise.race([waiting, completed.then(() => 'finished')])).toBe('waiting');
    const canceled = await fetch(`${started!.url}/api/runs/${run.runId}/cancel`, { method: 'POST' });
    expect(canceled.status).toBe(200);
    const { status, events } = await completed;
    expect(status.status).toBe('canceled');
    expect(signal?.aborted).toBe(true);
    expect(await readFile(counter, 'utf8')).toBe('1');
    expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
    expect(retryClock.delay.mock.calls.map(([ms]) => ms)).toEqual([5000]);
    expect(events.filter(event => event.event === 'error')).toHaveLength(0);
  });

  it('keeps the ten-retry provider budget after recovering isolation once', async () => {
    const { counter, isolatedAgentSpawn } = await prepare(11);
    const { status, events } = await finish(await launch());
    expect(status.status).toBe('failed');
    expect(await readFile(counter, 'utf8')).toBe('11');
    expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
    expect(retryClock.delay.mock.calls.map(([ms]) => ms)).toEqual(Array(10).fill(5000));
    expect(events.filter(event => event.event === 'error')).toHaveLength(1);
    expect(events.filter(event => event.data.label === 'retrying')).toHaveLength(10);
  });
});
