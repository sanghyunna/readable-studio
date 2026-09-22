import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let server: Server | undefined;
afterEach(async () => {
  if (server) await closeHttpServer(server);
  server = undefined;
  closeDatabase();
});

const peer = `
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'route-thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'route-turn'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'first'}});
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:' second'}});
 }
 if(m.method==='turn/interrupt') {
  send({id:m.id,result:{}});
  send({method:'turn/completed',params:{turn:{status:'interrupted'}}});
 }
}).on('close',()=>process.exit(0));
`;

it('ends SSE with canceled status when canceled after incremental text', async () => {
  // Given a real daemon route and stdio peer that cannot finish without interruption.
  await withFakeAgent('codex', peer, async () => {
    const started = await startServer({ port: 0, returnServer: true,
      isolatedAgentProbe: async () => ({ supported: false, reason: 'Test uses a direct stdio peer' }),
    });
    if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw new Error('Missing server');
    server = started.server;
    const projectId = `stream-${randomUUID()}`;
    const project = await fetch(`${started.url}/api/projects`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({id:projectId,name:'Streaming test'}) }).then(r => r.json());
    if (!project || typeof project !== 'object' || !('conversationId' in project) || typeof project.conversationId !== 'string') throw new Error('Missing conversation');
    const run = await fetch(`${started.url}/api/runs`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({projectId,conversationId:project.conversationId,agentId:'codex',model:'selected-model',message:'test'}) }).then(r => r.json());
    if (!run || typeof run !== 'object' || !('runId' in run) || typeof run.runId !== 'string') throw new Error('Missing run');
    const response = await fetch(`${started.url}/api/runs/${run.runId}/events`, {signal:AbortSignal.timeout(15000)});
    if (!response.body) throw new Error('Missing SSE body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let events = '';
    let cancellation: Promise<Response> | undefined;
    // When the consumer observes live text, cancel without any timing delay.
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      events += decoder.decode(chunk.value, {stream:true});
      if (events.includes('first') && !cancellation) {
        cancellation = fetch(`${started.url}/api/runs/${run.runId}/cancel`, {method:'POST'});
      }
    }
    expect((await cancellation)?.ok).toBe(true);
    const status = await fetch(`${started.url}/api/runs/${run.runId}`).then(r => r.json());
    // Then terminal status is honest and SSE reaches EOF exactly once.
    if (!status || typeof status !== 'object' || !('status' in status)) throw new Error('Missing status');
    expect(status.status).toBe('canceled');
    expect(events.match(/event: end\n/g)).toHaveLength(1);
    expect(events).toContain('first');
    expect(events).not.toContain('event: error\n');
  });
});
