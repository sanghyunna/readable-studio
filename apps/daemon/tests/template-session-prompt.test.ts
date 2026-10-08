import type http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateProjectResponse, CreateSessionResponse } from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { closeDatabase, insertTemplate, openDatabase } from '../src/db.js';
import { withFakeAgent } from './helpers/fake-agent.js';

const dataDir = process.env.READABLE_DATA_DIR;
if (!dataDir) throw new Error('isolated READABLE_DATA_DIR required');
let server: http.Server;
let baseUrl: string;
let shutdown: () => Promise<void>;
beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as { server: http.Server; url: string; shutdown: () => Promise<void> };
  server = started.server;
  baseUrl = started.url;
  shutdown = started.shutdown;
});
afterAll(async () => {
  await shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});
async function post<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as T;
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload;
}

describe('template-based workspace/session creation', () => {
  it.each(['/api/sessions', '/api/projects'])('%s keeps saved rendering bytes with a seed provenance notice', async (route) => {
    const db = openDatabase('', { dataDir });
    const id = route.endsWith('sessions') ? 'saved-session-template' : 'saved-project-template';
    const html = '<!doctype html><style>.card{color:red}</style><h1>SEED_DATA_723</h1>';
    insertTemplate(db, { id, name: 'SEED_TITLE_723', files: [{ name: 'index.html', content: html }], createdAt: 1 });
    const result = await post<CreateSessionResponse | CreateProjectResponse>(route, { id: `${id}-workspace`, title: 'User document', name: 'User document', pendingPrompt: 'USER_REQUEST_723', metadata: { kind: 'template', templateId: id } });
    const workspace = 'workspace' in result ? result.workspace : result.project;
    expect(workspace.metadata).toMatchObject({ kind: 'template', templateId: id });
    expect(workspace.pendingPrompt).toBe('USER_REQUEST_723');
    const seeded = await readFile(path.join(dataDir!, 'projects', workspace.id, 'index.html'), 'utf8');
    expect(JSON.parse(seeded.match(/<!-- readable-template-seed (.*)\n/)![1]!)).toMatchObject({
      templateRole: 'structure-and-visual-style-only', contentSources: ['user-request', 'user-attachments'],
      seededFiles: 'reference-placeholders', missingContent: 'question-form',
    });
    expect(seeded.replace(/^<!--[\s\S]*?-->\n/, '')).toBe(html);
  });

  it('sends the protected hidden-template path through a real session and runnable agent boundary', async () => {
    // Capture is subscribed before POST /api/runs; no sleeps or status polling.
    const captureServer = net.createServer();
    let timeout: ReturnType<typeof setTimeout>;
    const captured = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('agent prompt capture timed out')), 15_000);
      captureServer.once('connection', (socket) => {
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          text += chunk;
          if (!text.endsWith('\n')) return;
          clearTimeout(timeout);
          resolve(JSON.parse(text).prompt);
          socket.end('ok');
        });
        socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
      });
      captureServer.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    // Attach rejection handling immediately even if HTTP setup fails first.
    void captured.catch(() => undefined);
    captureServer.listen(0, '127.0.0.1');
    await once(captureServer, 'listening');
    const capturePort = (captureServer.address() as net.AddressInfo).port;
    try {
      await withFakeAgent('opencode', `
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const socket = require('node:net').connect(${capturePort}, '127.0.0.1', () => socket.write(JSON.stringify({ prompt }) + '\\n'));
  socket.on('data', () => {
    console.log(JSON.stringify({ type: 'text', part: { text: '<question-form id="content-source"><!-- capture fixture --></question-form>' } }));
  });
  socket.on('error', error => { console.error(error); process.exitCode = 1; });
});
`, async () => {
        const user = 'USER_REQUEST_723: Cedar Library has 320 participants and 18 volunteer tutors.';
        const prefix = '<readable-template-reference role="structure-and-visual-style-only">\n{"text":"CATALOGUE_SEED_723"}\n</readable-template-reference>\n<readable-user-content-source/>\n\n';
        const prompt = prefix + user;
        const session = await post<CreateSessionResponse>('/api/sessions', {
          title: 'Cedar Library', pendingPrompt: prompt, pluginId: 'example-finance-report', pluginInputs: {},
          metadata: { kind: 'other', templateRef: { id: 'example-finance-report', name: 'Finance Report', boundary: prefix.length }, examplePrompt: true, examplePromptBrief: { topic: 'FORBIDDEN_EXAMPLE_BRIEF_723' } },
        });
        expect(session.workspace.metadata?.templateRef?.boundary).toBe(prefix.length);
        const run = await post<{ runId: string }>('/api/runs', {
          agentId: 'opencode', model: 'openai/gpt-5', message: prompt, currentPrompt: prompt,
          projectId: session.workspace.id, conversationId: session.session.id,
          appliedPluginSnapshotId: session.appliedPluginSnapshotId,
        });
        const sent = await captured;
        const policy = JSON.parse(sent.match(/<readable-template-policy>(.*?)<\/readable-template-policy>/s)![1]!);
        expect(policy).toMatchObject({ contentSources: ['user-request', 'user-attachments'], missingContent: 'question-form' });
        const reference = sent.match(/<readable-template-reference kind="skill"[^>]*>\n(.*?)\n<\/readable-template-reference>/s);
        expect(JSON.parse(reference![1]!)).toHaveProperty('body');
        expect(sent).not.toContain('FORBIDDEN_EXAMPLE_BRIEF_723');
        expect(sent.indexOf('<readable-template-policy>')).toBeLessThan(sent.lastIndexOf(user));
        expect(sent).toContain(`<readable-user-content-source/>\n\n${user}`);
        // Finish at the buffered terminal SSE event, not by timing luck.
        const response = await fetch(`${baseUrl}/api/runs/${run.runId}/events`, { signal: AbortSignal.timeout(15_000) });
        const reader = response.body!.getReader();
        let events = '';
        try {
          while (!events.includes('event: end')) {
            const { value, done } = await reader.read();
            if (done) break;
            events += new TextDecoder().decode(value);
          }
          const end = events.match(/event: end\r?\ndata: ([^\n]+)/);
          expect(JSON.parse(end![1]!)).toMatchObject({ code: 0, status: 'succeeded' });
        } finally { await reader.cancel(); }
      });
    } finally {
      clearTimeout(timeout!);
      await new Promise<void>((resolve) => captureServer.close(() => resolve()));
    }
  });
});
