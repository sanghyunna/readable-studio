import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';

const fixture = `
const {createInterface}=require('node:readline');
const send=(message)=>process.stdout.write(JSON.stringify(message)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'message',delta:'hello'}});
  send({method:'item/agentMessage/delta',params:{itemId:'message',delta:' world'}});
 }
 if(m.method==='turn/interrupt') {
  send({id:m.id,result:{}});
  send({method:'turn/completed',params:{turn:{status:'interrupted'}}});
  process.stderr.write('interrupt-received');
 }
 if(m.method==='test/finish') {
  send({method:'item/completed',params:{item:{id:'message',type:'agentMessage',text:'hello world'}}});
  send({method:'turn/completed',params:{turn:{status:m.params.status,error:m.params.status==='failed'?{message:'upstream failed'}:null}}});
 }
}).on('close',()=>process.exit(0));
`;

it('delivers multiple incremental text events before a streamed turn completes', async () => {
  // Given a real stdio peer that withholds completion until the consumer receives deltas.
  const child = spawn(process.execPath, ['-e', fixture], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  const events: Record<string, unknown>[] = [];
  const session = attachCodexAppServerSession({ child, prompt: 'test', cwd: process.cwd(), model: 'selected-model', onEvent(event) {
    events.push(event);
    if (events.filter(e => e.type === 'text_delta').length === 2) {
      expect(session.completedSuccessfully()).toBe(false);
      child.stdin.write(JSON.stringify({method:'test/finish',params:{status:'completed'}})+'\n');
    }
  }});
  // When the protocol turn runs to completion.
  try { await closed; } finally { if (child.exitCode === null) child.kill(); }
  // Then the pipeline received distinct deltas without replaying the completed item.
  expect(events.filter(e => e.type === 'text_delta').map(e => e.delta)).toEqual(['hello', ' world']);
  expect(session.completedSuccessfully()).toBe(true);
  expect(session.hasFatalError()).toBe(false);
  expect(events).toContainEqual({ type: 'status', label: 'thread_started', threadId: 'thread' });
});

it('reports a failed turn as fatal even after assistant text', async () => {
  // Given a peer that emits text then an upstream failure.
  const child = spawn(process.execPath, ['-e', fixture], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  const events: Record<string, unknown>[] = [];
  const session = attachCodexAppServerSession({ child, prompt: 'test', cwd: process.cwd(), model: 'selected-model', onEvent(event) {
    events.push(event);
    if (event.type === 'text_delta' && event.delta === ' world') child.stdin.write(JSON.stringify({method:'test/finish',params:{status:'failed'}})+'\n');
  }});
  // When the failed terminal notification arrives.
  try { await closed; } finally { if (child.exitCode === null) child.kill(); }
  // Then no successful terminal outcome is exposed.
  expect(session.hasFatalError()).toBe(true);
  expect(session.completedSuccessfully()).toBe(false);
  expect(events).toContainEqual({ type: 'error', message: 'upstream failed' });
});

it('interrupts the active turn before closing its owned process when canceled', async () => {
  // Given a real protocol peer with an active turn.
  const child = spawn(process.execPath, ['-e', fixture], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const session = attachCodexAppServerSession({ child, prompt: 'test', cwd: process.cwd(), model: 'selected-model', onEvent(event) {
    // When cancellation is requested during incremental output.
    if (event.type === 'text_delta') session.abort();
  }});
  try { await closed; } finally { if (child.exitCode === null) child.kill(); }
  // Then the interrupt reaches the peer and cancellation is never success/failure.
  expect(stderr).toBe('interrupt-received');
  expect(child.exitCode).toBe(0);
  expect(session.completedSuccessfully()).toBe(false);
  expect(session.hasFatalError()).toBe(false);
});
