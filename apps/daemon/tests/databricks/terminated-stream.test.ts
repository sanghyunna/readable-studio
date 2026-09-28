import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { mapPiRpcEvent } from '../../src/pi-rpc.js';
import { formatStreamFailure } from '../../src/stream-failure.js';
import { runtimeFixture } from './runtime-fixture.js';

test('Pi forwards an actionable error when its own fetch only reports terminated', () => {
  // Given: Pi has serialized the fetch error to a bare string before RPC delivery.
  const failures: Record<string, unknown>[] = [];
  // When: the daemon maps the child error event.
  mapPiRpcEvent({ type: 'turn_end', message: { stopReason: 'error', errorMessage: 'terminated' } },
    (_channel, payload) => { if (payload.type === 'error') failures.push(payload); },
    { runStartedAt: Date.now(), sentFirstToken: { value: false } });
  // Then: the visible failure names the phase and retryability without inventing a cause.
  expect(failures[0]?.message).toContain('reading the streaming response from the Pi model connection');
  expect(failures[0]?.message).toContain('Pi did not provide a socket cause');
  expect(failures[0]?.retryable).toBe(true);
});

test('stream diagnostics omit private text even when a nested cause contains credentials', () => {
  // Given: a provider error embeds a token and query string in an inner exception.
  const privateUrl = 'https://private.example/path?token=secret-value';
  const error = new TypeError('terminated', { cause: Object.assign(new Error(`other side closed ${privateUrl}`), {
    code: 'UND_ERR_SOCKET', syscall: 'read', authorization: 'Bearer secret-value',
  }) });
  // When: a run failure is formatted at the trust boundary.
  const text = formatStreamFailure(error, 'reading', 'workspace.example');
  // Then: the transport code and phase survive without forwarding arbitrary provider text.
  expect(text).toContain('UND_ERR_SOCKET');
  expect(text).toContain('reading the streaming response');
  expect(text).not.toContain(privateUrl);
  expect(text).not.toContain('secret-value');
});

test('reports the cause when upstream closes during a streaming response', async () => {
  // Given: a real HTTP server that starts a streaming response then drops its socket.
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', () => response.socket?.destroy());
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const direct = await fetch(`http://127.0.0.1:${address.port}/stream`);
  const observed = await direct.text().catch((error: unknown) => error);
  if (!(observed instanceof Error)) throw new Error('Expected broken response');
  expect(observed.message).toBe('terminated');
  expect(observed.cause).toMatchObject({ code: 'UND_ERR_SOCKET', message: 'other side closed' });
  const relay = await createDatabricksRelay({
    runtime: runtimeFixture('openai-completions'),
    fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}/stream`, init),
  });
  try {
    // When: Pi's relay request consumes the interrupted upstream body.
    const response = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.text();
    // Then: the failure tells the user which phase and socket cause failed.
    expect(body).toContain('Connection closed while reading the streaming response');
    expect(body).toMatch(/other side closed|UND_ERR_SOCKET/);
    expect(body).toContain('Retryable');
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
