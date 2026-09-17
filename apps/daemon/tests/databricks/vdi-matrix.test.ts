import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { createDatabricksService } from '../../src/databricks/service.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { messagesRequest } from '../../src/databricks/messages.js';
import { fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';
import { runtimeFixture } from './runtime-fixture.js';
import { fixture } from './fixtures/vdi-matrix.js';
const messagesPath = '/ai-gateway/anthropic/v1/messages';
const tools = [{ type: 'function', function: { name: 'probe', strict: true, parameters: {
  type: 'object', additionalProperties: false, properties: {
    nested: { type: 'object', strict: true, additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    additionalProperties: { type: 'string' }, strict: { type: 'boolean' },
  }, required: ['nested'],
} } }];

for (const kind of ['serving-endpoint', 'uc-model-service'] as const) {
  test(`routes and runs with effort when ${kind} metadata returns 404`, async () => {
    // Given: the corporate model is a gateway name, not a serving endpoint.
    const root = await mkdtemp(join(tmpdir(), 'vdi-matrix-'));
    const routes: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      routes.push(path);
      if (init?.method !== 'POST') return Response.json(fixture.metadata404, { status: 404 });
      const body = JSON.parse(String(init.body));
      if (path !== messagesPath || body.output_config?.effort !== 'high') return Response.json(fixture.rejected, { status: 400 });
      return Response.json(fixture.messages);
    };
    const makeService = () => createDatabricksService({ dataRoot: root, now: () => fixtureNow,
      clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture.exe' },
      resolveResource: async () => fixture.model, fetch: transport });
    try {
      const service = makeService();
      const profile = (await service.probe()).profiles[0];
      expect(profile).toBeDefined();
      if (!profile) throw new Error('Missing fixture profile');
      // When: lookup, registration and a restarted runtime drive the real relay.
      const found = await service.lookup({ profileId: profile.id, resourceId: 'fixture', kind });
      const enabled = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
      const runtime = await makeService().resolveRuntime(enabled.appModelId);
      const relay = await createDatabricksRelay({ runtime, fetch: transport });
      try {
        const result = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias,
            messages: [{ role: 'user', content: 'OK' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }) });
        // Then: metadata absence does not prevent a working, effort-bearing run.
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ type: 'message', content: fixture.messages.content });
        expect(runtime.api).toBe('anthropic-messages');
        expect(runtime.reasoningOptions).toContain('high');
        expect(routes).toEqual([expect.stringContaining('/api/'), messagesPath]);
      } finally { await relay.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const surface of ['mlflow', 'openai']) {
  for (const field of ['parallel_tool_calls', 'reasoning_effort', 'schema']) {
    test(`omits rejected ${field} when sending ${surface} Chat`, async () => {
      // Given: Responses is unavailable and Chat accepts only the measured shape.
      const runtime = runtimeFixture('openai-completions');
      runtime.baseUrl = `https://workspace.example/ai-gateway/${surface}/v1`;
      runtime.wireCapabilities = { responsesUnsupported: true, chatTokensField: 'max_completion_tokens', requiredOutputBudget: false, omittedFields: [] };
      const sent: Record<string, unknown>[] = [];
      const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)); sent.push(body);
        return Response.json(fixture.chat);
      } });
      try {
        // When: a caller supplies a rejected field or a strict tool schema.
        const result = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [],
            ...(field === 'schema' ? { tools } : { [field]: field === 'reasoning_effort' ? 'none' : false }) }) });
        await result.text();
        // Then: only compatible Chat wire fields are emitted; property names survive.
        expect(result.status).toBe(200);
        expect(sent).toHaveLength(1);
        if (field === 'schema') expect(sent[0]?.tools).toEqual([{ type: 'function', function: { name: 'probe', parameters: {
          type: 'object', properties: { nested: { type: 'object', properties: { ok: { type: 'boolean' } } },
            additionalProperties: { type: 'string' }, strict: { type: 'boolean' } }, required: ['nested'],
        } } }]);
        else expect(sent[0]).not.toHaveProperty(field);
      } finally { await relay.close(); }
    });
  }
}

for (const withTools of [false, true]) test(`uses Messages output_config when corporate Chat requests effort (tools=${withTools})`, async () => {
  // Given: the measured model rejects Chat effort and every Responses variant.
  const runtime = runtimeFixture('openai-completions'); runtime.model = fixture.model;
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname; const body = JSON.parse(String(init?.body)); sent.push({ path, body });
    return path === messagesPath ? Response.json(fixture.messages) : Response.json(fixture.rejected, { status: 400 });
  } });
  try {
    // When: the Chat-configured child requests a real effort level.
    const result = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [],
        reasoning_effort: 'high', ...(withTools ? { tools } : {}) }) });
    // Then: effort is preserved on the proven surface, never sent to a dead route.
    expect(result.status).toBe(200); await result.text();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: messagesPath, body: { output_config: { effort: 'high' }, thinking: { type: 'adaptive' } } });
    expect(sent[0]?.body).not.toHaveProperty('reasoning_effort');
  } finally { await relay.close(); }
});

for (const encoding of [{ output_config: { effort: 'high' }, thinking: { type: 'adaptive' } },
  { thinking: { type: 'enabled', budget_tokens: 2048 } }]) {
  test(`preserves ${JSON.stringify(encoding)} when adapting Chat to Messages`, () => {
    // Given / When: explicit Messages effort accompanies a Chat-shaped history.
    const wire = messagesRequest({ messages: [], ...encoding });
    // Then: neither supported encoding is lost by adaptation.
    expect(wire).toMatchObject(encoding);
  });
}

for (const field of ['max_completion_tokens', 'stream_options']) test(`omits ${field} when forwarding native Messages`, async () => {
  // Given: native Messages rejects OpenAI-only fields.
  const runtime = runtimeFixture(); const sent: Record<string, unknown>[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (_input, init) => {
    sent.push(JSON.parse(String(init?.body))); return Response.json(fixture.messages);
  } });
  try {
    // When: native Messages includes an OpenAI field plus explicit thinking budget.
    const result = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [],
        thinking: { type: 'enabled', budget_tokens: 2048 }, [field]: field === 'stream_options' ? {} : 4096 }) });
    await result.text();
    // Then: effort survives while the rejected field does not.
    expect(result.status).toBe(200); expect(sent[0]).not.toHaveProperty(field);
    expect(sent[0]?.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  } finally { await relay.close(); }
});
