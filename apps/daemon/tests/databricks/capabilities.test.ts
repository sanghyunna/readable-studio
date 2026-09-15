import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { resolveDatabricksCapabilities } from '../../src/databricks/capabilities.js';

const claude = JSON.parse(await readFile(new URL('./fixtures/uc-model-service-get.json', import.meta.url), 'utf8'));
const serving = JSON.parse(await readFile(new URL('./fixtures/serving-endpoints-list.json', import.meta.url), 'utf8'));
const effortProbes: Array<{ api: string; service: string; servedModel: string; nativeApi: string; statuses: Record<string, number> }> =
  JSON.parse(await readFile(new URL('./fixtures/effort-probe.json', import.meta.url), 'utf8'));

function endpoint(model: string, metadata: Record<string, unknown> = {}) {
  return normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: 'arbitrary-alias',
    metadata: { task: 'llm/v1/chat', config: { served_entities: [{ external_model: { name: model } }] }, ...metadata } }).endpoint;
}

describe('Databricks proven effort options', () => {
  it.each(effortProbes)('advertises exactly the accepted candidate set for $api / $servedModel', (probe) => {
    const metadata = structuredClone(claude);
    metadata.supported_api_types = [probe.nativeApi];
    Object.assign(metadata.config.routing.destinations[0].external_model_config.target,
      { model: probe.servedModel, native_api_types: [probe.nativeApi] });
    const result = normalizeResource('secret', 'profile', { kind: 'uc-model-service', name: probe.service, metadata }).endpoint;
    expect(result.api).toBe(probe.api);
    expect(result.reasoningOptions?.map(({ id }) => id))
      .toEqual(Object.entries(probe.statuses).filter(([, status]) => status === 200).map(([effort]) => effort));
  });

  it('advertises measured gpt-oss-120b levels only on its verified protocol', () => {
    expect(endpoint('gpt-oss-120b').reasoningOptions?.map(({ id }) => id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(endpoint('gpt-oss-120b', { supported_api_types: ['anthropic/v1/messages'] }).reasoningOptions).toEqual([]);
    for (const model of ['gpt-oss-20b', 'gpt-oss-120b-custom', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(endpoint(model).reasoningOptions).toEqual([]);
    }
  });

  it('uses served identity rather than service alias or protocol alone', () => {
    const metadata = structuredClone(claude);
    metadata.config.routing.destinations[0].external_model_config.target.model = 'claude-sonnet-5-custom';
    expect(normalizeResource('secret', 'profile', { kind: 'uc-model-service', name: 'claude-sonnet-5', metadata })
      .endpoint.reasoningOptions).toEqual([]);
    expect(endpoint('gpt-5.6-luna').reasoningOptions?.map(({ id }) => id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(endpoint('claude-sonnet-5').reasoningOptions).toEqual([]); // Unprobed OpenAI translation.
    expect(normalizeResource('secret', 'profile', { kind: 'uc-model-service', name: 'claude-sonnet-5', metadata: {} })
      .endpoint.reasoningOptions).toEqual([]);
  });

  it('requires acceptance on every live destination and ignores inactive targets', () => {
    const metadata = structuredClone(claude);
    const destination = metadata.config.routing.destinations[0];
    metadata.config.routing.destinations.push(structuredClone(destination),
      { ...destination, traffic_percentage: 0, external_model_config: { target: { model: 'unknown-model' } } },
      { ...destination, is_deleted: true, external_model_config: { target: { model: 'unknown-model' } } });
    const resource = { kind: 'uc-model-service' as const, name: 'routed', metadata };
    expect(normalizeResource('secret', 'profile', resource).endpoint.reasoningOptions?.map(({ id }) => id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    metadata.config.routing.destinations.push({ ...destination, external_model_config: { target: {} } });
    expect(normalizeResource('secret', 'profile', resource).endpoint.reasoningOptions).toEqual([]);
  });
});

describe('Databricks model maxima', () => {
  it.each(['gpt-oss-120b', 'system.ai.qwen3-next-80b-a3b-instruct'])(
    'keeps the exact served identity separate from limits for %s', (model) => {
      const result = endpoint(model);
      expect(result.label).toBe(model);
      expect(result.label).not.toMatch(/\(|context|fallback|unknown/);
      expect(result.capabilities).toMatchObject(model === 'gpt-oss-120b'
        ? { contextWindow: 131_072, maxTokens: 25_000,
            limitSources: { contextWindow: 'model-table', maxTokens: 'model-table' } }
        : { contextWindow: null, maxTokens: null,
            limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
    },
  );

  it('uses only the service identity when no served model name is available', () => {
    const result = normalizeResource('secret', 'profile', {
      kind: 'uc-model-service', name: 'system.ai.private-chat', metadata: {},
    }).endpoint;
    expect(result.label).toBe('system.ai.private-chat');
    expect(result.label).not.toMatch(/\(|context|fallback|unknown/);
    expect(result.servedModelName).toBeUndefined();
    expect(result.capabilities).toMatchObject({ contextWindow: null, maxTokens: null,
      limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
  });

  it('recorded workspace bodies contain identity/protocol metadata but no token-limit fields', () => {
    const keys = (value: unknown): string[] => value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]) : [];
    expect(keys([claude, serving]).filter((key) => /context|token|limit/i.test(key))).toEqual([]);
    expect(claude.config.routing.destinations[0].external_model_config.target.model).toBe('claude-sonnet-5');
    expect(resolveDatabricksCapabilities(claude, [])).toMatchObject({ contextWindow: null, maxTokens: null });
  });

  it.each([
    ['claude-sonnet-5', 1_000_000, 128_000],
    ['claude-sonnet-4-5', 200_000, 64_000],
    ['claude-sonnet-4-5-20250929', 200_000, 64_000],
    ['claude-opus-4.5', 200_000, 64_000],
    ['claude-haiku-4-5-20251001', 200_000, 64_000],
    ['gpt-5.6', 1_050_000, 128_000],
    ['gpt-5.6-sol', 1_050_000, 128_000],
    ['gpt-5.6-terra', 1_050_000, 128_000],
    ['gpt-5.6-luna', 1_050_000, 128_000],
    ['gpt-oss-120b', 131_072, 25_000],
    ['gpt-oss-20b', 131_072, 131_072],
  ] as const)('resolves the fallback maximum for %s', (model, contextWindow, maxTokens) => {
    expect(endpoint(model).capabilities).toMatchObject({ contextWindow, maxTokens,
      limitSources: { contextWindow: 'model-table', maxTokens: 'model-table' } });
  });

  it('prefers explicit endpoint metadata and fills each missing field independently', () => {
    expect(endpoint('claude-sonnet-5', { capabilities: { context_window: 2_000_000, max_output_tokens: 256_000 } }).capabilities)
      .toMatchObject({ contextWindow: 2_000_000, maxTokens: 256_000, limitSources: { contextWindow: 'metadata', maxTokens: 'metadata' } });
    expect(endpoint('claude-sonnet-5', { model_info: { max_context_length: 900_000 } }).capabilities)
      .toMatchObject({ contextWindow: 900_000, maxTokens: 128_000, limitSources: { contextWindow: 'metadata', maxTokens: 'model-table' } });
  });

  it('reads explicit served-target limits ahead of identity recipes', () => {
    const metadata = structuredClone(claude);
    Object.assign(metadata.config.routing.destinations[0].external_model_config.target,
      { context_window: 750_000, max_output_tokens: 96_000 });
    expect(normalizeResource('secret', 'profile', { kind: 'uc-model-service', name: 'alias', metadata }).endpoint.capabilities)
      .toMatchObject({ contextWindow: 750_000, maxTokens: 96_000, limitSources: { contextWindow: 'metadata', maxTokens: 'metadata' } });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000000', null])('ignores invalid metadata limits: %s', (value) => {
    expect(endpoint('claude-sonnet-5', { context_window: value, max_output_tokens: value }).capabilities)
      .toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
  });

  it('does not mistake generation defaults or token-rate quotas for model maxima', () => {
    expect(endpoint('private-model', { max_tokens: 4096, rate_limits: [{ tokens: 100 }],
      config: { generation_config: { max_output_tokens: 4096 } } }).capabilities)
      .toMatchObject({ contextWindow: null, maxTokens: null, limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
    expect(endpoint('claude-sonnet-5-custom').capabilities.contextWindow).toBeNull();
    expect(normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: 'claude-sonnet-5', metadata: { task: 'llm/v1/chat' } })
      .endpoint.capabilities.contextWindow).toBeNull();
  });

  it('uses all live destinations, not the first model, and keeps partially unknown routes unknown', () => {
    const metadata = structuredClone(claude);
    const destination = metadata.config.routing.destinations[0];
    metadata.config.routing.destinations.push({ ...destination, external_model_config: { target: { model: 'claude-haiku-4-5' } } },
      { ...destination, traffic_percentage: 0, external_model_config: { target: { model: 'ignored' } } },
      { ...destination, is_deleted: true, external_model_config: { target: { model: 'ignored' } } });
    const resource = { kind: 'uc-model-service' as const, name: 'routed', metadata };
    expect(normalizeResource('secret', 'profile', resource).endpoint.capabilities).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000 });
    metadata.config.routing.destinations.push({ ...destination, external_model_config: { target: {} } });
    expect(normalizeResource('secret', 'profile', resource).endpoint.capabilities).toMatchObject({ contextWindow: null, maxTokens: null });
  });
});
