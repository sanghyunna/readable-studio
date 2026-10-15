import { expect, test, vi } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { namedRequest } from '../../src/databricks/named-profile.js';
import { runtimeFixture } from './runtime-fixture.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
const profile = { version: 1 as const, api: 'openai-completions' as const, kind: 'serving-endpoint' as const,
  tokenField: 'max_tokens' as const, testedBudget: 256, tools: 'disabled' as const, reasoning: [], checkedAt: '2026-10-07' };
const success = { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };

test('named registration does not impose its connectivity probe budget on real turns', () => {
  expect(namedRequest(profile, 'endpoint', { messages: [], max_completion_tokens: 32768 }).max_tokens).toBe(32768);
  expect(namedRequest(profile, 'endpoint', { messages: [] }).max_tokens).toBe(256);
});

for (const named of [false, true]) {
  test(`explicit output budget survives unknown limits and stale 8192 child budget (named=${named})`, async () => {
    const runtime = runtimeFixture('openai-completions');
    runtime.capabilities.maxTokens = null;
    if (named) runtime.wireCapabilities = { namedProfile: profile, responsesUnsupported: false, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [] };
    let wire: Record<string, unknown> = {};
    const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
      wire = JSON.parse(String(init?.body)); return Response.json(success);
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [], max_completion_tokens: 8192 }) });
      expect(response.status).toBe(200);
      expect(wire[named ? 'max_tokens' : 'max_completion_tokens']).toBeGreaterThan(8192);
    } finally { await relay.close(); }
  });
}

for (const named of [false, true]) {
  test(`too-high budget 400 steps down once then succeeds (named=${named})`, async () => {
    const runtime = runtimeFixture('openai-completions'); runtime.capabilities.maxTokens = 32768;
    if (named) runtime.wireCapabilities = { namedProfile: profile, responsesUnsupported: false, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [] };
    const budgets: number[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)); budgets.push(wire.max_tokens ?? wire.max_completion_tokens);
      return budgets.length === 1 ? Response.json({ error: { message: 'max_tokens must be at most 16384' } }, { status: 400 }) : Response.json(success);
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [], max_completion_tokens: 32768 }) });
      expect(response.status).toBe(200); expect(budgets).toEqual([32768, 16384]);
    } finally { await relay.close(); }
  });
}

test('persistent HTTP 400 fails without generic retries', async () => {
  let attempts = 0;
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => {
    attempts++; return Response.json({ message: 'temporary failure' }, { status: 400 });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
    expect(response.status).toBe(400); expect(attempts).toBe(1);
    expect(await response.json()).toMatchObject({ error: { upstreamStatus: 400, reason: 'bad-request' } });
  } finally { await relay.close(); }
});

for (const status of [429, 500, 502, 503, 504, 599]) {
  test(`transient HTTP ${status} is retried ten times with constant 5s backoff`, async () => {
    const { setTimeout } = await import('node:timers/promises'); vi.mocked(setTimeout).mockClear();
    let attempts = 0;
    const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => {
      attempts++; return attempts <= 10 ? Response.json({ error: { message: 'temporary failure' } }, { status }) : Response.json(success);
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
      expect(response.status).toBe(200); expect(attempts).toBe(11);
      expect(vi.mocked(setTimeout).mock.calls.map(call => call[0])).toEqual(Array(10).fill(5000));
    } finally { await relay.close(); }
  });
}

async function retryRequest(fetchUpstream: typeof fetch, extra: Partial<Parameters<typeof createDatabricksRelay>[0]> = {}) {
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: fetchUpstream, ...extra });
  const response = fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${relay.capabilityKey}` },
    body: JSON.stringify({ model: relay.modelAlias, messages: [], stream: true }) });
  return { relay, response };
}

test('seven 503s recover on the eighth attempt and publish every retry before waiting', async () => {
  let attempts = 0;
  const progress: number[] = [];
  const { relay, response } = await retryRequest(async () => ++attempts <= 7
    ? Response.json({}, { status: 503 }) : Response.json(success), {
    onRetry: value => { progress.push(value.attempt); expect(value.maxRetries).toBe(10); expect(value.delayMs).toBe(5000); },
  });
  try { expect((await response).status).toBe(200); expect(attempts).toBe(8); expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]); }
  finally { await relay.close(); }
});

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']) {
  test(`${code} before headers recovers after three transport failures`, async () => {
    let attempts = 0;
    const { relay, response } = await retryRequest(async () => {
      if (++attempts <= 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection failed'), { code }) });
      return Response.json(success);
    });
    try { expect((await response).status).toBe(200); expect(attempts).toBe(4); }
    finally { await relay.close(); }
  });
}

for (const message of ['socket hang up', 'terminated']) {
  test(`${message} before headers is retried`, async () => {
    let attempts = 0;
    const { relay, response } = await retryRequest(async () => {
      if (++attempts === 1) throw new Error(message);
      return Response.json(success);
    });
    try { expect((await response).status).toBe(200); expect(attempts).toBe(2); }
    finally { await relay.close(); }
  });
}

test('eleven consecutive 503s exhaust the retry budget with an upstream failure', async () => {
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => { attempts++; return Response.json({}, { status: 503 }); });
  try {
    const result = await response;
    expect(result.status).toBe(503); expect(attempts).toBe(11);
    const body = await result.json();
    expect(body).toMatchObject({ error: { reason: 'upstream-server', upstreamStatus: 503, retryable: true } });
    expect(body).toMatchObject({ error: { message: expect.stringContaining('The Databricks server is not responding.') } });
  } finally { await relay.close(); }
});

test('exhausted transport failures report a server outage, not local configuration', async () => {
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => {
    attempts++; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  try {
    const body = await (await response).json();
    expect(attempts).toBe(11);
    expect(body).toMatchObject({ error: { reason: 'transport', upstreamStatus: null, retryable: true,
      message: expect.stringContaining('The Databricks server is not responding.') } });
    expect(JSON.stringify(body)).not.toContain('configuration');
  } finally { await relay.close(); }
});

for (const status of [400, 401, 403, 404, 413, 422]) {
  test(`HTTP ${status} fails after one attempt`, async () => {
    let attempts = 0;
    const { relay, response } = await retryRequest(async () => { attempts++; return Response.json({}, { status }); });
    try { expect((await response).status).toBe(status); expect(attempts).toBe(1); }
    finally { await relay.close(); }
  });
}

for (const [header, expected] of [['20', 20000], ['1', 5000], ['61', 5000], ['invalid', 5000]] as const) {
  test(`Retry-After ${header} requests ${expected}ms`, async () => {
    const { setTimeout } = await import('node:timers/promises'); vi.mocked(setTimeout).mockClear();
    let attempts = 0;
    const { relay, response } = await retryRequest(async () => ++attempts === 1
      ? Response.json({}, { status: 503, headers: { 'retry-after': header } }) : Response.json(success));
    try {
      expect((await response).status).toBe(200);
      expect(vi.mocked(setTimeout).mock.calls.map(call => call[0])).toEqual([expected]);
    } finally { await relay.close(); }
  });
}

test('closing the relay cancels the active wait without another request', async () => {
  let waiting!: () => void;
  const enteredWait = new Promise<void>(resolve => { waiting = resolve; });
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => { attempts++; return Response.json({}, { status: 503 }); }, {
    delay: (_ms, _value, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      waiting();
    }),
  });
  const settled = response.catch(() => null);
  await enteredWait;
  await relay.close();
  await settled;
  expect(attempts).toBe(1);
});

test('HTTP-date Retry-After longer than five seconds is honored', async () => {
  const { setTimeout } = await import('node:timers/promises'); vi.mocked(setTimeout).mockClear();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T00:00:00Z'));
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => ++attempts === 1
    ? Response.json({}, { status: 503, headers: { 'retry-after': 'Wed, 14 Oct 2026 00:00:20 GMT' } }) : Response.json(success));
  try {
    expect((await response).status).toBe(200);
    expect(vi.mocked(setTimeout).mock.calls.map(call => call[0])).toEqual([20000]);
  } finally { now.mockRestore(); await relay.close(); }
});

test('user request abort cancels the wait before another upstream request', async () => {
  let waiting!: () => void;
  let cancelled!: () => void;
  const enteredWait = new Promise<void>(resolve => { waiting = resolve; });
  const cancelledWait = new Promise<void>(resolve => { cancelled = resolve; });
  let attempts = 0;
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'),
    fetch: async () => { attempts++; return Response.json({}, { status: 503 }); },
    delay: (_ms, _value, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { cancelled(); reject(new Error('aborted')); }, { once: true });
      waiting();
    }),
  });
  const controller = new AbortController();
  const request = fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
  const settled = request.catch(() => null);
  try {
    await enteredWait;
    controller.abort();
    await cancelledWait;
    await settled;
    expect(attempts).toBe(1);
  } finally { await relay.close(); }
});

test('mid-stream failure never re-sends the inference request', async () => {
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => {
    attempts++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      },
      pull(controller) { controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try { await (await response).text(); expect(attempts).toBe(1); }
  finally { await relay.close(); }
});

test('local runtime exceptions fail without retry', async () => {
  let attempts = 0;
  const { relay, response } = await retryRequest(async () => { attempts++; throw new Error('Invalid local configuration'); });
  try { expect((await response).status).toBe(502); expect(attempts).toBe(1); }
  finally { await relay.close(); }
});
