import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
const refused = () => Response.json({ message: 'rejected parameter: tools' }, { status: 400 });
const unavailable = () => Response.json({ message: 'Responses API passthrough is not supported for model fixture.' }, { status: 400 });
const success = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ROUTE_OK' }] }] });

test('Responses unavailable -> Chat tools rejection -> alternate Responses retains tools and succeeds', async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.baseUrl = 'https://workspace.example/serving-endpoints';
  const routes: string[] = [];
  runtime.onCapabilitiesLearned = async learned => { runtime.wireCapabilities = learned; };
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const route = new URL(String(input)).pathname; routes.push(route);
    expect(JSON.parse(String(init?.body)).tools).toHaveLength(1);
    if (route === '/serving-endpoints/responses') return unavailable();
    if (route.endsWith('/chat/completions') || route === '/ai-gateway/anthropic/v1/messages') return refused();
    if (route === '/ai-gateway/openai/v1/responses') return unavailable();
    return success();
  } });
  try {
    const result = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools }) });
    expect(result.status).toBe(200); expect(await result.text()).toContain('ROUTE_OK');
    expect(routes).toEqual(['/serving-endpoints/responses', '/serving-endpoints/chat/completions', '/ai-gateway/anthropic/v1/messages', '/ai-gateway/openai/v1/responses', '/ai-gateway/codex/v1/responses']);
    expect(runtime.wireCapabilities).toMatchObject({ responsesUnsupported: false, responsesPath: '/ai-gateway/codex/v1/responses', tools: 'supported' });
    const restarted = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/ai-gateway/codex/v1/responses');
      expect(JSON.parse(String(init?.body)).tools).toHaveLength(1);
      return success();
    } });
    try {
      const next = await fetch(`${restarted.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${restarted.capabilityKey}` }, body: JSON.stringify({ model: restarted.modelAlias, messages: [], tools }) });
      expect(next.status).toBe(200); await next.text();
    } finally { await restarted.close(); }
  } finally { await relay.close(); }
});

test('unrelated Responses validation is not evidence for a Chat downgrade or tool-free mode', async () => {
  const routes: string[] = [];
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async input => {
    routes.push(new URL(String(input)).pathname);
    return Response.json({ message: 'Missing unrelated input field' }, { status: 400 });
  } });
  try {
    const result = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools }) });
    expect(result.status).toBe(400); await result.text(); expect(routes).toHaveLength(1);
  } finally { await relay.close(); }
});
