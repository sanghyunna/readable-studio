import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { resolveDatabricksReasoningOptions } from '../../src/databricks/capabilities.js';
import { fixtureStream, protocolFixture, runtimeFixture } from './runtime-fixture.js';

for (const api of ['openai-completions', 'anthropic-messages'] as const) {
  test(`relay forwards the ${api} fixture with private credentials only upstream`, async () => {
    const runtime = runtimeFixture(api);
    const fixture = protocolFixture(api);
    let called = 0;
    const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
      called++;
      assert.equal(String(input), `${runtime.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${runtime.apiKey}`);
      assert.equal(new Headers(init?.headers).get('cookie'), null);
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), fixture.request.body);
      return new Response(JSON.stringify({ ...fixture.response.body,
        model: runtime.model, metadata: { echo: `${runtime.apiKey} ${runtime.model}` },
      }), { headers: { 'content-type': 'application/json', 'x-secret': runtime.apiKey, 'x-model': runtime.model } });
    } });
    try {
      const response = await fetch(`${relay.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}`, cookie: 'must-not-forward' },
        body: JSON.stringify({ ...fixture.request.body, model: relay.modelAlias }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(runtime.apiKey), false);
      assert.equal(body.includes(runtime.model), false);
      assert.equal(response.headers.get('x-secret'), null);
      assert.equal(response.headers.get('x-model'), null);
      assert.equal(JSON.parse(body).model, relay.modelAlias);
      assert.equal(called, 1);
    } finally { await relay.close(); }
  });

  test(`relay preserves ${api} tool-call ids and tool results`, async () => {
    const runtime = runtimeFixture(api);
    const id = 'call_original-Tool_ID:42';
    const content = api === 'anthropic-messages'
      ? [{ type: 'tool_use', id, name: 'read', input: { path: 'DESIGN.md' } }]
      : [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"DESIGN.md"}' } }];
    const messages = api === 'anthropic-messages'
      ? [{ role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'document' }] }]
      : [{ role: 'assistant', tool_calls: content }, { role: 'tool', tool_call_id: id, content: 'document' }];
    const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).messages, messages);
      return new Response(JSON.stringify(api === 'anthropic-messages'
        ? { type: 'message', model: runtime.model, content }
        : { model: runtime.model, choices: [{ message: { tool_calls: content } }] }));
    } });
    try {
      const response = await fetch(`${relay.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST', headers: { 'x-api-key': relay.capabilityKey }, body: JSON.stringify({ model: relay.modelAlias, messages }),
      });
      const rawBody: unknown = await response.json();
      assert.ok(rawBody !== null && typeof rawBody === 'object');
      const body = rawBody as {
        content: unknown;
        choices: [{ message: { tool_calls: unknown } }];
      };
      assert.deepEqual(api === 'anthropic-messages' ? body.content : body.choices[0].message.tool_calls, content);
    } finally { await relay.close(); }
  });
}

test('OpenAI function tools use Responses with every advertised effort; text-only and Anthropic stay unchanged', async () => {
  for (const api of ['openai-completions', 'anthropic-messages'] as const) {
    const runtime = runtimeFixture(api);
    const forwarded: Record<string, unknown>[] = [];
    const routes: string[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
      routes.push(String(input));
      forwarded.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(String(input).endsWith('/responses')
        ? { id: 'resp_test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
        : protocolFixture(api).response.body));
    } });
    const advertised = resolveDatabricksReasoningOptions(api, [{ name: api === 'openai-completions' ? 'gpt-5.6-luna' : 'claude-sonnet-5' }]);
    try {
      for (const effort of [undefined, ...advertised.map(({ id }) => id), 'none']) {
        for (const tools of [undefined, [], api === 'openai-completions'
          ? [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }]
          : [{ name: 'read', input_schema: { type: 'object', properties: {} } }]]) {
          const body = { ...protocolFixture(api).request.body, model: relay.modelAlias,
            ...(effort === undefined ? {} : { reasoning_effort: effort }),
            ...(tools === undefined ? {} : { tools }),
          };
          const response = await fetch(`${relay.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`, {
            method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify(body),
          });
          await response.text();
          assert.equal(response.status, 200);
          if (api === 'openai-completions' && tools?.length) {
            assert.equal(routes.at(-1), `${runtime.baseUrl}/responses`);
            const wire = forwarded.at(-1)!;
            assert.equal(wire.reasoning_effort, undefined);
            assert.deepEqual(wire.reasoning, effort === undefined ? undefined : { effort });
            assert.deepEqual(wire.input, body.messages);
            assert.equal(wire.store, false);
            assert.deepEqual(wire.tools, [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }]);
          } else {
            assert.equal(routes.at(-1), `${runtime.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`);
            assert.deepEqual(forwarded.at(-1), { ...body, model: runtime.model });
          }
        }
      }
      assert.equal(forwarded.length, (advertised.length + 2) * 3);
    } finally { await relay.close(); }
  }
});

test('relay rejects other capabilities, origins, paths and arbitrary models without contacting upstream', async () => {
  let calls = 0;
  const relay = await createDatabricksRelay({ runtime: runtimeFixture(), fetch: async () => { calls++; return new Response('{}'); } });
  try {
    for (const scenario of [
      { key: 'wrong', path: '/v1/messages', model: relay.modelAlias },
      { key: relay.capabilityKey, path: '/v1/messages', model: 'arbitrary.model' },
      { key: relay.capabilityKey, path: '/v1/messages?target=other', model: relay.modelAlias },
      { key: relay.capabilityKey, path: '/v1/messages', model: relay.modelAlias, origin: 'http://evil.example' },
    ]) {
      const response = await fetch(`${relay.baseUrl}${scenario.path}`, {
        method: 'POST', headers: { authorization: `Bearer ${scenario.key}`, ...(scenario.origin ? { origin: scenario.origin } : {}) },
        body: JSON.stringify({ model: scenario.model }),
      });
      assert.ok([400, 403].includes(response.status));
      await response.text();
    }
    assert.equal(calls, 0);
  } finally { await relay.close(); }
});

test('relay sanitizes both recorded HTTP 400 error bodies and thrown transport errors', async () => {
  const errors = JSON.parse(readFileSync(new URL('./fixtures/claude-errors.json', import.meta.url), 'utf8')) as Record<string, { status: number; body: unknown }>;
  const runtime = runtimeFixture();
  for (const fixture of [...Object.values(errors), null]) {
    const relay = await createDatabricksRelay({ runtime, fetch: async () => {
      if (!fixture) throw new Error(`${runtime.apiKey} ${runtime.model}`);
      return new Response(JSON.stringify(fixture.body), { status: fixture.status });
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias }) });
      assert.equal(response.status, fixture?.status ?? 502);
      const text = await response.text();
      assert.equal(text.includes(runtime.apiKey), false);
      assert.equal(text.includes(runtime.model), false);
      const error = JSON.parse(text).error;
      assert.equal(error.reason, fixture ? 'bad-request' : 'transport');
      assert.equal(error.upstreamStatus, fixture?.status ?? null);
      if (fixture) {
        const body = fixture.body as { details: Array<{ metadata: { upstream_body: string } }> };
        assert.equal(error.upstreamMessage, JSON.parse(body.details[0]!.metadata.upstream_body).error.message);
      }
    } finally { await relay.close(); }
  }
});

test('relay incrementally forwards split fixture frames without cloud identity, preserving text', async () => {
  const runtime = runtimeFixture();
  const source = fixtureStream(runtime.api).replace('claude-sonnet-5', runtime.model);
  const relay = await createDatabricksRelay({ runtime, fetch: async () => new Response(new ReadableStream({
    start(controller) {
      // Split every byte, including JSON strings: redaction must wait for complete frames.
      for (const byte of Buffer.from(source)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, stream: true }) });
    const text = await response.text();
    assert.equal(text.includes(runtime.model), false);
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map((event) => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(events.filter((event) => event.type === 'content_block_delta').map((event) => event.delta.text).join(''), 'OK');
  } finally { await relay.close(); }
});

test('relay preserves native streaming tool frames and sanitizes SSE error payloads', async () => {
  const runtime = runtimeFixture();
  const frame = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_original', name: 'read', input: {} } };
  const relay = await createDatabricksRelay({ runtime, fetch: async () => new Response(
    `event: content_block_start\ndata: ${JSON.stringify(frame)}\n\nevent: error\ndata: ${JSON.stringify({ type: 'error', message: `${runtime.apiKey} ${runtime.model}` })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ) });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, stream: true }) });
    const text = await response.text();
    assert.ok(text.includes(JSON.stringify(frame)));
    assert.equal(text.includes(runtime.apiKey), false);
    assert.equal(text.includes(runtime.model), false);
    assert.ok(text.includes('event: error'));
  } finally { await relay.close(); }
});

test('child cancellation aborts the exact active upstream request', async () => {
  const upstream = new EventEmitter();
  const deadline = AbortSignal.timeout(5000);
  const requested = once(upstream, 'request', { signal: deadline });
  const upstreamAborted = once(upstream, 'abort', { signal: deadline });
  const runtime = runtimeFixture();
  const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    signal.addEventListener('abort', () => upstream.emit('abort'), { once: true });
    upstream.emit('request', signal);
    await once(signal, 'abort', { signal: AbortSignal.timeout(5000) });
    throw new Error('cancelled');
  } });
  const controller = new AbortController();
  try {
    const pending = fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias }),
    });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    const [signal] = await requested;
    controller.abort();
    await rejected;
    await upstreamAborted;
    assert.equal(signal.aborted, true);
  } finally { controller.abort(); await relay.close(); }
});
