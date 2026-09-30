import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chatStream, completed, json, namedFixture } from './named-fixture.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';

const wire = JSON.parse(await readFile(new URL('./fixtures/serving-wire.json', import.meta.url), 'utf8'));
// Real redacted Foundation GET: task is top-level, not inside foundation_model.
const foundation = wire.observedDetails[8];
// The workspace has no custom endpoint; retain the explicitly documentation-only contrast.
const documented: unknown = wire.documented;
if (!Array.isArray(documented)) throw new Error('Invalid documentation fixture');
const custom = documented[1];
function withDescription(description?: string, differentShape = false) {
  const metadata = structuredClone(foundation);
  const model = metadata.config.served_entities[0].foundation_model;
  delete model.description;
  if (description !== undefined) model.description = description;
  if (differentShape) model.context_length = 128000;
  return metadata;
}

describe('named registration', () => {
  it.each([
    ['captured context', foundation, 128_000, 'advertised'],
    ['absent context', withDescription(), null, 'default'],
    ['malformed context', withDescription('supports a context length of many tokens'), null, 'default'],
    ['implausible context', withDescription('supports a context length of 999999999K tokens'), null, 'default'],
    ['zero context', withDescription('supports a context length of 0K tokens'), null, 'default'],
    ['negative context', withDescription('supports a context length of -128K tokens'), null, 'default'],
    ['context larger than prior planning budget', withDescription('supports a context length of 1024K tokens'), null, 'default'],
    ['different field shape', withDescription(undefined, true), null, 'default'],
  ] as const)('registers %s from captured serving GET without guessing output', async (_label, metadata, contextWindow, source) => {
    // Given: captured metadata (or one-field fault mutation); synthetic bounded inference.
    const fixture = await namedFixture(async (_url, init) => init.method === 'POST' ? chatStream() : json(metadata));
    // When
    const scan = await completed(fixture.service, (await fixture.service.startNamedScan({ profileId: fixture.profileId, names: 'databricks-meta-llama-3-1-70b-instruct', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.state).toBe('chat-only');
    expect(scan.endpoints[0]?.capabilities).toEqual({ tools: 'unknown', images: 'unknown', contextWindow, maxTokens: null,
      limitSources: { contextWindow: source, maxTokens: 'default' } });
  });
  it('records a probed output ceiling without treating the captured context as an output limit', async () => {
    // Given: captured metadata and a synthetic validation rejection.
    const fixture = await namedFixture(async (_url, init) => {
      if (init.method !== 'POST') return json(foundation);
      return JSON.parse(String(init.body)).max_tokens > 128
        ? json({ message: 'max_tokens 256 cannot be greater than max_tokens 128' }, 400) : chatStream();
    });
    // When
    const scan = await completed(fixture.service, (await fixture.service.startNamedScan({ profileId: fixture.profileId,
      names: 'databricks-meta-llama-3-1-70b-instruct', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]).toMatchObject({ state: 'chat-only', attempts: 2 });
    expect(scan.endpoints[0]?.capabilities).toMatchObject({ contextWindow: 128_000, maxTokens: 128,
      limitSources: { contextWindow: 'advertised', maxTokens: 'probed' } });
  });
  it('keeps the documented custom endpoint behavior unchanged', async () => {
    // Given
    const fixture = await namedFixture(async (_url, init) => init.method === 'POST' ? chatStream() : json(custom));
    // When
    const scan = await completed(fixture.service, (await fixture.service.startNamedScan({ profileId: fixture.profileId, names: 'uc-model-endpoint', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.state).toBe('chat-only');
    expect(scan.endpoints[0]?.capabilities).toMatchObject({ contextWindow: null, maxTokens: null,
      limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
  });
  it('registers without enumeration when metadata is denied and retains the working profile after rescan and restart', async () => {
    // Given
    const calls: string[] = [];
    const fixture = await namedFixture(async (url, init) => {
      calls.push(new URL(url).pathname);
      if (init.method === 'POST') return chatStream();
      return json({}, 403);
    });
    // When
    const scan = await completed(fixture.service, (await fixture.service.startNamedScan({ profileId: fixture.profileId, names: 'hidden-model, hidden-model', allowInference: true })).scanId);
    const row = scan.inputResults?.[0];
    if (!row?.endpointId) throw new Error('Missing verified candidate');
    const saved = await fixture.service.enable(row.endpointId, { scanId: scan.scanId, expectedRevision: scan.revision });
    const restarted = fixture.restart();
    const runtime = await restarted.resolveRuntime(saved.appModelId);
    // Then
    expect(scan.inputResults).toHaveLength(1);
    expect(row.state).toBe('chat-only');
    expect(calls).toEqual(['/api/2.0/serving-endpoints/hidden-model', '/serving-endpoints/hidden-model/invocations']);
    expect(runtime.reasoningOptions).toEqual([]);
    expect(runtime.wireCapabilities?.namedProfile?.tools).toBe('disabled');
    expect(runtime.capabilities.maxTokens).toBe(null);
  });
  it.each([
    [404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }, false, 'name-not-found'],
    [404, {}, false, 'not-found-or-hidden'],
    [403, { error_code: 'PERMISSION_DENIED', message: 'User does not have EXECUTE on model' }, false, 'not-entitled'],
    [403, {}, true, 'not-invocable'],
    [403, {}, false, 'permission-denied'],
    [401, {}, false, 'auth-failed'],
    [429, {}, false, 'rate-limited'],
    [503, {}, false, 'upstream-failed'],
    [400, {}, false, 'request-incompatible'],
  ] as const)('maps upstream %i to %s without enabling a failed name', async (status, body, exists, reason) => {
    // Given
    const { service, profileId } = await namedFixture(async (_url, init) => init.method === 'POST' ? json(body, status) : json({}, exists ? 200 : 403));
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'test-model', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.failure).toMatchObject({ reason, upstreamStatus: status });
    expect((await service.listModels()).models).toEqual([]);
  });
  it('reports workspace-unreachable for transport failure', async () => {
    // Given
    const { service, profileId } = await namedFixture(async () => { throw new TypeError('network'); });
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'test-model', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.failure?.reason).toBe('workspace-unreachable');
  });
  it('does not infer tool support from an incomplete successful HTTP response', async () => {
    // Given
    const { service, profileId } = await namedFixture(async (_url, init) => init.method === 'POST'
      ? new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : json({}, 403));
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'test-model', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.state).toBe('inconclusive');
  });
  it('skips paid requests when the same identity is already registered', async () => {
    // Given
    let requests = 0;
    const { service, profileId } = await namedFixture(async (_url, init) => { requests++; return init.method === 'POST' ? chatStream(true) : json({}, 403); });
    const first = await completed(service, (await service.startNamedScan({ profileId, names: 'test-model', allowInference: true })).scanId);
    const endpoint = first.endpoints[0]; if (!endpoint) throw new Error('Missing endpoint');
    await service.enable(endpoint.id, { scanId: first.scanId, expectedRevision: first.revision });
    const before = requests;
    // When
    const second = await completed(service, (await service.startNamedScan({ profileId, names: 'test-model', allowInference: true })).scanId);
    // Then
    expect(second.inputResults?.[0]?.state).toBe('already-registered');
    expect(requests).toBe(before);
  });
  it('reuses the tested token field and route through the real relay', async () => {
    // Given
    const fixture = await namedFixture(async (_url, init) => {
      if (init.method !== 'POST') return json({}, 403);
      const body = JSON.parse(String(init.body));
      return body.max_completion_tokens !== undefined ? json({ message: 'Unsupported parameter: "max_completion_tokens"' }, 400) : chatStream(true);
    });
    const scan = await completed(fixture.service, (await fixture.service.startNamedScan({ profileId: fixture.profileId, names: 'system.ai.hidden', allowInference: true })).scanId);
    const endpoint = scan.endpoints[0]; if (!endpoint) throw new Error('Missing endpoint');
    const saved = await fixture.service.enable(endpoint.id, { scanId: scan.scanId, expectedRevision: scan.revision });
    const runtime = await fixture.restart().resolveRuntime(saved.appModelId);
    const sent: { path: string; body: unknown }[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (url, init) => { sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) }); return chatStream(true); } });
    try {
      // When
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${relay.capabilityKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: relay.modelAlias, stream: true, messages: [{ role: 'user', content: 'test' }], max_completion_tokens: 1024, tools: [{ type: 'function', function: { name: 'readable_probe', parameters: {} } }] }) });
      await response.text();
      // Then
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ path: '/ai-gateway/openai/v1/chat/completions', body: { model: 'system.ai.hidden', max_tokens: 256 } });
      expect(sent[0]?.body).not.toHaveProperty('max_completion_tokens');
    } finally { await relay.close(); }
  });
});
