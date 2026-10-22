import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { waitForCdpEndpoint } from '../lib/packaged-hidden-desktop.ts';

let server: Server | undefined;
let controller: AbortController | undefined;
afterEach(async () => {
  controller?.abort(new Error('Test cleanup'));
  controller = undefined;
  server?.closeAllConnections();
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  server = undefined;
});

async function listen(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing debug port');
  return address.port;
}

test('accepts our ready CDP endpoint without a DevTools stdout line', async () => {
  let requests = 0;
  const port = await listen((request, response) => {
    expect(request.url).toBe('/json/version');
    if (++requests === 1) { response.writeHead(503); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/our-browser` }));
  });
  await expect(waitForCdpEndpoint(port, AbortSignal.timeout(2000)))
    .resolves.toBe(`ws://127.0.0.1:${port}/devtools/browser/our-browser`);
  expect(requests).toBe(2);
});

test('does not claim readiness for another process port', async () => {
  let requests = 0;
  const port = await listen((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/foreign' }));
  });
  await expect(waitForCdpEndpoint(port, AbortSignal.timeout(400))).rejects.toBeDefined();
  expect(requests).toBeGreaterThan(0);
});

test('aborts an outstanding endpoint request during lifecycle cleanup', async () => {
  let requested!: () => void;
  const observed = new Promise<void>(done => { requested = done; });
  const port = await listen(() => requested());
  controller = new AbortController();
  const pending = waitForCdpEndpoint(port, controller.signal);
  void pending.catch(() => {});
  await observed;
  controller.abort(new Error('Owned desktop closed'));
  await expect(pending).rejects.toThrow('Owned desktop closed');
});
