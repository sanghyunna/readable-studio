import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { missingYearHtml } from './helpers/final-gen-year-html.js';
import { missingDocumentYears } from '../src/document-fact-check.js';
vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let server: Server | undefined;
afterEach(async () => { if (server) await closeHttpServer(server); server = undefined; closeDatabase(); });

for (const budgetUsed of [false, true]) {
  it(`completes after exactly one year corrective turn (budgetUsed=${budgetUsed})`, async () => {
    const warning = vi.spyOn(console, 'warn');
    const initial = missingYearHtml;
    const fixed = initial.replace('10월 18일', '2025년 10월 18일');
    const peer = `
if(process.argv.includes('--version')){console.log('claude 1.0.0');process.exit(0);}
const fs=require('node:fs'),send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
 const second=fs.existsSync('.attempt');
 fs.writeFileSync('.attempt','1');
 if(second||!${budgetUsed})fs.writeFileSync('index.html',second&&!${budgetUsed}?${JSON.stringify(fixed)}:${JSON.stringify(initial)},'utf8');
 const text=second?'year-recovery-completed':'initial-document-saved';
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
        const projectId = 'year-' + randomUUID();
        const project = await post('/api/projects', { id: projectId, name: 'Year report', metadata: { kind: 'report' } });
        const run = await post('/api/runs', { projectId, conversationId: project.conversationId, agentId: 'claude', model: 'sonnet', message: '<readable-template-reference>Template 2024</readable-template-reference><readable-user-content-source/>Make a library reading club report for 2025-10-18' });
        const stream = await fetch(started.url + '/api/runs/' + run.runId + '/events', { signal: AbortSignal.timeout(20000) });
        const events = await stream.text();
        expect(events.match(/event: end\n/g)).toHaveLength(1);
        expect(events).toContain('"status":"succeeded"');
        expect(events.split('initial-document-saved').length - 1).toBe(1);
        expect(events.split('year-recovery-completed').length - 1).toBe(1);
        const warnings = warning.mock.calls.filter(call => String(call[0]).startsWith('[document-fact-check] Missing'));
        expect(warnings).toHaveLength(budgetUsed ? 1 : 0);
        if (budgetUsed) expect(warnings[0]?.[2]).toEqual(['2025']);
        const artifact = await fetch(started.url + '/api/projects/' + projectId + '/files/index.html');
        expect(artifact.ok).toBe(true);
        expect(missingDocumentYears('2025', await artifact.text())).toEqual(budgetUsed ? ['2025'] : []);
      });
    } finally { warning.mockRestore(); }
  });
}
