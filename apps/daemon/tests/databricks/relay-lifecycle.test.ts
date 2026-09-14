import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Server } from 'node:http';
import { test, vi } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

// Completion gates represent upstream native-resource disposal, not elapsed time.
test('relay close waits for in-flight upstream disposal before publishing quiescence', async () => {
  const events = new EventEmitter();
  const deadline = AbortSignal.timeout(5000);
  const requested = once(events, 'request', { signal: deadline });
  const aborted = once(events, 'abort', { signal: deadline });
  const listenerClosed = once(events, 'listener-close', { signal: deadline });
  const originalClose = Server.prototype.close;
  const closeObserver = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    return originalClose.call(this, (error) => {
      callback?.(error);
      events.emit('listener-close');
    });
  });
  let release!: () => void;
  const disposing = new Promise<void>((resolve) => { release = resolve; });
  let disposed = false;
  const relay = await createDatabricksRelay({ runtime: runtimeFixture(), fetch: async (_input, init) => {
    const signal = init!.signal!;
    const cancelled = once(signal, 'abort', { signal: deadline });
    events.emit('request');
    await cancelled;
    events.emit('abort');
    await disposing;
    disposed = true;
    throw new Error('upstream cancelled');
  } });
  const request = fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST',
    headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias }) });
  const disconnected = assert.rejects(request);
  try {
    await requested;
    const closing = relay.close();
    assert.equal(relay.close(), closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await aborted;
    await disconnected;
    await listenerClosed;
    // The real listener close callback ran, but upstream disposal is still held.
    assert.equal(closed, false, 'listener close must not overtake upstream disposal');
    release();
    await closing;
    assert.equal(disposed, true);
  } finally {
    release();
    await relay.close();
    closeObserver.mockRestore();
  }
});

test('relay close cancels a pending stream read and awaits its asynchronous disposer', async () => {
  const events = new EventEmitter();
  const deadline = AbortSignal.timeout(5000);
  const cancelled = once(events, 'cancel', { signal: deadline });
  let release!: () => void;
  const disposing = new Promise<void>((resolve) => { release = resolve; });
  let disposed = false;
  const body = new ReadableStream<Uint8Array>({
    async cancel() {
      events.emit('cancel');
      await disposing;
      disposed = true;
    },
  });
  const relay = await createDatabricksRelay({ runtime: runtimeFixture(), fetch: async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, stream: true }) });
    const disconnected = assert.rejects(response.text());
    const closing = relay.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await cancelled;
    await disconnected;
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(disposed, true);
    assert.equal(body.locked, false);
  } finally {
    release();
    await relay.close();
  }
});
