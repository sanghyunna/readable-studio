import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIDECAR_ENV } from '@readable-studio/sidecar-proto';
const { startWebSidecar } = await import(new URL('../../web/sidecar/server.ts', import.meta.url).href);

const root = await mkdtemp(join(tmpdir(), 'web-direct-proxy-'));
const daemonRequests: string[] = [];
const daemon = createServer((req, res) => { daemonRequests.push(req.url!); res.end('daemon-direct'); });
await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
const read = (url: string) => new Promise<string>((resolve, reject) => {
  const req = request(url, { agent: false, timeout: 5000 }, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body));
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(Error('request timeout'))); req.end();
});
let handle: Awaited<ReturnType<typeof startWebSidecar>> | undefined;
try {
  await writeFile(join(root, 'server.js'), `require('node:http').createServer((req,res)=>res.end('web-direct')).listen(Number(process.env.PORT),process.env.HOSTNAME,()=>console.log('MOCK STANDALONE READY'));`);
  Object.assign(process.env, {
    READABLE_WEB_STANDALONE_ROOT: root, READABLE_WEB_OUTPUT_MODE: 'standalone', READABLE_APP_VERSION: '1.2.1',
    [SIDECAR_ENV.DAEMON_PORT]: String((daemon.address() as { port: number }).port), [SIDECAR_ENV.WEB_PORT]: '0',
    READABLE_STANDALONE_STARTUP_TIMEOUT_MS: '10000',
  });
  handle = await startWebSidecar({ app: 'web', mode: 'runtime', namespace: `proxy-test-${process.pid}`, source: 'packaged', ipc: `\\\\.\\pipe\\readable-proxy-test-${process.pid}` });
  const status = await handle.status(); assert.ok(status.url);
  assert.equal(await read(`${status.url}/`), 'web-direct');
  assert.equal(await read(`${status.url}/api/health`), 'daemon-direct');
  assert.deepEqual(daemonRequests, ['/api/health']);
  console.log(JSON.stringify({ passed: true, noProxy: process.env.NO_PROXY, nativeEnvProxy: process.env.NODE_USE_ENV_PROXY, readiness: true, webForwarding: true, daemonForwarding: true }));
} finally {
  await handle?.stop();
  const closed = new Promise<void>(resolve => daemon.close(() => resolve())); daemon.closeAllConnections(); await closed;
  await rm(root, { recursive: true, force: true });
}
