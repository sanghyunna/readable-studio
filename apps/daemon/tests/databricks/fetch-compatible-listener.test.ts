import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, vi } from 'vitest';
import { FetchCompatiblePortError, listenOnFetchCompatiblePort } from '../../src/fetch-compatible-listener.js';

/** Model assigned ports and asynchronous close completion, not OS allocation luck. */
function assignedPorts(ports: number[], automaticClose = false) {
  const server = createServer();
  let port: number | undefined;
  let completeClose: (() => void) | undefined;
  const events: string[] = [];
  const listen = vi.spyOn(server, 'listen').mockImplementation((...args: unknown[]) => {
    assert.deepEqual(args, [0, '127.0.0.1']);
    assert.equal(port, undefined, 'the previous listener must be completely closed');
    port = ports.shift();
    assert.notEqual(port, undefined, 'unexpected extra bind');
    events.push(`listen:${port}`);
    queueMicrotask(() => server.emit('listening'));
    return server;
  });
  vi.spyOn(server, 'address').mockImplementation(() => port === undefined ? null : { address: '127.0.0.1', family: 'IPv4', port });
  const close = vi.spyOn(server, 'close').mockImplementation((callback) => {
    events.push(`close:${port}`);
    completeClose = () => {
      events.push(`closed:${port}`);
      port = undefined;
      server.emit('close');
      callback?.();
    };
    server.emit('closing');
    if (automaticClose) queueMicrotask(completeClose);
    return server;
  });
  const closeAll = vi.spyOn(server, 'closeAllConnections').mockImplementation(() => { events.push('closeAll'); });
  return { server, listen, close, closeAll, events, finishClose: () => {
    assert.ok(completeClose);
    completeClose();
  } };
}

for (const blockedPort of [5060, 5061, 10080]) {
  test(`closes Fetch-blocked port ${blockedPort} completely before returning a safe listener`, async () => {
    const listener = assignedPorts([blockedPort, 15001]);
    const closing = once(listener.server, 'closing', { signal: AbortSignal.timeout(5000) });
    let returned = false;
    const pending = listenOnFetchCompatiblePort(listener.server).then((result) => { returned = true; return result; });
    await closing;
    assert.equal(returned, false);
    assert.equal(listener.listen.mock.calls.length, 1);
    assert.equal(listener.closeAll.mock.calls.length, 1);
    listener.finishClose();
    const result = await pending;
    assert.equal(result.server, listener.server);
    assert.equal(result.port, 15001);
    assert.deepEqual(listener.events, [`listen:${blockedPort}`, `close:${blockedPort}`, 'closeAll', `closed:${blockedPort}`, 'listen:15001']);
    assert.deepEqual(result.server.address(), { address: '127.0.0.1', family: 'IPv4', port: 15001 });
  });
}

test('bounds blocked-port retries and closes the final listener before throwing a typed error', async () => {
  const listener = assignedPorts(Array(10).fill(5061), true);
  const originalListening = listener.server.listeners('listening');
  await assert.rejects(listenOnFetchCompatiblePort(listener.server), FetchCompatiblePortError);
  assert.equal(listener.listen.mock.calls.length, 10);
  assert.equal(listener.close.mock.calls.length, 10);
  assert.equal(listener.closeAll.mock.calls.length, 10);
  assert.equal(listener.server.address(), null);
  assert.equal(listener.server.listenerCount('error'), 0);
  assert.deepEqual(listener.server.listeners('listening'), originalListening);
});

test('propagates bind errors without retrying or leaving listening-event subscriptions', async () => {
  const server = createServer();
  const originalListening = server.listeners('listening');
  const error = Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' });
  const listen = vi.spyOn(server, 'listen').mockImplementation(() => {
    queueMicrotask(() => server.emit('error', error));
    return server;
  });
  await assert.rejects(listenOnFetchCompatiblePort(server), (actual) => actual === error);
  assert.equal(listen.mock.calls.length, 1);
  assert.deepEqual(server.listeners('listening'), originalListening);
  assert.equal(server.listenerCount('error'), 0);
});

test('propagates close errors instead of retrying a listener whose close failed', async () => {
  const listener = assignedPorts([5060]);
  const error = new Error('close failed');
  listener.close.mockImplementation((callback) => {
    queueMicrotask(() => callback?.(error));
    return listener.server;
  });
  await assert.rejects(listenOnFetchCompatiblePort(listener.server), (actual) => actual === error);
  assert.equal(listener.listen.mock.calls.length, 1);
});

test('returns a real IPv4 loopback listener reachable through Fetch', async () => {
  const server = createServer((_request, response) => response.end('reachable'));
  const listener = await listenOnFetchCompatiblePort(server);
  try {
    assert.equal(listener.server, server);
    assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: listener.port });
    const response = await fetch(`http://127.0.0.1:${listener.port}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'reachable');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
