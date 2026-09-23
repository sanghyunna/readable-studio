import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

const names = ['read', 'powershell', 'edit', 'write'] as const;
const parameters = {
  type: 'object', strict: true, additionalProperties: false,
  properties: {
    path: { type: 'string' },
    nested: { type: 'array', items: { type: 'object', strict: false, additionalProperties: false,
      properties: { value: { anyOf: [{ type: 'string', strict: true }, { type: 'null' }] } } } },
  },
  required: ['path'],
  $defs: { entry: { type: 'object', additionalProperties: { type: 'string' }, strict: false } },
};
const cleanParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    nested: { type: 'array', items: { type: 'object',
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } },
  },
  required: ['path'],
  $defs: { entry: { type: 'object' } },
};

for (const surface of ['Responses', 'Chat'] as const) {
  test(`strips rejected keywords from every outgoing tool when ${surface} receives strict tools`, async () => {
    // Given: all four managed tools carry strict (including false) and nested rejected keywords.
    const runtime = runtimeFixture('openai-completions');
    if (surface === 'Chat') runtime.wireCapabilities = {
      responsesUnsupported: true, chatTokensField: 'max_completion_tokens', requiredOutputBudget: false, omittedFields: [],
    };
    const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      sent.push({ path: new URL(String(url)).pathname, body });
      return Response.json(surface === 'Responses'
        ? { id: 'response_tools', status: 'completed', output: [] }
        : { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
    } });
    try {
      // When: the real HTTP relay serializes the complete tools array for upstream.
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias,
          messages: [], tools: names.map((name, index) => ({ type: 'function', function: {
            name, description: `${name} tool`, strict: index % 2 === 0, parameters,
          } })) }) });
      await response.text();
      // Then: every tool keeps its identity/schema semantics but emits neither rejected keyword.
      expect(response.status).toBe(200);
      const expectedTools = names.map(name => {
        const fn = { name, description: `${name} tool`, parameters: cleanParameters };
        return surface === 'Responses' ? { type: 'function', ...fn } : { type: 'function', function: fn };
      });
      expect(sent).toEqual([{ path: `/ai-gateway/openai/v1/${surface === 'Responses' ? 'responses' : 'chat/completions'}`,
        body: { model: runtime.model, tools: expectedTools,
          ...(surface === 'Responses' ? { store: false, input: [] } : { messages: [] }) } }]);
      expect(JSON.stringify(sent)).not.toContain('"strict":');
      expect(JSON.stringify(sent)).not.toContain('"additionalProperties":');
    } finally { await relay.close(); }
  });

  test(`preserves user property names and literal data when ${surface} sanitizes schemas`, async () => {
    // Given: rejected keyword spellings are valid user property names and literal values.
    const runtime = runtimeFixture('openai-completions');
    if (surface === 'Chat') runtime.wireCapabilities = {
      responsesUnsupported: true, chatTokensField: 'max_completion_tokens', requiredOutputBudget: false, omittedFields: [],
    };
    const literals = { strict: true, additionalProperties: false };
    const schema = { type: 'object', properties: { strict: { type: 'boolean' }, additionalProperties: {
      type: 'object', enum: [literals], const: literals, default: literals, examples: [literals],
    } } };
    const sent: unknown[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      sent.push(body);
      return Response.json(surface === 'Responses'
        ? { id: 'response_literals', status: 'completed', output: [] }
        : { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
    } });
    try {
      // When: the schema crosses the real serialization boundary.
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias,
          messages: [], tools: [{ type: 'function', function: { name: 'read', strict: false,
            parameters: { ...schema, strict: true, additionalProperties: false } } }] }) });
      await response.text();
      // Then: only schema keywords disappear; user data remains byte-equivalent after JSON parsing.
      expect(response.status).toBe(200);
      const fn = { name: 'read', parameters: schema };
      expect(sent).toEqual([{ model: runtime.model,
        tools: [surface === 'Responses' ? { type: 'function', ...fn } : { type: 'function', function: fn }],
        ...(surface === 'Responses' ? { store: false, input: [] } : { messages: [] }) }]);
    } finally { await relay.close(); }
  });
}
