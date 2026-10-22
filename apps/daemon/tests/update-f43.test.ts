import express from 'express';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { classifyCliFailure, DatabricksClient, issueFor } from '../src/databricks/client.js';
import { acquireUpdateToken, DatabricksUpdateSource } from '../src/update-source.js';
import { updateDownload } from '../src/update-download.js';
import { registerUpdateApplyRoutes } from '../src/update-apply-routes.js';

const base = 'https://f43.databricksapps.com';
const host = 'https://workspace-a.azuredatabricks.net';
const otherHost = 'https://workspace-b.azuredatabricks.net';
afterEach(() => vi.restoreAllMocks());

it.each([
  ['Error: context deadline exceeded', 'DATABRICKS_UPSTREAM_UNAVAILABLE', true, 'unreachable'],
  ['Error: Too Many Requests', 'DATABRICKS_UPSTREAM_UNAVAILABLE', true, 'unreachable'],
  ['Error: Internal Server Error', 'DATABRICKS_UPSTREAM_UNAVAILABLE', true, 'unreachable'],
  ['Error: unexpected upstream response', 'DATABRICKS_UPSTREAM_UNAVAILABLE', true, 'unreachable'],
  ['', 'DATABRICKS_UPSTREAM_UNAVAILABLE', true, 'unreachable'],
  ['Error: permission denied', 'DATABRICKS_PERMISSION_DENIED', false, 'forbidden'],
  ['Error: PERMISSION_DENIED: access denied', 'DATABRICKS_PERMISSION_DENIED', false, 'forbidden'],
  ['Error: token is expired', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
  ['Error: invalid access token', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
  ['Error: profile DEFAULT not found', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
  ['Error: not logged in', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
  ['Error: authentication expired', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
  ['Error: login required', 'DATABRICKS_AUTH_REQUIRED', false, 'not-logged-in'],
] as const)('R13-01 classifies raw CLI stderr %s at the shared boundary', async (stderr, code, retryable, reason) => {
  const error = classifyCliFailure(stderr);
  expect(error).toMatchObject({ code, retryable, message: code });
  expect(issueFor(error).action).toBe(reason === 'not-logged-in' ? 'sign-in' : reason === 'forbidden' ? 'check-permissions' : 'rescan');
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', cliSource: 'bundled', version: '0.300.0' });
  vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    if (args[1] === 'profiles') return { profiles: [{ name: 'DEFAULT', host }] };
    throw classifyCliFailure(stderr);
  });
  await expect(acquireUpdateToken(base)).rejects.toMatchObject({ reason, host });
});

it.each(['expiry', '401'] as const)('R13-02 rejects a reassigned workspace before acquiring its bearer on %s refresh', async (refresh) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let currentHost = host;
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', cliSource: 'bundled', version: '0.300.0' });
  const json = vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    if (args[1] === 'profiles') return { profiles: [{ name: 'DEFAULT', host: currentHost }] };
    if (args[0] === 'apps') return currentHost === host ? [{ url: base }] : [];
    return { access_token: currentHost === host ? 'workspace-a-token' : 'workspace-b-token', expiry: Date.now() + 3600_000 };
  });
  let rejectBearer = false;
  const sent: string[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('Authorization')!);
    return rejectBearer ? new Response('', { status: 401 }) : new Response('ok');
  });
  const source = new DatabricksUpdateSource(base, undefined, fetcher);
  await (await source.request('download/1.3.4')).text();
  const calls = json.mock.calls.length;
  currentHost = otherHost;
  // An unchanged, unexpired cached token must retain its subprocess-free fast path.
  await (await source.request('download/1.3.4', { headers: { Range: 'bytes=5-' } })).text();
  expect(json.mock.calls).toHaveLength(calls);
  if (refresh === 'expiry') clock.mockReturnValue(now + 3600_000);
  else rejectBearer = true;
  await expect(source.request('download/1.3.4')).rejects.toMatchObject({ reason: 'unreachable', host });
  expect(sent).not.toContain('Bearer workspace-b-token');
  expect(json.mock.calls.filter(([args]) => args[1] === 'token')).toHaveLength(1);
  // A subsequent request rediscovers instead of remaining bound to workspace A.
  await expect(source.request('download/1.3.4')).rejects.toMatchObject({ reason: 'app-not-accessible' });
  expect(json.mock.calls.filter(([args]) => args[0] === 'apps' && args[1] === 'list')).toHaveLength(2);
});

it('R13-03 returns the new downloading snapshot in the accepted retry response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-f43-retry-'));
  const bytes = Buffer.from('resumed fixture');
  const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip',
    assetSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: base, notes: '', checkedAt: '2026-10-16T00:00:00Z' };
  const download = updateDownload(root);
  await mkdir(download.directory);
  await writeFile(download.zip, bytes.subarray(0, 5));
  await writeFile(join(download.directory, 'offer.json'), JSON.stringify(offer));
  await writeFile(join(download.directory, 'failure.json'), JSON.stringify({ offer, error: 'unreachable', host }));
  await download.staged(offer.current);
  expect(download.status).toMatchObject({ state: 'failed', error: 'unreachable', received: 5 });
  const app = express();
  registerUpdateApplyRoutes(app, { root, check: async () => offer, source: {
    currentVersion: async () => offer.current, config: async () => ({ enabled: true, serverUrl: base }),
    token: async () => ({ token: 'test', host }),
    fetch: async () => new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` } }),
  } });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/update/download`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: 'downloading', error: null, received: 5, version: offer.latest });
  } finally {
    await download.cancel();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});
