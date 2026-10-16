import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { checkForUpdate } from '../src/update-routes.js';
import { UpdateSourceError } from '../src/update-source.js';

const manifest = { version: '1.3.4', fileName: 'Readable-Studio-win-x64-portable.zip', size: 4, sha256: 'a'.repeat(64), notes: '', publishedAt: '2026-10-15T00:00:00Z' };
const config = { enabled: true, serverUrl: 'https://updates.databricksapps.com' };
afterEach(() => vi.restoreAllMocks());

it('does not acquire credentials or make requests for disabled automatic checks', async () => {
  const token = vi.fn();
  const fetcher = vi.fn();
  expect(await checkForUpdate({ config: async () => ({ ...config, enabled: false }), token, fetch: fetcher }, true)).toEqual({ unavailable: 'disabled' });
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the server manifest and bearer with a real HTTP transport', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.url} ${req.headers.authorization}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(manifest));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await checkForUpdate({ config: async () => config, token: async () => ({ token: 'test', host: 'https://workspace.azuredatabricks.net' }), currentVersion: async () => '1.3.3', fetch: (url, init) => fetch(String(url).replace(config.serverUrl, local), init) });
    expect(result).toMatchObject({ latest: '1.3.4', isNewer: true, assetSize: 4 });
    expect(requests).toEqual(['/api/v1/latest Bearer test']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it.each([[403, 'forbidden'], [401, 'not-logged-in'], [500, 'unreachable']] as const)('types HTTP %s', async (status, unavailable) => {
  expect(await checkForUpdate({ config: async () => config, token: async () => ({ token: 'test', host: config.serverUrl }), fetch: vi.fn().mockResolvedValue(new Response('', { status })) })).toMatchObject({ unavailable });
});

it('rejects malformed manifests', async () => {
  expect(await checkForUpdate({ config: async () => config, token: async () => ({ token: 'test', host: config.serverUrl }), fetch: vi.fn().mockResolvedValue(Response.json({ ...manifest, sha256: 'bad' })) })).toMatchObject({ unavailable: 'invalid-response' });
});
it('returns the workspace to log in to without fetching when token acquisition fails', async () => {
  const fetcher = vi.fn();
  expect(await checkForUpdate({ config: async () => config, token: async () => { throw new UpdateSourceError('not-logged-in', 'https://workspace.azuredatabricks.net'); }, fetch: fetcher })).toEqual({ unavailable: 'not-logged-in', host: 'https://workspace.azuredatabricks.net' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('types transport failures', async () => {
  expect(await checkForUpdate({ config: async () => config, token: async () => ({ token: 'test', host: config.serverUrl }), fetch: vi.fn().mockRejectedValue(new TypeError('network')) })).toEqual({ unavailable: 'unreachable' });
});
