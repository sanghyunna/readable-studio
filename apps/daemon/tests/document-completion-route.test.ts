import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { finalGenReportEvents } from './helpers/final-gen-report-events.js';
import { finalGenReadonlyDeltas } from './helpers/final-gen-readonly-events.js';
vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let server: Server | undefined;
afterEach(async () => { if (server) await closeHttpServer(server); server = undefined; closeDatabase(); });

for (const report of ['report-1', 'report-2', 'read-only'] as const) {
  it(`validates artifact-free success through the shared Claude completion path (${report})`, async () => {
    const text = report === 'read-only'
      ? finalGenReadonlyDeltas.join('') + '\n<!-- readable:no-document-required reason="no-file-changes" -->'
      : finalGenReportEvents[report].flatMap(event => 'type' in event && event.type === 'text_delta' ? [event.delta] : []).join('');
    const peer = `
if(process.argv.includes('--version')){console.log('claude 1.0.0');process.exit(0);}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
 send({type:'assistant',message:{id:'message',role:'assistant',content:[{type:'text',text:${JSON.stringify(text)}}],stop_reason:'end_turn'}});
 send({type:'result',subtype:'success',is_error:false,result:'done',usage:{input_tokens:1,output_tokens:1}});
}).on('close',()=>process.exit(0));`;
    await withFakeAgent('claude', peer, async () => {
      const started = await startServer({ port: 0, returnServer: true, isolatedAgentProbe: async () => ({ supported: false, reason: 'Direct test peer' }) });
      if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw Error('Missing server');
      server = started.server;
      const post = async (route: string, body: unknown): Promise<Record<string, any>> => {
        const r = await fetch(started.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        const j = await r.json() as Record<string, any>; expect(r.ok, JSON.stringify(j)).toBe(true); return j;
      };
      const projectId = 'guard-' + randomUUID();
      const project = await post('/api/projects', { id: projectId, name: 'Missing report', metadata: { kind: 'report' } });
      const run = await post('/api/runs', { projectId, conversationId: project.conversationId, agentId: 'claude', model: 'sonnet', message: report === 'read-only' ? 'Read workspace files. 어떤 파일도 수정하지 마세요.' : 'Make a report' });
      const stream = await fetch(started.url + '/api/runs/' + run.runId + '/events', { signal: AbortSignal.timeout(15000) });
      const events = await stream.text();
      expect(events.match(/event: end\n/g)).toHaveLength(1);
      if (report === 'read-only') {
        expect(events).toContain('"status":"succeeded"');
        expect(events).not.toContain('DOCUMENT_NOT_SAVED');
        expect(events.split('readable:no-document-required').length - 1).toBe(1);
        return;
      }
      expect(events).toContain('"status":"failed"');
      expect(events).toContain('Document generation completed without saving index.html');
      expect(events).toContain('"code":"DOCUMENT_NOT_SAVED"');
      expect(events).toContain('"retryable":true');
      expect(events).not.toContain('AGENT_EXECUTION_FAILED');
      // The original and exactly one corrective attempt both delivered text.
      expect(events.split(text.slice(0, 8)).length - 1).toBe(2);
    });
  });
}

async function runCodexPeer(turnCompleted: string, metadata?: Record<string, unknown>, readOnly = false): Promise<string> {
  const peer = `
if(process.argv.includes('--version')){console.log('codex 1.0.0');process.exit(0);}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let turns=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start'){
  turns++;
  send({id:m.id,result:{turn:{id:'turn-'+turns}}});
  send({method:'item/completed',params:{item:{id:'message-'+turns,type:'agentMessage',text:${readOnly ? `turns===1?${JSON.stringify(finalGenReadonlyDeltas.join(''))}:'<!-- readable:no-document-required reason="no-file-changes" -->'` : "'index.html written'"}}}});
  send(${turnCompleted});
 }
}).on('close',()=>process.exit(0));`;
  let events = '';
  await withFakeAgent('codex', peer, async () => {
    const started = await startServer({ port: 0, returnServer: true, isolatedAgentProbe: async () => ({ supported: false, reason: 'Direct test peer' }) });
    if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw Error('Missing server');
    server = started.server;
    const post = async (route: string, body: unknown): Promise<Record<string, any>> => {
      const r = await fetch(started.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const j = await r.json() as Record<string, any>; expect(r.ok, JSON.stringify(j)).toBe(true); return j;
    };
    const projectId = 'codex-guard-' + randomUUID();
    const project = await post('/api/projects', { id: projectId, name: 'Codex run', ...(metadata ? { metadata } : {}) });
    const run = await post('/api/runs', { projectId, conversationId: project.conversationId, agentId: 'codex', model: 'selected-model', message: readOnly ? 'Read SKILL.md and DESIGN.md if present. 어떤 파일도 수정하지 마세요.' : 'Make a report' });
    const stream = await fetch(started.url + '/api/runs/' + run.runId + '/events', { signal: AbortSignal.timeout(15000) });
    events = await stream.text();
  });
  return events;
}

it('succeeds without a document for the captured read-only sequence and corrective intent signal', async () => {
  const events = await runCodexPeer(`{method:'turn/completed',params:{turn:{status:'completed'}}}`, { kind: 'report', templateRef: { id: 'example-html-ppt-weekly-report' } }, true);
  expect(events).toContain('"status":"succeeded"');
  expect(events).not.toContain('DOCUMENT_NOT_SAVED');
  expect(events.match(/event: end\n/g)).toHaveLength(1);
});

it('reports the Codex in-thread missing-document failure with the dedicated error code', async () => {
  const events = await runCodexPeer(`{method:'turn/completed',params:{turn:{status:'completed'}}}`, { kind: 'report' });
  expect(events).toContain('"status":"failed"');
  expect(events).toContain('"code":"DOCUMENT_NOT_SAVED"');
  expect(events).toContain('"retryable":true');
  expect(events).not.toContain('AGENT_EXECUTION_FAILED');
});

it('keeps other Codex failures on their existing error code', async () => {
  const events = await runCodexPeer(`{method:'turn/completed',params:{turn:{status:'failed',error:{message:'turn exploded'}}}}`, { kind: 'report' });
  expect(events).toContain('turn exploded');
  expect(events).toContain('"code":"AGENT_EXECUTION_FAILED"');
  expect(events).not.toContain('DOCUMENT_NOT_SAVED');
});
