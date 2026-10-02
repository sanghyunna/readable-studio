import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateHttpClient } from '../src/update-http.js';

const servers: Server[] = [];
async function listen(body: string, requests: string[]) {
  const server = createServer((req, res) => { requests.push(req.url!); res.end(body); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe('update HTTP environment routing', () => {
  it.each(['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])('uses %s independently of Node env-proxy support', async (key) => {
    const proxied: string[] = [];
    const target = 'http://update.invalid';
    const proxy = await listen('proxied', proxied);
    const client = createUpdateHttpClient({ [key]: proxy, NODE_USE_ENV_PROXY: '0' });
    try {
      expect(await (await client.fetch(`${target}/asset`, { signal: AbortSignal.timeout(5000) })).text()).toBe('proxied');
      expect(proxied).toEqual([`${target}/asset`]);
    } finally { await client.destroy(); }
  });
  it.each(['', 'example.com', '127.0.0.1', '*', '127.0.0.1:PORT'])('bypasses the proxy for NO_PROXY=%s', async (bypass) => {
    const direct: string[] = [], proxied: string[] = [];
    const target = await listen('direct', direct);
    const proxy = await listen('proxied', proxied);
    const client = createUpdateHttpClient({ HTTP_PROXY: proxy, NO_PROXY: bypass.replace('PORT', new URL(target).port) });
    try {
      expect(await (await client.fetch(`${target}/asset`, { signal: AbortSignal.timeout(5000) })).text()).toBe('direct');
      expect(direct).toEqual(['/asset']);
      expect(proxied).toEqual([]);
    } finally { await client.destroy(); }
  });
  it('honors lowercase no_proxy and follows redirects with the same dispatcher', async () => {
    const direct: string[] = [], proxied: string[] = [];
    const target = await listen('direct', direct);
    const proxy = createServer((req, res) => {
      proxied.push(req.url!);
      res.writeHead(302, { location: `${target}/redirected` }); res.end();
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const client = createUpdateHttpClient({ http_proxy: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, no_proxy: '127.0.0.1' });
    try {
      expect(await (await client.fetch('http://update.invalid/asset', { signal: AbortSignal.timeout(5000) })).text()).toBe('direct');
      expect(proxied).toEqual(['http://update.invalid/asset']);
      expect(direct).toEqual(['/redirected']);
    } finally { await client.destroy(); }
  });
});
