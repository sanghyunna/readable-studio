// GET /api/plugins/stats must hit the stats handler, not be captured by
// GET /api/plugins/:id (which would 404 with "plugin not found").

import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = { server: http.Server; url: string };

const dataDir = process.env.READABLE_DATA_DIR;
const PLUGIN_ID = `stats-route-${Date.now()}`;
let pluginRoot: string;
let server: http.Server | undefined;
let baseUrl: string;

beforeAll(async () => {
  if (!dataDir) throw new Error('READABLE_DATA_DIR is required for daemon route tests');
  pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'readable-stats-'));
  const folder = path.join(pluginRoot, PLUGIN_ID);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'readable-studio.json'),
    JSON.stringify({
      $schema: 'urn:readable-studio:schema:plugin-manifest:v1',
      name: PLUGIN_ID,
      title: 'Stats fixture',
      version: '1.0.0',
      description: 'fixture',
      license: 'MIT',
      readable: { kind: 'skill', capabilities: ['prompt:inject'] },
    }),
  );
  await writeFile(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${PLUGIN_ID}\ndescription: stats fixture\n---\n# fixture\n`,
  );

  const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
  server = started.server;
  baseUrl = started.url;

  const installResp = await fetch(`${baseUrl}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ source: folder }),
  });
  const raw = await installResp.text();
  if (!raw.includes('event: success')) throw new Error(`installer did not finalize:\n${raw}`);
}, 30_000);

afterAll(async () => {
  await new Promise((resolve, reject) => {
    if (!server) return resolve(undefined);
    server.close((error?: Error) => (error ? reject(error) : resolve(undefined)));
  });
  server = undefined;
  try {
    const db = new Database(path.join(dataDir ?? '', 'app.sqlite'));
    db.prepare('DELETE FROM installed_plugins WHERE id = ?').run(PLUGIN_ID);
    db.close();
  } catch {
    // DB may not exist in failure modes
  }
  await rm(pluginRoot, { recursive: true, force: true });
}, 30_000);

describe('GET /api/plugins/stats', () => {
  it('returns the stats report instead of a plugin lookup for "stats"', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/stats`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('plugins');
    expect(body).toHaveProperty('snapshots');
    expect(typeof body.generatedAt).toBe('number');
    expect(body).not.toHaveProperty('error');
  });
});

describe('GET /api/plugins/:id', () => {
  it('still returns an installed plugin detail', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}`);
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { id: string }).id).toBe(PLUGIN_ID);
  });

  it('still returns 404 for an unknown plugin id', async () => {
    const resp = await fetch(`${baseUrl}/api/plugins/does-not-exist`);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: 'plugin not found' });
  });
});
