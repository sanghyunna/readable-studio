import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabricksClient, DatabricksServiceError, withDeadline } from '../src/databricks/client.js';
import { acquireUpdateToken, DatabricksUpdateSource, UpdateSourceError } from '../src/update-source.js';
import { UpdateDownload } from '../src/update-download.js';

const base = 'https://f42.databricksapps.com';
const host = 'https://workspace.azuredatabricks.net';
const bytes = Buffer.from('f42 resumable download');
const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip',
  assetSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: base, notes: '', checkedAt: '2026-10-16T00:00:00Z' };
function mockCli(failAt?: string) {
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', cliSource: 'bundled', version: '0.300.0' });
  return vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    if (args[1] === failAt) throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
    if (args[1] === 'profiles') return { profiles: [{ name: 'DEFAULT', host }] };
    if (args[0] === 'apps') return [{ url: base }];
    return { access_token: 'private-test-token', expiry: new Date(Date.now() + 3600_000).toISOString() };
  });
}
function settled(download: UpdateDownload) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { download.off('status', listener); reject(new Error('download deadline')); }, 10000);
    const listener = () => {
      if (!['ready', 'failed'].includes(download.status.state)) return;
      clearTimeout(timer); download.off('status', listener); resolve();
    };
    download.on('status', listener);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['profiles', 'list', 'token'])('Q16-01 classifies a transient %s helper failure as retryable, not logout', async (stage) => {
  mockCli(stage);
  await expect(acquireUpdateToken(base)).rejects.toMatchObject({ reason: 'unreachable' });
});

it('Q16-01 maps a bounded slow helper timeout to network failure', async () => {
  mockCli();
  vi.useFakeTimers();
  vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(() => withDeadline(() => new Promise(() => {}), 15000));
  const failure = acquireUpdateToken(base).catch(error => error);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await failure).toMatchObject({ reason: 'unreachable' });
});

it('Q16-03 reuses verified workspace and unexpired credentials across range requests, then refreshes expiry', async () => {
  const json = mockCli();
  const source = new DatabricksUpdateSource(base, undefined, async () => new Response('bytes'));
  await (await source.request('download/1.3.4')).text();
  await (await source.request('download/1.3.4', { headers: { Range: 'bytes=5-' } })).text();
  expect(json.mock.calls.filter(([args]) => args[1] === 'profiles')).toHaveLength(2);
  expect(json.mock.calls.filter(([args]) => args[1] === 'token')).toHaveLength(1);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 3600_000);
  await (await source.request('download/1.3.4')).text();
  expect(json.mock.calls.filter(([args]) => args[1] === 'profiles')).toHaveLength(3);
  expect(json.mock.calls.filter(([args]) => args[1] === 'token')).toHaveLength(2);
});

it('Q16-01 refreshes a rejected bearer once before declaring logout', async () => {
  const token = vi.fn().mockResolvedValueOnce({ token: 'expired', host }).mockResolvedValue({ token: 'renewed', host });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    new Headers(init?.headers).get('Authorization') === 'Bearer expired' ? new Response('', { status: 401 }) : new Response('ok'));
  const source = new DatabricksUpdateSource(base, token, fetcher);
  expect(await (await source.request('download/1.3.4')).text()).toBe('ok');
  expect(token).toHaveBeenLastCalledWith(base, true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('Q16-01 allows retry on the same source after a token-helper failure', async () => {
  const json = mockCli();
  json.mockRejectedValueOnce(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true));
  const source = new DatabricksUpdateSource(base, undefined, async () => new Response('ok'));
  await expect(source.request('download/1.3.4')).rejects.toMatchObject({ reason: 'unreachable' });
  expect(await (await source.request('download/1.3.4')).text()).toBe('ok');
});

it.each([0, 5])('Q16-05 retains failure at %s bytes through status recovery and a daemon restart until retry', async (received) => {
  const root = await mkdtemp(join(tmpdir(), 'f42-retain-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(join(download.directory, 'offer.json'), JSON.stringify(offer));
    await writeFile(download.zip, bytes.subarray(0, received));
    const done = settled(download);
    download.start(offer, new DatabricksUpdateSource(base, async () => { throw new UpdateSourceError('unreachable'); }));
    await done;
    expect(download.status).toMatchObject({ state: 'failed', error: 'unreachable', received });
    await download.cancel().then(() => { /* Explicit cancel is tested separately below. */ });
    // Create the failure again, then let all final persistence finish.
    const failed = settled(download);
    download.start(offer, new DatabricksUpdateSource(base, async () => { throw new UpdateSourceError('unreachable'); }));
    await failed;
    await download.staged(offer.current);
    expect(download.status).toMatchObject({ state: 'failed', error: 'unreachable' });
    const restarted = new UpdateDownload(root);
    await restarted.staged(offer.current);
    expect(restarted.status).toMatchObject({ state: 'failed', error: 'unreachable', received });
    restarted.checking();
    await restarted.checked(offer);
    expect(restarted.status).toMatchObject({ state: 'failed', error: 'unreachable' });
    const ready = settled(restarted);
    restarted.start(offer, new DatabricksUpdateSource(base, async () => ({ token: 'test', host }),
      async () => received ? new Response(bytes.subarray(received), { status: 206, headers: { 'content-range': `bytes ${received}-${bytes.length - 1}/${bytes.length}` } }) : new Response(bytes)));
    await ready;
    expect(restarted.status).toMatchObject({ state: 'ready', error: null });
    await restarted.cancel();
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it('Q16-03 measures local direct streaming versus downloader hashing, disk writes and status emission', async () => {
  const payload = Buffer.alloc(16 * 1024 * 1024, 42);
  const root = await mkdtemp(join(tmpdir(), 'f42-throughput-'));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader('Content-Length', payload.length); res.end(payload); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const download = new UpdateDownload(root);
  let events = 0;
  download.on('status', () => { events++; JSON.stringify(download.status); });
  const token = vi.fn(async () => ({ token: 'test', host }));
  try {
    const directStart = performance.now();
    const direct = await (await fetch(local)).arrayBuffer();
    const directMs = performance.now() - directStart;
    const started = performance.now();
    const done = settled(download);
    download.start({ ...offer, assetSize: payload.length, sha256: createHash('sha256').update(payload).digest('hex') },
      new DatabricksUpdateSource(local, token));
    await done;
    const downloadMs = performance.now() - started;
    console.log('F42_LOCAL_THROUGHPUT', JSON.stringify({ bytes: direct.byteLength, directMs, downloadMs, directMBps: 16 / (directMs / 1000),
      downloadMBps: 16 / (downloadMs / 1000), requests, tokenCalls: token.mock.calls.length, events }));
    expect(download.status.state).toBe('ready');
    expect(requests).toBe(2);
    expect(token).toHaveBeenCalledTimes(1);
  } finally {
    await download.cancel();
    const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});
