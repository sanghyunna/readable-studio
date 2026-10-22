import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';

type PeerOptions = {
  resumeSessionId?: string;
  refreshAuth?: boolean;
  failure?: 'turn' | 'refresh' | 'missing-account' | 'unmanaged-account' | 'resume' | 'missing-thread';
};

async function runPeer(options: PeerOptions = {}) {
  const fixture = `
const {createInterface}=require('node:readline');
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
const failure=${JSON.stringify(options.failure)};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 process.stderr.write(JSON.stringify(message)+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 if(message.method==='account/read') {
  if(failure==='refresh')send({id:message.id,error:{message:'Token refresh failed: expired refresh token'}});
  else send({id:message.id,result:{account:failure==='missing-account'||failure==='unmanaged-account'?null:{type:'chatgpt'},requiresOpenaiAuth:failure!=='unmanaged-account'}});
 }
 if(message.method==='thread/start'||message.method==='thread/resume') {
  if(failure==='resume')send({id:message.id,error:{message:'Thread could not be resumed'}});
  else send({id:message.id,result:{thread:{id:failure==='missing-thread'?'':message.params.threadId||'saved-thread',turns:[{items:[{id:'old-message',type:'agentMessage',text:'already delivered'},{id:'old-tool',type:'commandExecution',command:'already committed'}]}]}}});
 }
 if(message.method==='turn/start') {
  send({id:message.id,result:{turn:{id:'next-turn'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'next-message',delta:'continued'}});
  if(failure==='turn')send({method:'item/started',params:{item:{id:'new-tool',type:'commandExecution',command:'committed once'}}});
  send({method:'turn/completed',params:{turn:{status:failure==='turn'?'failed':'completed',error:failure==='turn'?{message:'ECONNRESET after tool'}:null}}});
 }
}).on('close',()=>process.exit(0));
`;
  const child = spawn(process.execPath, ['-e', fixture], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  const events: Record<string, unknown>[] = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const session = attachCodexAppServerSession({
    child, prompt: 'Continue the interrupted work.', cwd: process.cwd(), model: 'selected-model',
    ...options, onEvent: event => events.push(event),
  });
  try {
    await closed;
    const requests: { method: string; params: Record<string, unknown> }[] = stderr.trim().split('\n').map(line => JSON.parse(line));
    return { session, requests, events };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

it('persists new threads and retains their authoritative ID after a failed turn with committed work', async () => {
  const { session, requests, events } = await runPeer({ failure: 'turn' });
  expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({ ephemeral: false });
  expect(session.getSessionId()).toBe('saved-thread');
  expect(session.hasFatalError()).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'new-tool' }));
});

it('resumes the saved thread and starts only a continuation without replaying hydrated history', async () => {
  const { session, requests, events } = await runPeer({ resumeSessionId: 'saved-thread' });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
  expect(requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({ threadId: 'saved-thread', model: 'selected-model', cwd: process.cwd(), approvalPolicy: 'never' });
  expect(requests.find(request => request.method === 'turn/start')?.params).toEqual({ threadId: 'saved-thread', input: [{ type: 'text', text: 'Continue the interrupted work.' }] });
  expect(events.filter(event => event.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'continued' }]);
  expect(events.filter(event => event.type === 'tool_use')).toEqual([]);
  expect(session.getSessionId()).toBe('saved-thread');
  expect(session.completedSuccessfully()).toBe(true);
});

it('asks the protocol to refresh managed authentication before resuming', async () => {
  const { session, requests } = await runPeer({ resumeSessionId: 'saved-thread', refreshAuth: true });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read', 'thread/resume', 'turn/start']);
  expect(requests.find(request => request.method === 'account/read')?.params).toEqual({ refreshToken: true });
  expect(session.completedSuccessfully()).toBe(true);
});

it('allows a provider that explicitly requires no managed authentication', async () => {
  const { session, requests } = await runPeer({ refreshAuth: true, failure: 'unmanaged-account' });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start']);
  expect(session.completedSuccessfully()).toBe(true);
});

it.each([
  ['refresh', 'Token refresh failed: expired refresh token'],
  ['missing-account', 'Authentication required'],
] as const)('fails the attempt when proactive authentication reports %s', async (failure, message) => {
  const { session, requests, events } = await runPeer({ resumeSessionId: 'saved-thread', refreshAuth: true, failure });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read']);
  expect(events).toEqual([{ type: 'error', message }]);
  expect(session.getSessionId()).toBeUndefined();
  expect(session.hasFatalError()).toBe(true);
  expect(session.completedSuccessfully()).toBe(false);
});

it('does not create a fresh thread or run the prompt after a rejected resume', async () => {
  const { session, requests, events } = await runPeer({ resumeSessionId: 'saved-thread', failure: 'resume' });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/resume']);
  expect(events).toEqual([{ type: 'error', message: 'Thread could not be resumed' }]);
  expect(session.getSessionId()).toBeUndefined();
  expect(session.hasFatalError()).toBe(true);
});

it('does not expose an empty thread ID as a resumable session', async () => {
  const { session, requests, events } = await runPeer({ failure: 'missing-thread' });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/start']);
  expect(events).toEqual([{ type: 'error', message: 'Missing app-server thread ID' }]);
  expect(session.getSessionId()).toBeUndefined();
  expect(session.hasFatalError()).toBe(true);
});
