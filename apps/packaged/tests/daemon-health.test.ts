import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { checkPackagedDaemonHealth } from '../src/sidecars.js';

it.each(['', 'example.com', 'localhost,127.0.0.1,[::1]'])('checks loopback health directly with dead proxy env and NO_PROXY=%s', async (noProxy) => {
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete env[name];
    Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: noProxy, NODE_USE_ENV_PROXY: '1' });
    const moduleUrl = new URL('../src/sidecars.ts', import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href, '--input-type=module', '-e', `const { checkPackagedDaemonHealth } = await import(${JSON.stringify(moduleUrl)}); await checkPackagedDaemonHealth(${JSON.stringify(url)}); console.log(JSON.stringify({ ok: true }));`], { env, windowsHide: true, timeout: 10000 });
    expect(JSON.parse(stdout)).toEqual({ ok: true });
    expect(requests).toEqual(['GET /api/health']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 15000);

it('bounds a stalled response body with the health deadline', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{"ok":'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const requested = once(server, 'request', { signal: AbortSignal.timeout(5000) });
    const result = expect(checkPackagedDaemonHealth(`http://127.0.0.1:${(server.address() as { port: number }).port}`)).rejects.toThrow();
    await requested;
    await result;
  } finally { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; }
});

it.each([
  { status: 503, body: { ok: true } },
  { status: 200, body: { ok: false } },
  { status: 200, body: null },
  { status: 200, body: 'not-json' },
])('rejects unhealthy status or body $status/$body', async ({ status, body }) => {
  const server = createServer((_req, res) => { res.writeHead(status); res.end(typeof body === 'string' ? body : JSON.stringify(body)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(checkPackagedDaemonHealth(`http://127.0.0.1:${(server.address() as { port: number }).port}`)).rejects.toThrow();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
