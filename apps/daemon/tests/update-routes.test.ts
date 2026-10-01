import express from 'express';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, registerUpdateRoutes } from '../src/update-routes.js';

const hash = 'a'.repeat(64);
const name = 'Readable-Studio-win-x64-portable.zip';
const url = 'https://github.com/sanghyunna/readable-studio/releases/tag/v1.3.0';
const release = (tag = 'v1.3.0') => ({ tag_name: tag, html_url: url,
  body: `SHA-256 (\`${name}\`):\n\`\`\`text\n${hash}\n\`\`\``,
  assets: [{ name, size: 1234, browser_download_url: `https://github.com/sanghyunna/readable-studio/releases/download/${tag}/${name}` }],
});
const options = (fetcher: typeof fetch) => ({ fetch: fetcher, currentVersion: async () => '1.2.1', env: {}, timeoutMs: 4000 });
afterEach(() => vi.useRealTimers());

describe('update check', () => {
  it('returns newer and exact published body checksum through the route', async () => {
    const app = express();
    registerUpdateRoutes(app, options(vi.fn().mockResolvedValue(Response.json(release()))));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/update/check`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ current: '1.2.1', latest: '1.3.0', isNewer: true, assetName: name, assetSize: 1234, sha256: hash, releaseUrl: url });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it('returns same version silently', async () => {
    expect(await checkForUpdate(options(vi.fn().mockResolvedValue(Response.json(release('v1.2.1')))))).toMatchObject({ isNewer: false });
  });
  it.each([{}, { ...release(), tag_name: 'broken' }, { ...release(), body: '' }, { ...release(), assets: [] }, { ...release(), html_url: 'https://evil.example/release' }])('returns malformed for invalid metadata', async (data) => {
    expect(await checkForUpdate(options(vi.fn().mockResolvedValue(Response.json(data))))).toEqual({ unavailable: 'malformed' });
  });
  it('returns offline on network error', async () => {
    expect(await checkForUpdate(options(vi.fn().mockRejectedValue(new TypeError('network'))))).toEqual({ unavailable: 'offline' });
  });
  it('recognizes GitHub rate limiting', async () => {
    expect(await checkForUpdate(options(vi.fn().mockResolvedValue(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))))).toEqual({ unavailable: 'rate-limited' });
  });
  it('bounds a hung request and aborts it', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); });
    const result = checkForUpdate(options(fetcher as typeof fetch));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toEqual({ unavailable: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });
  it('prefers SHA256SUMS asset over body', async () => {
    const data = release();
    data.assets.push({ name: 'SHA256SUMS', size: 100, browser_download_url: 'https://github.com/sanghyunna/readable-studio/releases/download/v1.3.0/SHA256SUMS' });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(data)).mockResolvedValueOnce(new Response(`${'b'.repeat(64)}  ${name}\n`));
    expect(await checkForUpdate(options(fetcher))).toMatchObject({ sha256: 'b'.repeat(64) });
  });
  it('fails closed on malformed checksum asset even if body is valid', async () => {
    const data = release();
    data.assets.push({ name: 'SHA256SUMS.txt', size: 10, browser_download_url: 'https://github.com/sanghyunna/readable-studio/releases/download/v1.3.0/SHA256SUMS.txt' });
    expect(await checkForUpdate(options(vi.fn().mockResolvedValueOnce(Response.json(data)).mockResolvedValueOnce(new Response('invalid'))))).toEqual({ unavailable: 'malformed' });
  });
  it('does not silently fall back to the body when a checksum asset has an invalid URL', async () => {
    const data = release();
    data.assets.push({ name: 'SHA256SUMS', size: 100, browser_download_url: 'https://evil.example/SHA256SUMS' });
    expect(await checkForUpdate(options(vi.fn().mockResolvedValue(Response.json(data))))).toEqual({ unavailable: 'malformed' });
  });
  it('honours disabled automatic checks without fetching but permits manual checks', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(release()));
    const deps = { ...options(fetcher), env: { READABLE_DISABLE_UPDATE_CHECK: '1' } };
    expect(await checkForUpdate(deps, true)).toEqual({ unavailable: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await checkForUpdate(deps)).toMatchObject({ isNewer: true });
  });
});
