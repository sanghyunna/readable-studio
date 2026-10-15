import type http from 'node:http';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreateProjectResponse } from '@readable-studio/contracts';

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));
vi.mock('../src/design-template-thumbnails.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/design-template-thumbnails.js')>()),
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { skillCwdAliasSegment } from '../src/cwd-aliases.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { buildTemplateZip, validTemplateEntries } from './helpers/template-zip.js';

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

async function importTemplate(): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([buildTemplateZip(validTemplateEntries())], { type: 'application/zip' }), 'deck.zip');
  const response = await fetch(`${baseUrl}/api/design-templates/import`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json() as { template: { id: string } };
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload.template.id;
}

// Runs a real project through /api/runs with a capturing fake agent; the
// capture is subscribed before the run starts (no sleeps or polling).
async function composedPrompt(projectBody: Record<string, unknown>, message: string): Promise<{ sent: string; projectId: string; created: CreateProjectResponse }> {
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
  void captured.catch(() => undefined);
  captureServer.listen(0, '127.0.0.1');
  await once(captureServer, 'listening');
  const capturePort = (captureServer.address() as net.AddressInfo).port;
  try {
    let sent = '';
    let projectId = '';
    let created!: CreateProjectResponse;
    await withFakeAgent('opencode', `
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const socket = require('node:net').connect(${capturePort}, '127.0.0.1', () => socket.write(JSON.stringify({ prompt }) + '\\n'));
  socket.on('data', () => {
    require('node:fs').writeFileSync(require('node:path').join(process.env.READABLE_PROJECT_DIR, 'index.html'), '<!doctype html><html><body>Captured deck</body></html>');
    console.log(JSON.stringify({ type: 'text', part: { text: 'Deck saved' } }));
  });
  socket.on('error', error => { console.error(error); process.exitCode = 1; });
});
`, async () => {
      created = await post<CreateProjectResponse>('/api/projects', projectBody);
      projectId = created.project.id;
      const run = await post<{ runId: string }>('/api/runs', {
        agentId: 'opencode', model: 'openai/gpt-5', message, currentPrompt: message, projectId,
      });
      sent = await captured;
      // The prompt is the asserted state; stop the run instead of waiting for
      // deck post-processing to finish.
      const cancelled = await fetch(`${baseUrl}/api/runs/${run.runId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
      expect(cancelled.ok).toBe(true);
    });
    return { sent, projectId, created };
  } finally {
    clearTimeout(timeout!);
    await new Promise<void>((resolve) => captureServer.close(() => resolve()));
  }
}

describe('applying a user-imported deck template (apply-contract.md)', () => {
  it('composes the generated SKILL.md body, page list and template contract, and stages pages/', async () => {
    const id = await importTemplate();
    expect(id).toBe('user-quarterly-review');
    const prefix = '<readable-template-reference role="structure-and-visual-style-only">\n{"text":"Quarterly Review"}\n</readable-template-reference>\n<readable-user-content-source/>\n\n';
    const user = 'USER_REQUEST_USERTPL: Cedar Library 2025 results, 320 participants.';
    const { sent, projectId, created } = await composedPrompt({
      id: 'user-template-apply', name: 'Cedar deck', skillId: id, pendingPrompt: prefix + user,
      metadata: { kind: 'deck', templateRef: { id, name: 'Quarterly Review', boundary: prefix.length } },
    }, prefix + user);

    const policy = JSON.parse(sent.match(/<readable-template-policy>(.*?)<\/readable-template-policy>/s)![1]!);
    expect(policy).toMatchObject({ templateRole: 'structure-and-visual-style-only', contentSources: ['user-request', 'user-attachments'] });
    const reference = sent.match(/<readable-template-reference kind="skill"[^>]*>\n(.*?)\n<\/readable-template-reference>/s);
    expect(reference, 'skill body reference block').toBeTruthy();
    const body = (JSON.parse(reference![1]!) as { body: string }).body;
    expect(body).toContain('PROMPT_BODY_MARKER_481: keep titles under 40 characters.');
    expect(body).toMatch(/cover\.html[^\n]*Title slide/);
    expect(body).toMatch(/two-column\.html[^\n]*Comparison with two columns/);
    expect(body).toMatch(/structure and style only/i);
    expect(sent.indexOf('<readable-template-policy>')).toBeLessThan(sent.lastIndexOf(user));
    // No default scenario plugin (simple-deck) competes with the user template.
    expect(created.appliedPluginSnapshotId).toBeUndefined();
    expect(created.project.appliedPluginSnapshotId ?? null).toBeNull();
    expect(sent).not.toContain('kind="plugin"');
    expect(sent).not.toContain('## Active stage');

    const staged = path.join(dataDir!, 'projects', projectId, '.readable-studio-skills', skillCwdAliasSegment(path.join(dataDir!, 'design-templates', id)));
    expect(existsSync(path.join(staged, 'pages', 'cover.html'))).toBe(true);
    expect(existsSync(path.join(staged, 'pages', 'assets', 'deck.css'))).toBe(true);
  }, 60_000);

  it('still pins the default simple-deck scenario plugin on an ordinary deck project', async () => {
    const created = await post<CreateProjectResponse>('/api/projects', {
      id: 'ordinary-deck-default-plugin', name: 'Ordinary deck', skillId: null, metadata: { kind: 'deck' },
    });
    expect(created.appliedPluginSnapshotId).toBeTruthy();
    const snapshot = await fetch(`${baseUrl}/api/applied-plugins/${encodeURIComponent(created.appliedPluginSnapshotId!)}`, { signal: AbortSignal.timeout(15_000) });
    expect(snapshot.ok).toBe(true);
    expect((await snapshot.json() as { pluginId: string }).pluginId).toBe('example-simple-deck');
  });

  it('rejects a project whose skillId names an unknown user template', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'user-template-missing', name: 'x', skillId: 'user-does-not-exist', metadata: { kind: 'deck', templateRef: { id: 'user-does-not-exist', name: 'x', boundary: 0 } } }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('SKILL_NOT_FOUND');
  });
});
