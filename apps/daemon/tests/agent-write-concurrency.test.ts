import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
let daemon: Server | undefined;
afterEach(async () => {
  if (daemon) await closeHttpServer(daemon);
  daemon = undefined;
  closeDatabase();
});

const baseline = '<!doctype html><html><body><h1>Original</h1></body></html>';
const userContent = '<!doctype html><html><body><h1>User saved this</h1></body></html>';
const generated = '<!doctype html><html><body><h1>Agent result</h1></body></html>';
const digest = (content: string) => createHash('sha256').update(content).digest('hex');

for (const mode of ['http-conflict', 'http-success', 'native', 'atomic', 'native-saved-again', 'native-baseline-immediate'] as const) {
  const concurrentEdit = mode !== 'http-success';
  const native = mode !== 'http-conflict' && mode !== 'http-success';
  const immediate = mode === 'native-baseline-immediate';
  const externalContent = immediate ? baseline : generated;
  const savedAgain = mode === 'native-saved-again';
  it(native ? `preserves a saved edit when ${mode} filesystem writes overwrite it` : concurrentEdit ? 'preserves a user save while the agent is streaming and reports the rejected write through run status' : 'keeps successful agent writes and artifact saving unchanged without a concurrent edit', async () => {
    const projectId = `write-race-${randomUUID()}`;
    let heldResponse: ServerResponse | undefined;
    const control = createServer((req, res) => { heldResponse = res; control.emit(req.url === '/written' ? 'agent-written' : 'agent-ready'); });
    const listening = once(control, 'listening');
    control.listen(0, '127.0.0.1');
    await listening;
    const address = control.address();
    if (!address || typeof address === 'string') throw new Error('Missing control address');
    // Subscribe before launch. The peer cannot write or complete until this exact request is released.
    const ready = once(control, 'agent-ready', { signal: AbortSignal.timeout(15_000) });
    const peer = `
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
const request = (url, body) => new Promise((resolve, reject) => {
 const req = require('node:http').request(url, {method:body ? 'POST' : 'GET', agent:false, headers:{'content-type':'application/json'}}, res => {
  res.resume(); res.on('end', () => resolve(res.statusCode));
 });
 req.on('error', reject); req.end(body && JSON.stringify(body));
});
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'write-thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'write-turn'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Generating document'}});
  await request('http://127.0.0.1:${address.port}/ready');
  ${native ? `await require('node:fs/promises').writeFile(${JSON.stringify(mode === 'atomic' ? 'index.tmp' : 'index.html')}, ${JSON.stringify(externalContent)});
  ${mode === 'atomic' ? "await require('node:fs/promises').rename('index.tmp', 'index.html');" : ''}
  ${immediate ? '' : `await request('http://127.0.0.1:${address.port}/written');`}
  const status = 200;` : `const status = await request(process.env.READABLE_DAEMON_URL + '/api/projects/${projectId}/files', {
    name:'index.html',content:${JSON.stringify(generated)},artifactManifest:{
      schema:'readable-studio.artifact-manifest.v1',kind:'html',entry:'index.html',renderer:'html',status:'complete',exports:['html']
    }
  });`}
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:' write-status=' + status}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
 }
}).on('close',()=>{ process.exitCode = 0; });
`;
    try {
      await withFakeAgent('codex', peer, async () => {
        const started = await startServer({ port: 0, returnServer: true,
          isolatedAgentProbe: async () => ({ supported: false, reason: 'Controlled stdio fixture' }),
        });
        if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw new Error('Missing daemon');
        daemon = started.server;
        const base = started.url;
        const post = (route: string, body: unknown) => fetch(base + route, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const projectResponse = await post('/api/projects', { id: projectId, name: 'Write concurrency' });
        const project = await projectResponse.json() as { conversationId: string };
        expect(projectResponse.status).toBe(200);
        expect((await post(`/api/projects/${projectId}/files`, { name: 'index.html', content: baseline })).status).toBe(200);
        const runResponse = await post('/api/runs', { projectId, conversationId: project.conversationId,
          agentId: 'codex', model: 'selected-model', message: 'Update the document' });
        const run = await runResponse.json() as { runId: string };
        expect(runResponse.status).toBe(202);
        // Subscribe to completion before allowing the peer to finish.
        const stream = await fetch(`${base}/api/runs/${run.runId}/events`, { signal: AbortSignal.timeout(15_000) });
        let resolveConflict = () => {};
        const conflict = new Promise<void>(resolve => { resolveConflict = resolve; });
        const written = native && !immediate ? once(control, 'agent-written', { signal: AbortSignal.timeout(15_000) }) : null;
        const finished = (async () => {
          if (!stream.body) throw new Error('Missing SSE body');
          const reader = stream.body.getReader();
          const decoder = new TextDecoder();
          let text = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return text;
            text += decoder.decode(chunk.value, { stream: true });
            if (text.includes('native-overwrite')) resolveConflict();
          }
        })();
        await ready;
        if (concurrentEdit) {
          const saved = await post(`/api/projects/${projectId}/files`, {
            name: 'index.html', content: userContent, expectedContentSha256: digest(baseline),
          });
          expect(saved.status).toBe(200);
        }
        heldResponse!.end('complete');
        if (native && !immediate) {
          await written;
          await Promise.race([conflict, finished.then(() => { throw new Error('Missing native conflict'); })]);
          // Watcher reports the overwrite, but recovery is forbidden before terminal.
          expect(await fetch(`${base}/api/projects/${projectId}/files/index.html`).then(r => r.text())).toBe(generated);
          if (savedAgain) {
            expect((await post(`/api/projects/${projectId}/files`, {
              name: 'index.html', content: userContent + '\n', expectedContentSha256: digest(generated),
            })).status).toBe(200);
          }
          heldResponse!.end('finish');
        }
        const events = await finished;
        const disk = await fetch(`${base}/api/projects/${projectId}/files/index.html`).then(r => r.text());
        expect(disk).toBe(savedAgain ? userContent + '\n' : concurrentEdit ? userContent : generated);
        const status = await fetch(`${base}/api/runs/${run.runId}`).then(r => r.json()) as { status: string; errorCode: string };
        expect(status.status, JSON.stringify({ status, events })).toBe(concurrentEdit ? 'failed' : 'succeeded');
        expect(events).toContain(`write-status=${concurrentEdit && !native ? 409 : 200}`);
        if (native) {
          const sidecar = `index.agent-${run.runId.slice(0, 8)}.html`;
          const sidecarResponse = await fetch(`${base}/api/projects/${projectId}/files/${sidecar}`);
          if (savedAgain) expect(sidecarResponse.status).toBe(404);
          else expect(await sidecarResponse.text()).toBe(externalContent);
          expect(events).toContain('native-overwrite');
        }
        const terminalFrames = events.split('\n\n').filter(frame => frame.includes('event: end\n'));
        expect(terminalFrames).toHaveLength(1);
        const terminalData = terminalFrames[0]!.split('\n').find(line => line.startsWith('data: '));
        expect(JSON.parse(terminalData!.slice(6))).toMatchObject({ status: concurrentEdit ? 'failed' : 'succeeded' });
        if (concurrentEdit) {
          expect(status.errorCode).toBe('CONFLICT');
          expect(events).toContain('event: error');
          expect(events).not.toContain('event: run_retry_attempted');
        } else {
          const files = await fetch(`${base}/api/projects/${projectId}/files`).then(r => r.json()) as { files: Array<{ name: string; artifactManifest?: { status: string } }> };
          expect(files.files.find(f => f.name === 'index.html')?.artifactManifest?.status).toBe('complete');
        }
      });
    } finally {
      heldResponse?.end('cleanup');
      await closeHttpServer(control);
    }
  }, 30_000);
}
