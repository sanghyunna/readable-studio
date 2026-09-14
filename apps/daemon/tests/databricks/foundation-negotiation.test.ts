import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { resolveDatabricksCapabilities } from '../../src/databricks/capabilities.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { runtimeFixture } from './runtime-fixture.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/foundation-claude.json', import.meta.url), 'utf8'));
const completion = { choices: [{ message: { content: 'RECOVERED' }, finish_reason: 'stop' }] };
const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];

test('task-only corporate foundation fixture resolves prefixed family without guessing native transport', () => {
  const { endpoint, basePath } = normalizeResource('secret', 'profile', fixture);
  expect(endpoint.api).toBe('openai-completions');
  expect(basePath).toBe('/serving-endpoints');
  expect(endpoint.protocolEvidence?.reason).toBe('chat-task');
  expect(endpoint.capabilities).toMatchObject({ contextWindow: 1000000, maxTokens: 128000 });
  const native = normalizeResource('secret', 'profile', { ...fixture, metadata: { ...fixture.metadata,
    supported_api_types: ['anthropic/v1/messages', 'mlflow/v1/chat/completions'] } });
  expect(native.endpoint.api).toBe('anthropic-messages');
  expect(native.basePath).toBe('/ai-gateway/anthropic');
});

for (const name of ['databricks-claude-sonnet-5', 'system.ai.databricks-claude-sonnet-5', 'anthropic/claude-sonnet-5-20260901']) test(`known normalized identity ${name}`, () => {
  expect(resolveDatabricksCapabilities({}, [{ name, metadata: {} }]).maxTokens).toBe(128000);
});
for (const name of ['databricks-claude-sonnet-500', 'custom-claude-sonnet-5', 'databricks-claude-sonnet-5-custom', 'databricks-mystery']) test(`unknown identity ${name}`, () => {
  expect(resolveDatabricksCapabilities({}, [{ name, metadata: {} }]).maxTokens).toBeNull();
});

for (const api of ['anthropic-messages', 'openai-completions'] as const) test(`${api}: lower ceiling retries once and is cached`, async () => {
  const runtime = runtimeFixture(api);
  runtime.capabilities = normalizeResource('secret', 'profile', fixture).endpoint.capabilities;
  const field = api === 'anthropic-messages' ? 'max_tokens' : 'max_completion_tokens';
  const requests: Record<string, unknown>[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body[field] > 25000) return Response.json({ error: { message: `${field}: 128000 > 25000, which is the maximum allowed number of output tokens` } }, { status: 400 });
    return Response.json(completion);
  } });
  try {
    for (let round = 0; round < 2; round++) {
      const response = await fetch(`${relay.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [], [field]: 128000 }),
      });
      expect(response.status).toBe(200); await response.text();
    }
    expect(requests.map(body => body[field])).toEqual([128000, 25000, 25000]);
  } finally { await relay.close(); }
});

test('unknown Messages budget is omitted, required-field budget negotiated, then lower ceiling recovered', async () => {
  const runtime = runtimeFixture(); runtime.capabilities.maxTokens = null;
  const budgets: unknown[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); budgets.push(body.max_tokens);
    if (body.max_tokens === undefined) return Response.json({ error: { message: 'max_tokens: Field required' } }, { status: 400 });
    if (body.max_tokens > 2048) return Response.json({ error: { message: 'max_tokens must be less than or equal to 2048' } }, { status: 400 });
    return Response.json(completion);
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], max_tokens: 128000 }) });
    expect(response.status).toBe(200); await response.text();
    expect(budgets).toEqual([undefined, 4096, 2048]);
  } finally { await relay.close(); }
});

test('unknown optional field is dropped and the same correction is not repeated', async () => {
  const runtime = runtimeFixture(); let calls = 0;
  const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    if (calls > 1) expect(body.stream_options).toBeUndefined();
    return Response.json({ error: { message: 'json: unknown field "stream_options"' } }, { status: 400 });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], stream_options: {} }) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { reason: 'bad-request' } }); expect(calls).toBe(2);
  } finally { await relay.close(); }
});

test('unsupported combination follows explicit Responses remedy without dropping tools or effort', async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.wireCapabilities = { responsesUnsupported: true, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [] };
  const routes: string[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const route = new URL(String(input)).pathname; routes.push(route);
    if (!route.endsWith('/responses')) return Response.json({ message: "Function tools with reasoning_effort are not supported; use /v1/responses or set reasoning_effort to 'none'" }, { status: 400 });
    const body = JSON.parse(String(init?.body)); expect(body.reasoning.effort).toBe('high'); expect(body.tools).toHaveLength(1);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'RECOVERED' }] }] });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools, reasoning_effort: 'high' }) });
    expect(response.status).toBe(200); await response.text(); expect(routes.map(route => route.split('/').at(-1))).toEqual(['completions', 'responses']);
  } finally { await relay.close(); }
});

test('learned ceiling survives catalogue restart and next relay sends it directly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'foundation-learned-'));
  try {
    const entry = normalizeResource('secret', 'profile', fixture);
    const store = new DatabricksStore(root); await store.update(generation => { generation.entries = [entry]; });
    const budgets: unknown[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const restarted = new DatabricksStore(root);
      const saved = (await restarted.read()).entries[0]!;
      const runtime = runtimeFixture('openai-completions'); runtime.capabilities = saved.endpoint.capabilities;
      if (saved.wireCapabilities) runtime.wireCapabilities = saved.wireCapabilities;
      runtime.onCapabilitiesLearned = async learned => { await restarted.update(generation => { generation.entries[0]!.wireCapabilities = learned; }); };
      const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)); budgets.push(body.max_completion_tokens);
        return body.max_completion_tokens > 25000 ? Response.json({ message: 'max_new_tokens 128000 cannot be greater than max_output_tokens 25000' }, { status: 400 }) : Response.json(completion);
      } });
      try {
        const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], max_completion_tokens: 128000 }) });
        expect(response.status).toBe(200); await response.text();
      } finally { await relay.close(); }
    }
    expect(budgets).toEqual([128000, 25000, 25000]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
