import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

const tools = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
const completion = { id: 'gate', object: 'chat.completion', choices: [
  { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
] };

for (const status of [200, 400]) test(`preserves GPT-OSS tools and high effort when upstream returns ${status}`, async () => {
  // Given: the exact final-gate identity, without learned capabilities.
  // Archived chat-tools-effort.json proves this field/surface combination;
  // corporate gateways may instead reject it, which must remain a failure.
  const runtime = runtimeFixture('openai-completions');
  runtime.model = 'system.ai.gpt-oss-120b';
  const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    sent.push({ path: new URL(String(input)).pathname, body });
    return Response.json(status === 200 ? completion : {
      message: `reasoning_effort is not supported for ${runtime.model} at ${runtime.baseUrl} ${runtime.apiKey}`,
    }, { status });
  } });
  try {
    // When: the gate-review request passes through the production HTTP relay.
    const response = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [{ role: 'user', content: 'OK' }],
        reasoning_effort: 'high', tools }),
    });
    const result: unknown = await response.json();
    // Then: success retains effort, rejection never retries without it.
    expect(response.status).toBe(status);
    expect(sent).toEqual([{ path: '/ai-gateway/openai/v1/chat/completions', body: {
      model: runtime.model, messages: [{ role: 'user', content: 'OK' }], reasoning_effort: 'high', tools,
    } }]);
    if (status === 400) {
      expect(result).toMatchObject({ error: { reason: 'bad-request', retryable: false, upstreamStatus: 400 } });
      for (const secret of [runtime.apiKey, runtime.model, new URL(runtime.baseUrl).hostname]) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    } else expect(result).toMatchObject(completion);
  } finally { await relay.close(); }
});

for (const effort of ['none', 'off']) test(`uses measured Chat when GPT-OSS effort is ${effort}`, async () => {
  // Given: inactive effort may use the corporate Chat field-stripping recipe.
  const runtime = runtimeFixture('openai-completions');
  runtime.model = 'system.ai.gpt-oss-120b';
  const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    sent.push({ path: new URL(String(input)).pathname, body });
    return Response.json(completion);
  } });
  try {
    // When: the caller explicitly disables effort.
    const response = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [], tools, reasoning_effort: effort }),
    });
    await response.text();
    // Then: measured Chat succeeds without sending its rejected inactive field.
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ path: '/ai-gateway/openai/v1/chat/completions', body: {
      model: runtime.model, messages: [], tools,
    } }]);
  } finally { await relay.close(); }
});
