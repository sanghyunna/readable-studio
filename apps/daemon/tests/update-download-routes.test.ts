import express from 'express';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerUpdateRoutes } from '../src/update-routes.js';
import { registerUpdateApplyRoutes } from '../src/update-apply-routes.js';
import { updateDownload } from '../src/update-download.js';
import type { UpdateStatus } from '@readable-studio/contracts';

async function listen(server: Server): Promise<string> {
  // Ephemeral ports can be reused before fetch evicts a closed pooled socket.
  server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}
it.each(['1.3.4', '1.3.5'])('status and events drop an installed offer after checking running version %s', async (installed) => {
  const root = await mkdtemp(join(tmpdir(), 'update-installed-routes-'));
  const releaseUrl = 'https://updates.databricksapps.com';
  let current = '1.3.3';
  vi.stubEnv('READABLE_UPDATE_ROOT', root);
  const source = {
    currentVersion: async () => current,
    config: async () => ({ enabled: true, serverUrl: releaseUrl }),
    token: async () => ({ token: 'test', host: releaseUrl }),
    fetch: vi.fn(async () => Response.json({ version: '1.3.4', fileName: 'Readable-Studio-win-x64-portable.zip',
      size: 123, sha256: 'a'.repeat(64), notes: '', publishedAt: '2026-10-15T00:00:00Z' })),
  };
  const app = express();
  registerUpdateRoutes(app, source);
  registerUpdateApplyRoutes(app, { root, source });
  const server = createServer(app);
  const base = await listen(server);
  try {
    await fetch(`${base}/api/update/check`);
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ state: 'available', version: '1.3.4' });
    current = installed;
    expect(await (await fetch(`${base}/api/update/check`)).json()).toMatchObject({ current, isNewer: false });
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ state: 'idle', version: null, total: 0 });
    const events = await fetch(`${base}/api/update/events`, { signal: AbortSignal.timeout(5000) });
    const reader = events.body!.getReader();
    let buffered = '';
    try {
      while (!buffered.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed before initial status');
        buffered += new TextDecoder().decode(value);
      }
      expect(JSON.parse(buffered.split('\n\n')[0]!.replace(/^data: /, ''))).toMatchObject({ state: 'idle', version: null, total: 0 });
    } finally { await reader.cancel(); }
  } finally { await close(server); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it('health, download and status routes use the authenticated server and emit verified progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-routes-'));
  const bytes = Buffer.from('route download fixture');
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    expect(req.headers.authorization).toBe('Bearer test');
    calls.push(req.url!);
    if (req.url === '/api/v1/download/1.3.4') { res.setHeader('Content-Length', bytes.length); res.end(bytes); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/v1/health' ? { ok: true, service: 'readable-studio-update-server', apiVersion: 1 }
      : { version: '1.3.4', fileName: 'Readable-Studio-win-x64-portable.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), notes: '', publishedAt: '2026-10-15T00:00:00Z' }));
  });
  const upstreamUrl = await listen(upstream);
  const config = { enabled: true, serverUrl: 'https://updates.databricksapps.com' };
  const deps = { config: async () => config, token: async () => ({ token: 'test', host: 'https://workspace.azuredatabricks.net' }), currentVersion: async () => '1.3.3',
    fetch: ((url, init) => fetch(String(url).replace(config.serverUrl, upstreamUrl), init)) as typeof fetch };
  const app = express(); app.use(express.json());
  registerUpdateRoutes(app, deps);
  registerUpdateApplyRoutes(app, { root, source: deps });
  const daemon = createServer(app);
  const base = await listen(daemon);
  let stream: Response | undefined;
  try {
    expect(await (await fetch(`${base}/api/update/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl: config.serverUrl }) })).json()).toEqual({ ok: true });
    stream = await fetch(`${base}/api/update/events`, { signal: AbortSignal.timeout(5000) });
    const statuses: UpdateStatus[] = [];
    const reader = stream.body!.getReader();
    const completion = (async () => {
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed before ready');
        buffered += new TextDecoder().decode(value);
        let boundary: number;
        while ((boundary = buffered.indexOf('\n\n')) !== -1) {
          const event = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          const status = JSON.parse(event.replace(/^data: /, '')) as UpdateStatus;
          statuses.push(status);
          if (status.state === 'ready') { await reader.cancel(); return; }
        }
      }
    })();
    expect((await fetch(`${base}/api/update/download`, { method: 'POST' })).status).toBe(202);
    await completion;
    expect(statuses.map((status) => status.state)).toEqual(expect.arrayContaining(['idle', 'downloading', 'verifying', 'ready']));
    expect(statuses.map((status) => status.received)).toEqual([...statuses.map((status) => status.received)].sort((a, b) => a - b));
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ state: 'ready', received: bytes.length, total: bytes.length, version: '1.3.4' });
    expect(calls).toEqual(['/api/v1/health', '/api/v1/latest', '/api/v1/download/1.3.4']);
    expect((await fetch(`${base}/api/update/cancel`, { method: 'POST' })).status).toBe(200);
  } finally { await updateDownload(root).cancel(); await close(daemon); await close(upstream); await rm(root, { recursive: true, force: true }); }
});

it.each(['cancel', 'source'])('does not start a transfer after %s changes during manifest preparation', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'update-pending-'));
  const app = express();
  const bytes = Buffer.from('fixture');
  const config = { enabled: true, serverUrl: 'https://updates.databricksapps.com' };
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const fetcher = vi.fn(async () => new Response(bytes));
  registerUpdateApplyRoutes(app, { root, source: { config: async () => config }, fetch: fetcher,
    check: async () => { entered(); await pending; return { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: 'https://updates.databricksapps.com', notes: '', checkedAt: new Date().toISOString() }; } });
  const server = createServer(app);
  const base = await listen(server);
  try {
    const response = fetch(`${base}/api/update/download`, { method: 'POST' });
    await checking;
    if (change === 'cancel') await fetch(`${base}/api/update/cancel`, { method: 'POST' });
    else config.serverUrl = 'https://other.databricksapps.com';
    release();
    expect((await response).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    expect(updateDownload(root).status.state).toBe('idle');
  } finally { release(); await updateDownload(root).cancel(); await close(server); await rm(root, { recursive: true, force: true }); }
});

it('status recovers a verified ready offer with its source after a failed fresh check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-status-recovery-'));
  const download = updateDownload(root);
  const bytes = Buffer.from('recovered fixture');
  const releaseUrl = 'https://updates.databricksapps.com';
  const app = express();
  registerUpdateApplyRoutes(app, { root, source: { config: async () => ({ enabled: true, serverUrl: releaseUrl }) } });
  const server = createServer(app);
  const base = await listen(server);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify({ current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl, notes: '', checkedAt: new Date().toISOString() }));
    download.checking();
    await download.checked({ unavailable: 'unreachable' });
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ state: 'ready', version: '1.3.4', releaseUrl });
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});

it.each([false, true])('check reconciles status and broadcasts withdrawal for recovered ready=%s', async (ready) => {
  const root = await mkdtemp(join(tmpdir(), 'update-withdrawal-'));
  const download = updateDownload(root);
  const bytes = Buffer.from('withdrawal fixture');
  const releaseUrl = 'https://updates.databricksapps.com';
  const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl, notes: '', checkedAt: '2026-10-15T00:00:00Z' };
  vi.stubEnv('READABLE_UPDATE_ROOT', root);
  await mkdir(download.directory);
  await writeFile(download.zip, ready ? bytes : bytes.subarray(0, 5));
  await writeFile(join(download.directory, ready ? 'ready.json' : 'offer.json'), JSON.stringify(offer));
  const source = { currentVersion: async () => offer.current, config: async () => ({ enabled: true, serverUrl: releaseUrl }),
    token: async () => ({ token: 'test', host: releaseUrl }), fetch: vi.fn(async () => new Response('', { status: 404 })) };
  const app = express();
  registerUpdateRoutes(app, source);
  registerUpdateApplyRoutes(app, { root, source });
  const server = createServer(app);
  const base = await listen(server);
  const statuses: UpdateStatus[] = [];
  const record = (status: UpdateStatus) => statuses.push(status);
  try {
    await fetch(`${base}/api/update/status`);
    download.on('status', record);
    expect(await (await fetch(`${base}/api/update/check`)).json()).toEqual({ unavailable: 'no-release' });
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ state: 'idle', version: null, received: 0, total: 0, error: null });
    expect(statuses.at(-1)).toMatchObject({ state: 'idle', version: null, received: 0, total: 0, discardedDownload: { id: expect.any(String), version: offer.latest } });
    const notice = statuses.at(-1)!.discardedDownload;
    await fetch(`${base}/api/update/check`);
    expect(await (await fetch(`${base}/api/update/status`)).json()).toMatchObject({ discardedDownload: notice });
    await expect(access(download.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { download.off('status', record); await close(server); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
