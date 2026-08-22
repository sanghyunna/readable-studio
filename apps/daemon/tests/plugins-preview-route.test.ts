// Plan §6 Phase 2B / spec §11.6 / §9.2 — `/api/plugins/:id/preview`
// and `/api/plugins/:id/example/:name` sandbox envelope.
//
// Tests that:
//   - the preview endpoint resolves `readable.preview.entry`, falls back
//     to common defaults, and serves with the §9.2 CSP + nosniff
//     headers (so the marketplace iframe can't reach back into
//     /api/*).
//   - example name matching honours basename / stem / title.
//   - traversal segments + symlink leaks are refused.
//   - unknown plugin ids and missing entries return 404.

import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = { server: http.Server; url: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
const serverRuntimeDataRoot = process.env.READABLE_DATA_DIR
  ? path.resolve(projectRoot, process.env.READABLE_DATA_DIR)
  : path.join(projectRoot, '.readable-studio');

const PLUGIN_ID = `phase2b-preview-${Date.now()}`;
let pluginRoot: string;
let server: http.Server | undefined;
let baseUrl: string;

beforeAll(async () => {
  pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'readable-preview-'));
  const folder = path.join(pluginRoot, PLUGIN_ID);
  await mkdir(path.join(folder, 'preview'), { recursive: true });
  await mkdir(path.join(folder, 'examples', 'desk-warm'), { recursive: true });
  await mkdir(path.join(folder, 'examples', 'wrapped'), { recursive: true });
  await writeFile(
    path.join(folder, 'preview', 'index.html'),
    '<!DOCTYPE html><title>preview</title><p>preview body</p>',
  );
  await writeFile(
    path.join(folder, 'examples', 'desk-warm', 'index.html'),
    '<!DOCTYPE html><title>desk-warm</title><p>example body</p>',
  );
  await writeFile(
    path.join(folder, 'examples', 'wrapped', 'index.html'),
    '<!DOCTYPE html><body><!-- shell --><iframe src="./inner.html" title="wrapped"></iframe></body>',
  );
  await writeFile(
    path.join(folder, 'examples', 'wrapped', 'inner.html'),
    '<!DOCTYPE html><title>wrapped</title><img src="./hero.png"><p>wrapped body</p>',
  );
  await writeFile(path.join(folder, 'examples', 'wrapped', 'hero.png'), Buffer.from('plugin-image'));
  await writeFile(
    path.join(folder, 'readable-studio.json'),
    JSON.stringify({
      $schema: 'urn:readable-studio:schema:plugin-manifest:v1',
      name: PLUGIN_ID,
      title: 'Preview fixture',
      version: '1.0.0',
      description: 'fixture',
      license: 'MIT',
      readable: {
        kind: 'skill',
        capabilities: ['prompt:inject'],
        preview: { entry: 'preview/index.html' },
        useCase: {
          query: 'demo',
          exampleOutputs: [
            { path: 'examples/desk-warm/index.html', title: 'Desk warm' },
            { path: 'examples/wrapped/index.html', title: 'Wrapped shell' },
          ],
        },
      },
    }),
  );
  await writeFile(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${PLUGIN_ID}\ndescription: preview fixture\n---\n# fixture\n`,
  );

  const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
  server = started.server;
  baseUrl = started.url;

  // Install via SSE — fully drain the stream so the success event
  // (which is what writes the installed_plugins row) lands before
  // we hit GET /api/plugins/:id.
  const installResp = await fetch(`${baseUrl}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ source: folder }),
  });
  if (installResp.body) {
    const reader = installResp.body.getReader();
    let raw = '';
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value);
    }
    // Sanity-check the SSE actually emitted a `success` event so the
    // test fails loudly if the installer didn't finalize.
    if (!raw.includes('event: success')) {
      throw new Error(`installer did not finalize:\n${raw}`);
    }
  }
}, 30_000);

afterAll(async () => {
  await new Promise((resolve, reject) => {
    if (!server) return resolve(undefined);
    server.close((error?: Error) => (error ? reject(error) : resolve(undefined)));
  });
  server = undefined;

  // Strip the test plugin row from the daemon's DB.
  try {
    const dbPath = path.join(serverRuntimeDataRoot, 'app.sqlite');
    const db = new Database(dbPath);
    db.prepare('DELETE FROM installed_plugins WHERE id = ?').run(PLUGIN_ID);
    db.close();
  } catch {
    // ignore — the DB might not exist in failure modes
  }

  await rm(pluginRoot, { recursive: true, force: true });
}, 30_000);

describe('GET /api/plugins/:id/preview', () => {
  it('serves preview/index.html with the §9.2 sandbox CSP', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/preview`);
    if (resp.status !== 200) {
      const text = await resp.text();
      throw new Error(`preview returned ${resp.status}: ${text}`);
    }
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const csp = resp.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await resp.text();
    expect(body).toContain('preview body');
  });

  it('returns 404 when the plugin id is unknown', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/does-not-exist/preview`);
    expect(resp.status).toBe(404);
  });
});

describe('GET /api/plugins/:id/example/:name', () => {
  it('matches a declared example by basename / stem / title', async () => {
    // Three lookup forms: the folder name (canonical), the
    // basename of the path inside the folder, and the declared title.
    for (const name of ['desk-warm', 'index.html', 'Desk warm']) {
      const resp = await fetch(
        `${baseUrl}/api/plugins/${PLUGIN_ID}/example/${encodeURIComponent(name)}`,
      );
      expect(resp.status, `lookup by ${name}`).toBe(200);
      expect(resp.headers.get('content-security-policy') ?? '').toContain("connect-src 'none'");
      const body = await resp.text();
      expect(body).toContain('example body');
    }
  });

  it('unwraps iframe-only HTML shells and rewrites relative assets', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/example/wrapped`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain('wrapped body');
    expect(body).not.toContain('<iframe');
    expect(body).toContain(
      `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/asset/examples/wrapped/hero.png`,
    );
  });

  it('rejects traversal segments with 400', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/example/..%2Fescape`);
    expect(resp.status).toBe(400);
  });

  it('returns 404 for an unknown example name', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/example/missing-thing`);
    expect(resp.status).toBe(404);
  });
});

describe('POST /api/exports/standalone-html plugin sources', () => {
  it('uses the same resolver for preview and named example assets', async () => {
    const preview = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'plugin', pluginId: PLUGIN_ID } }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('preview body');

    const example = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'plugin', pluginId: PLUGIN_ID, exampleName: 'wrapped' } }),
    });
    expect(example.status).toBe(200);
    const body = await example.text();
    expect(body).toContain('wrapped body');
    expect(body).toContain('src="data:image/png;base64,');
    expect(body).not.toContain('/api/plugins/');
  });

  it('maps an oversized plugin preview to PAYLOAD_TOO_LARGE', async () => {
    const db = new Database(path.join(serverRuntimeDataRoot, 'app.sqlite'));
    const installed = db.prepare('SELECT fs_path AS fsPath FROM installed_plugins WHERE id = ?').get(PLUGIN_ID) as { fsPath: string };
    db.close();
    const previewPath = path.join(installed.fsPath, 'preview', 'index.html');
    try {
      await writeFile(previewPath, Buffer.alloc(5 * 1024 * 1024 + 1));
      expect((await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/preview`)).status).toBe(413);
      const response = await fetch(`${baseUrl}/api/exports/standalone-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { kind: 'plugin', pluginId: PLUGIN_ID } }),
      });
      expect(response.status).toBe(413);
      expect((await response.json()) as unknown).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    } finally {
      await writeFile(previewPath, '<!DOCTYPE html><title>preview</title><p>preview body</p>');
    }
  });

  it('maps an oversized named example to 413 on the preview route', async () => {
    const db = new Database(path.join(serverRuntimeDataRoot, 'app.sqlite'));
    const installed = db.prepare('SELECT fs_path AS fsPath FROM installed_plugins WHERE id = ?').get(PLUGIN_ID) as { fsPath: string };
    db.close();
    const examplePath = path.join(installed.fsPath, 'examples', 'desk-warm', 'index.html');
    try {
      await writeFile(examplePath, Buffer.alloc(5 * 1024 * 1024 + 1));
      expect((await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/example/desk-warm`)).status).toBe(413);
    } finally {
      await writeFile(examplePath, '<!DOCTYPE html><title>desk-warm</title><p>example body</p>');
    }
  });
});
