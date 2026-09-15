import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { renderDatabricksPiProvider } from '../../src/runtimes/pi-databricks.js';
import { fixtureCliRunner, fixtureNow, upstreamHost } from './pi-turn-fixture.js';

const resource = { kind: 'serving-endpoint' as const, name: 'databricks-gpt-oss-120b',
  metadata: { task: 'llm/v1/chat', endpoint_type: 'FOUNDATION_MODEL_API',
    config: { served_entities: [{ name: 'endpoint-alias', type: 'FOUNDATION_MODEL',
      foundation_model: { name: 'system.ai.gpt-oss-120b' } }] } } };
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const completion = { choices: [{ message: { content: 'RECOVERED' }, finish_reason: 'stop' }] };

for (const [field, ceiling] of [['max_tokens', 25000], ['max_completion_tokens', 25000], ['max_tokens', 20000]] as const) {
  test(`gpt-oss ${field}: learns ${ceiling} from actual invocation, persists and clamps the next turn`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oss-ceiling-'));
    try {
      const entry = normalizeResource('secret', 'profile', resource);
      expect(entry.endpoint.capabilities.maxTokens).toBe(25000);
      expect(entry.endpoint.reasoningOptions?.map(option => option.id)).toEqual(efforts);
      entry.endpoint.enabled = true;
      // Reproduce a registration persisted with the old vendor-derived table.
      entry.endpoint.capabilities.maxTokens = 131072;
      await new DatabricksStore(root).update(generation => {
        generation.entries = [entry];
        generation.bindings = [{ id: 'profile', profileName: 'Fixture profile with spaces', host: upstreamHost, isDefault: true }];
      });
      const requests: Record<string, unknown>[] = [];
      for (let turn = 0; turn < 2; turn++) {
        const service = createDatabricksService({ dataRoot: root, now: () => fixtureNow,
          clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'C:\\fixture\\databricks.exe' } });
        const runtime = await service.resolveRuntime(entry.endpoint.appModelId!);
        if (turn === 1) {
          expect(runtime.capabilities).toMatchObject({ maxTokens: ceiling, limitSources: { maxTokens: 'endpoint' } });
          expect(runtime.wireCapabilities?.outputLimit).toBe(ceiling);
        }
        const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
          expect(new URL(String(input)).pathname).toBe('/serving-endpoints/databricks-gpt-oss-120b/invocations');
          const body = JSON.parse(String(init?.body)); requests.push(body);
          expect(body.reasoning_effort).toBe('high');
          expect(body.model).toBeUndefined();
          if (body.max_completion_tokens !== undefined) return Response.json({ message: 'json: unknown field "max_completion_tokens"' }, { status: 400 });
          if (body.max_tokens > ceiling) return Response.json({ error_code: 'BAD_REQUEST', message: `max_new_tokens ${body.max_tokens} cannot be greater than max_output_tokens ${ceiling}.` }, { status: 400 });
          return Response.json(completion);
        } });
        try {
          for (const effort of efforts) {
            const config = renderDatabricksPiProvider(runtime, relay, effort);
            expect(config.settings.defaultThinkingLevel).toBe(effort);
            expect(config.models.providers.databricks.models[0]!.thinkingLevelMap[effort]).toBe(effort);
            if (turn === 1) expect(config.models.providers.databricks.models[0]!.maxTokens).toBe(ceiling);
          }
          const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
            headers: { authorization: `Bearer ${relay.capabilityKey}` },
            body: JSON.stringify({ model: relay.modelAlias, messages: [], [field]: 131072, reasoning_effort: 'high' }) });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject(completion);
        } finally { await relay.close(); }
      }
      expect(requests.filter(body => body.max_tokens !== undefined).map(body => body.max_tokens)).toEqual([131072, ceiling, ceiling]);
      expect(requests.filter(body => body.max_completion_tokens !== undefined)).toHaveLength(field === 'max_completion_tokens' ? 1 : 0);
      const saved = (await new DatabricksStore(root).read()).entries[0]!;
      const rescanned = normalizeResource('secret', 'profile', resource, saved);
      expect(rescanned.endpoint.capabilities).toMatchObject({ maxTokens: ceiling, limitSources: { maxTokens: 'endpoint' } });
      expect(normalizeResource('secret', 'profile', { ...resource, metadata: { ...resource.metadata, etag: 'changed' } }, saved)
        .endpoint.capabilities).toMatchObject({ maxTokens: 25000, limitSources: { maxTokens: 'model-table' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
