import { describe, expect, it } from 'vitest';
import { chatStream, completed, json, namedFixture } from './named-fixture.js';
import { servingTask } from '../../src/databricks/serving-task.js';
import { withDeadline } from '../../src/databricks/client.js';

describe('named preflight edge cases', () => {
  it('keeps a manual registration compatible when a complete scan returns no endpoints', async () => {
    // Given
    const { service, profileId } = await namedFixture(async (_url, init) => init.method === 'POST' ? chatStream() : json({}));
    const named = await completed(service, (await service.startNamedScan({ profileId, names: 'hidden', allowInference: true })).scanId);
    const candidate = named.endpoints[0]; if (!candidate) throw new Error('Missing candidate');
    await service.enable(candidate.id, { scanId: named.scanId, expectedRevision: named.revision });
    // When
    await completed(service, (await service.startScan({ profileId })).scanId);
    // Then
    expect((await service.listModels()).models[0]?.availability).toBe('compatible');
  });
  it('removes explicitly rejected tools and leaves untested reasoning off', async () => {
    // Given
    const bodies: Record<string, unknown>[] = [];
    const { service, profileId } = await namedFixture(async (_url, init) => {
      if (init.method !== 'POST') return json({}, 403);
      const body = JSON.parse(String(init.body)); bodies.push(body);
      return body.tools ? json({ message: 'tools is not supported' }, 400) : chatStream();
    });
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'hidden', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]).toMatchObject({ state: 'chat-only', attempts: 2 });
    expect(bodies[1]).not.toHaveProperty('tools');
    expect(bodies[1]).not.toHaveProperty('tool_choice');
    expect(scan.endpoints[0]?.reasoningOptions).toEqual([]);
  });
  it('retains working chat when optional reasoning is rejected on the same route', async () => {
    // Given
    const paths: string[] = [];
    const { service, profileId } = await namedFixture(async (url, init) => {
      if (init.method !== 'POST') return json({}, 403);
      paths.push(new URL(url).pathname);
      return JSON.parse(String(init.body)).reasoning_effort ? json({ message: 'reasoning_effort is unsupported' }, 400) : chatStream(true);
    });
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'hidden', allowInference: true, checkReasoning: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]).toMatchObject({ state: 'verified', attempts: 2, checks: { effort: 'failed' } });
    expect(paths).toEqual(['/serving-endpoints/hidden/invocations', '/serving-endpoints/hidden/invocations']);
    expect(scan.endpoints[0]?.reasoningOptions).toEqual([]);
  });
  it('accepts completed native Messages tool input without assuming a provider from the name', async () => {
    // Given
    const frames = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'readable_probe', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":true}' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
    ];
    const { service, profileId } = await namedFixture(async (url, init) => {
      if (init.method !== 'POST') return json({ supported_api_types: ['anthropic/v1/messages'] });
      expect(new URL(url).pathname).toBe('/ai-gateway/anthropic/v1/messages');
      expect(JSON.parse(String(init.body)).model).toBe('system.ai.neutral');
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'system.ai.neutral', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]?.state).toBe('verified');
    expect(scan.endpoints[0]?.api).toBe('anthropic-messages');
  });
  it('records an explicit numeric ceiling separately from the tested budget', async () => {
    // Given
    const { service, profileId } = await namedFixture(async (_url, init) => {
      if (init.method !== 'POST') return json({}, 403);
      return JSON.parse(String(init.body)).max_tokens > 128 ? json({ message: 'max_tokens 256 cannot be greater than max_tokens 128' }, 400) : chatStream();
    });
    // When
    const scan = await completed(service, (await service.startNamedScan({ profileId, names: 'hidden', allowInference: true })).scanId);
    // Then
    expect(scan.inputResults?.[0]).toMatchObject({ state: 'chat-only', attempts: 2 });
    expect(scan.endpoints[0]?.capabilities).toMatchObject({ maxTokens: 128, limitSources: { maxTokens: 'endpoint' } });
  });
  it('cancels in-flight inference without saving or enabling a late candidate', async () => {
    // Given
    let entered: () => void = () => { throw new Error('Not initialized'); };
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { service, profileId } = await namedFixture(async (_url, init) => {
      if (init.method !== 'POST') return json({}, 403);
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        entered();
      });
    });
    const scan = await service.startNamedScan({ profileId, names: 'hidden', allowInference: true });
    await withDeadline(() => started, 5000);
    // When
    const cancelled = await service.cancelScan(scan.scanId);
    // Then
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.endpoints).toEqual([]);
    expect((await service.listModels()).models).toEqual([]);
  });
  it('ignores zero-traffic legacy entities and refuses mixed active tasks', () => {
    // Given
    const config = { served_models: [{ name: 'chat', external_model: { task: 'llm/v1/chat' } }, { name: 'embed', foundation_model: { task: 'llm/v1/embeddings' } }],
      traffic_config: { routes: [{ served_model_name: 'chat', traffic_percentage: 100 }, { served_model_name: 'embed', traffic_percentage: 0 }] } };
    // When / Then
    expect(servingTask({ config })).toBe('llm/v1/chat');
    expect(servingTask({ config: { served_models: config.served_models } })).toBeUndefined();
    expect(servingTask({ task: 'llm/v1/embeddings', config })).toBe('llm/v1/embeddings');
  });
});
