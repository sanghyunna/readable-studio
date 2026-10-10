import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { lintDocumentScripts } from '../src/document-script.js';
import { missingDocumentYears } from '../src/document-fact-check.js';
vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let server: Server | undefined;
afterEach(async () => { if (server) await closeHttpServer(server); server = undefined; closeDatabase(); });

for (const corrected of [true, false]) {
  it(`combines year, contrast and script checks into one corrective turn then succeeds (corrected=${corrected})`, async () => {
    const warning = vi.spyOn(console, 'warn');
    const initial = '<body><p style="background:#fff;color:#fff">Library</p><script>document.getElementById(\'\'deck-next\'\');</script></body>';
    const fixed = '<body><p style="background:#fff;color:#000">Library 2025</p><script>document.getElementById(\'deck-next\');</script></body>';
    const peer = `
if(process.argv.includes('--version')){console.log('claude 1.0.0');process.exit(0);}
const fs=require('node:fs'),send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
 const second=fs.existsSync('.attempt');fs.writeFileSync('.attempt','1');
 if(second)fs.writeFileSync('recovery-prompt.txt',line,'utf8');
 fs.writeFileSync('index.html',second&&${corrected}?${JSON.stringify(fixed)}:${JSON.stringify(initial)},'utf8');
 const text=second?'combined-recovery-completed':'initial-document-saved';
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
        const projectId = 'script-' + randomUUID();
        const project = await post('/api/projects', { id: projectId, name: 'Library report', metadata: { kind: 'report' } });
        const run = await post('/api/runs', { projectId, conversationId: project.conversationId, agentId: 'claude', model: 'sonnet', message: 'Make a library report for 2025' });
        const stream = await fetch(started.url + '/api/runs/' + run.runId + '/events', { signal: AbortSignal.timeout(20000) });
        const events = await stream.text();
        expect(events.match(/event: end\n/g)).toHaveLength(1);
        expect(events).toContain('"status":"succeeded"');
        expect(events.split('initial-document-saved').length - 1).toBe(1);
        expect(events.split('combined-recovery-completed').length - 1).toBe(1);
        const promptResponse = await fetch(started.url + '/api/projects/' + projectId + '/files/recovery-prompt.txt');
        expect(promptResponse.ok).toBe(true);
        const envelope = JSON.parse(await promptResponse.text()) as { message: { content: Array<{ type: string; text: string }> } };
        const prompt = envelope.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const corrective = prompt.slice(prompt.indexOf('Make a library report for 2025') + 'Make a library report for 2025'.length);
        // Assert machine-consumed issue values, not corrective prose wording.
        expect(corrective).toContain('2025');
        expect(corrective).toContain('script-syntax');
        expect(corrective).toContain("''deck-next''");
        expect(corrective).toContain('Library');
        expect(corrective).toContain('(1:1)');
        const html = await (await fetch(started.url + '/api/projects/' + projectId + '/files/index.html')).text();
        expect(missingDocumentYears('2025', html)).toEqual(corrected ? [] : ['2025']);
        expect(lintDocumentScripts(html)).toHaveLength(corrected ? 0 : 1);
        expect(warning.mock.calls.filter(call => String(call[0]).startsWith('[document-script] Remaining'))).toHaveLength(corrected ? 0 : 1);
      });
    } finally { warning.mockRestore(); }
  });
}
