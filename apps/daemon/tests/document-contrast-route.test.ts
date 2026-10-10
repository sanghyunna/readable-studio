import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { finalGenContrastHtml } from './helpers/final-gen-contrast-html.js';
vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let server: Server | undefined;
afterEach(async () => { if (server) await closeHttpServer(server); server = undefined; closeDatabase(); });

for (const corrected of [true, false]) {
  it(`completes after exactly one contrast corrective turn (corrected=${corrected})`, async () => {
    const warning = vi.spyOn(console, 'warn');
    const initial = finalGenContrastHtml['weekly-1-index.html.log']!;
    const fixed = initial.replace('.value{', '.value{color:var(--ink);');
    const peer = `
if(process.argv.includes('--version')){console.log('claude 1.0.0');process.exit(0);}
const fs=require('node:fs'),send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
 const second=fs.existsSync('index.html');
 fs.writeFileSync('index.html',second&&${corrected}?${JSON.stringify(fixed)}:${JSON.stringify(initial)},'utf8');
 const text=second?'contrast-recovery-completed':'initial-document-saved';
 send({type:'assistant',message:{id:'message',role:'assistant',content:[{type:'text',text}],stop_reason:'end_turn'}});
 send({type:'result',subtype:'success',is_error:false,result:text,usage:{input_tokens:1,output_tokens:1}});
}).on('close',()=>process.exit(0));`;
    try {
      await withFakeAgent('claude', peer, async () => {
        const started = await startServer({ port: 0, returnServer: true, isolatedAgentProbe: async () => ({ supported: false, reason: 'Direct test peer' }) });
        if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw Error('Missing server');
        server = started.server;
        const post = async (route: string, body: unknown): Promise<Record<string, any>> => {
          const r = await fetch(started.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
          const j = await r.json() as Record<string, any>; expect(r.ok, JSON.stringify(j)).toBe(true); return j;
        };
        const projectId = 'contrast-' + randomUUID();
        const project = await post('/api/projects', { id: projectId, name: 'Contrast report', metadata: { kind: 'report' } });
        const run = await post('/api/runs', { projectId, conversationId: project.conversationId, agentId: 'claude', model: 'sonnet', message: 'Make a library reading club report' });
        const stream = await fetch(started.url + '/api/runs/' + run.runId + '/events', { signal: AbortSignal.timeout(20000) });
        const events = await stream.text();
        expect(events.match(/event: end\n/g)).toHaveLength(1);
        expect(events).toContain('"status":"succeeded"');
        expect(events.split('initial-document-saved').length - 1).toBe(1);
        expect(events.split('contrast-recovery-completed').length - 1).toBe(1);
        const warnings = warning.mock.calls.filter(call => String(call[0]).startsWith('[document-contrast] Remaining'));
        expect(warnings).toHaveLength(corrected ? 0 : 1);
        if (!corrected) expect(warnings[0]?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ text: '주민 누구나', ratio: 1 })]));
      });
    } finally { warning.mockRestore(); }
  });
}
