import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

for (const native of [false, true]) for (const [status, message] of [
  [422, 'Unsupported parameter: reasoning.summary; anthropic-beta'],
  [500, 'Fixture protocol assertion failed'],
  [502, 'Internal server error'],
] as const) test(`optional reasoning feature retries without changing effort and remembers rejection (${native}, ${status})`, async () => {
  const runtime = Object.assign(runtimeFixture(native ? 'anthropic-messages' : 'openai-completions'), {
    model: `rejection-${native}-${status}`, servedModelName: native ? 'claude-sonnet-4-5' : 'gpt-5.6-luna',
  });
  const features: boolean[] = [];
  const upstream: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const feature = native ? new Headers(init?.headers).has('anthropic-beta') : body.reasoning.summary === 'auto';
    features.push(feature);
    expect(native ? body.output_config.effort : body.reasoning.effort).toBe('high');
    return feature ? Response.json({ error: { message } }, { status }) : Response.json(native
      ? { type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
      : { id: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] });
  };
  for (let turn = 0; turn < 2; turn++) {
    const relay = await createDatabricksRelay({ runtime, fetch: upstream });
    try {
      const response = await fetch(`${relay.baseUrl}${native ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [], ...(native
          ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
          : { reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] }) }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('OK');
    } finally { await relay.close(); }
  }
  expect(features).toEqual([true, false, false]);
});

for (const native of [false, true]) test(`successful optional feature makes exactly one request (${native})`, async () => {
  const runtime = Object.assign(runtimeFixture(native ? 'anthropic-messages' : 'openai-completions'), {
    model: `successful-feature-${native}`, servedModelName: native ? 'claude-sonnet-4-5' : 'gpt-5.6-luna',
  });
  let calls = 0;
  const relay = await createDatabricksRelay({ runtime, fetch: async () => {
    calls++;
    return Response.json(native ? { type: 'message', content: [], stop_reason: 'end_turn' }
      : { id: 'response', status: 'completed', output: [] });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}${native ? '/v1/messages' : '/chat/completions'}`, {
      method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [], ...(native
        ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
        : { reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] }) }),
    });
    expect(response.status).toBe(200); await response.text(); expect(calls).toBe(1);
  } finally { await relay.close(); }
});
