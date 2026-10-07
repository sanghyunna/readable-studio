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

test('persistent HTTP 400 surfaces only after all three retries', async () => {
  let attempts = 0;
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => {
    attempts++; return Response.json({ message: 'temporary failure' }, { status: 400 });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
    expect(response.status).toBe(400); expect(attempts).toBe(4);
    expect(await response.json()).toMatchObject({ error: { upstreamStatus: 400, reason: 'bad-request' } });
  } finally { await relay.close(); }
});

for (const status of [400, 429, 503]) {
  test(`transient HTTP ${status} is retried with 1s/2s/4s bounded backoff`, async () => {
    const { setTimeout } = await import('node:timers/promises'); vi.mocked(setTimeout).mockClear();
    let attempts = 0;
    const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => {
      attempts++; return attempts <= 3 ? Response.json({ error: { message: 'temporary failure' } }, { status }) : Response.json(success);
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
      expect(response.status).toBe(200); expect(attempts).toBe(4);
      expect(vi.mocked(setTimeout).mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000]);
    } finally { await relay.close(); }
  });
}
