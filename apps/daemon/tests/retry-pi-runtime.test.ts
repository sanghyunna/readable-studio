import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import { listConversations, listMessages, openDatabase, upsertMessage } from '../src/db.js';
import { cleanupFakeAgentDir, writeExecutableScript } from './helpers/fake-agent.js';

const retry = vi.hoisted(() => ({
  delay: vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(),
  onCommitted: undefined as (() => void) | undefined,
}));

vi.mock('../src/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runs.js')>();
  return {
    ...actual,
    createChatRunService: (options: Parameters<typeof actual.createChatRunService>[0]) =>
      actual.createChatRunService({ ...options, retryDelay: retry.delay }),
  };
});

vi.mock('../src/pi-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi-rpc.js')>();
  return {
    ...actual,
    attachPiRpcSession: (options: Parameters<typeof actual.attachPiRpcSession>[0]) =>
      actual.attachPiRpcSession({ ...options, send(channel, payload) {
        options.send(channel, payload);
        if (payload.type === 'tool_result' && payload.toolUseId === 'committed-tool') retry.onCommitted?.();
      } }),
  };
});

type Started = { url: string; server: Server; shutdown: () => Promise<void> };
type Event = { event: string; data: Record<string, unknown> };
type Request = { attempt: number; type: string; message?: string; sessionPath?: string; sessionFile: string };

describe('local Pi same-run recovery', () => {
  let started: Started | undefined;
  let binDir: string | undefined;
  const envKeys = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'READABLE_CHAT_RUN_INACTIVITY_TIMEOUT_MS'] as const;
  let originalEnv: (string | undefined)[];

  beforeEach(() => {
    originalEnv = envKeys.map(key => process.env[key]);
    retry.delay.mockReset().mockResolvedValue(undefined);
    retry.onCommitted = undefined;
  });
  afterEach(async () => {
    retry.onCommitted = undefined;
    vi.restoreAllMocks();
    await started?.shutdown();
    if (started) await closeHttpServer(started.server);
    started = undefined;
    if (binDir) await cleanupFakeAgentDir(binDir);
    binDir = undefined;
    envKeys.forEach((key, index) => {
      if (originalEnv[index] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[index];
    });
  });

  async function prepare(stall: boolean) {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'readable-pi-retry-'));
    process.env.PI_CODING_AGENT_DIR = path.join(binDir, 'pi-home');
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const counter = path.join(binDir, 'attempts');
    const requestsPath = path.join(binDir, 'requests.jsonl');
    const bin = await writeExecutableScript(binDir, 'pi-retry', `
const fs=require('node:fs');
const path=require('node:path');
if(process.argv.includes('--version')){console.log('pi 1.0.0');process.exit(0);}
if(process.argv.includes('--list-models')){console.log('provider model context max-out thinking images\\nanthropic claude-sonnet-4-5 200K 64K yes yes');process.exit(0);}
if(process.argv.includes('--help')){console.log('--mode rpc --model');process.exit(0);}
let previous=0;
try{previous=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'));}catch{}
const attempt=previous+1;
const encoded='--'+process.cwd().replace(/^[/\\\\]/,'').replace(/[/\\\\:]/g,'-')+'--';
const sessionDir=path.join(process.env.PI_CODING_AGENT_DIR,'sessions',encoded);
const sessionFile=path.join(sessionDir,'retry-session.jsonl');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const settle=()=>{send({type:'agent_end'});send({type:'agent_settled'});};
let resumed=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(requestsPath)},JSON.stringify({attempt,...request,sessionFile})+'\\n');
 if(request.type==='switch_session'){
  if(request.sessionPath!==sessionFile)throw new Error('Pi retry did not resume the owned session');
  resumed=true;
  send({type:'response',id:request.id,command:request.type,success:true});
 }else if(request.type==='prompt'){
  if(attempt>1&&!resumed)throw new Error('Committed work must not run in a fresh session');
  fs.writeFileSync(${JSON.stringify(counter)},String(attempt));
  fs.mkdirSync(sessionDir,{recursive:true});
  fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:'retry-session',timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n');
  if(attempt===1){
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Partial answer.'}});
   send({type:'tool_execution_start',toolCallId:'committed-tool',toolName:'write',args:{path:'notes.txt',content:'done'}});
   fs.writeFileSync(path.join(process.cwd(),'notes.txt'),'done');
   send({type:'tool_execution_end',toolCallId:'committed-tool',result:{content:[{type:'text',text:'saved once'}]},isError:false});
   if(!${stall}){
    send({type:'message_update',assistantMessageEvent:{type:'error',reason:'ECONNRESET while streaming'}});
    settle();
   }
  }else{
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Recovered.\\n<!-- readable:no-document-required reason="question" -->'}});
   send({type:'turn_end',message:{stopReason:'stop',usage:{input:1,output:1,totalTokens:2}}});
   settle();
  }
 }else if(request.type==='abort'){
  settle();
 }else if(request.type==='get_state'){
  send({type:'response',id:request.id,command:request.type,success:true,data:{sessionFile}});
 }
}).on('close',()=>process.exit(0));
`);
    if (stall) process.env.READABLE_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '400';
    started = await startServer({ port: 0, returnServer: true }) as Started;
    const configured = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'pi', model: 'anthropic/claude-sonnet-4-5', agentCliEnv: { pi: { PI_BIN: bin } } }),
    });
    expect(configured.status).toBe(200);
    return { counter, requestsPath };
  }

  async function launchAndFinish() {
    const projectId = `retry_pi_${randomUUID()}`;
    const created = await fetch(`${started!.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Pi retry', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    const message = 'Answer a question and preserve the existing notes.';
    upsertMessage(db, conversationId, { id: `user_${randomUUID()}`, role: 'user', content: message });
    const assistantMessageId = `assistant_${randomUUID()}`;
    const accepted = await fetch(`${started!.url}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, conversationId, assistantMessageId, agentId: 'pi',
        model: 'anthropic/claude-sonnet-4-5', message, currentPrompt: message, clientRequestId: randomUUID() }),
    });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json() as { runId: string };
    const stream = await fetch(`${started!.url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(15_000) }).then(response => response.text());
    const status = await fetch(`${started!.url}/api/runs/${runId}`).then(response => response.json()) as { id: string; status: string; assistantMessageId: string; conversationId: string; error: string | null };
    const events = stream.split(/\r?\n\r?\n/).flatMap((frame): Event[] => {
      const event = /^event: ?(.+)$/m.exec(frame)?.[1];
      const data = /^data: ?(.+)$/m.exec(frame)?.[1];
      return event && data ? [{ event, data: JSON.parse(data) }] : [];
    });
    expect(status, JSON.stringify(events)).toMatchObject({ id: runId, status: 'succeeded', assistantMessageId, conversationId, error: null });
    expect(retry.delay.mock.calls.map(([ms]) => ms)).toEqual([5000]);
    expect(events.filter(event => event.event === 'error')).toHaveLength(0);
    expect(events.filter(event => event.event === 'end')).toHaveLength(1);
    expect(events.filter(event => event.data.type === 'tool_use')).toHaveLength(1);
    const expectedText = 'Partial answer.Recovered.\n<!-- readable:no-document-required reason="question" -->';
    expect(events.filter(event => event.data.type === 'text_delta').map(event => event.data.delta).join('')).toBe(expectedText);
    expect(listConversations(db, projectId)).toHaveLength(1);
    const messages = listMessages(db, conversationId);
    expect(messages.filter(entry => entry.role === 'assistant')).toHaveLength(1);
    expect(messages.filter(entry => entry.role === 'user')).toHaveLength(1);
    expect(messages.find(entry => entry.id === assistantMessageId)?.content).toBe(expectedText);
    return events;
  }

  async function assertNativeResume(counter: string, requestsPath: string, stalled: boolean) {
    expect(await readFile(counter, 'utf8')).toBe('2');
    const requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Request);
    expect(requests.filter(request => request.attempt === 1).map(request => request.type)).toEqual(stalled ? ['prompt', 'abort', 'get_state'] : ['prompt', 'get_state']);
    expect(requests.filter(request => request.attempt === 2).map(request => request.type)).toEqual(['switch_session', 'prompt', 'get_session_stats', 'get_state']);
    const resumed = requests.find(request => request.type === 'switch_session')!;
    expect(resumed.sessionPath).toBe(resumed.sessionFile);
    expect(requests.find(request => request.attempt === 2 && request.type === 'prompt')?.message).toContain('Continue the interrupted response');
  }

  it('resumes captured native Pi state after partial output and a committed tool fail transiently', async () => {
    const { counter, requestsPath } = await prepare(false);
    await launchAndFinish();
    await assertNativeResume(counter, requestsPath, false);
  });

  it('settles and captures committed Pi work before retrying an inactivity timeout', async () => {
    const { counter, requestsPath } = await prepare(true);
    let expireWatchdog: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (callback.name === 'failForInactivity' && ms === 400) {
        expireWatchdog = () => callback(...args);
        return { unref() { return this; } } as NodeJS.Timeout;
      }
      return realSetTimeout(callback, ms, ...args);
    });
    retry.onCommitted = () => queueMicrotask(() => {
      expect(expireWatchdog).toBeDefined();
      expireWatchdog!();
    });
    await launchAndFinish();
    await assertNativeResume(counter, requestsPath, true);
  });
});
