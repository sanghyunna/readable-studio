import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { DatabricksScanResponse } from '@readable-studio/contracts';
import { createDatabricksService } from '../../src/databricks/service.js';
import { createDatabricksRelay, type DatabricksRelay } from '../../src/databricks/relay.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { withDeadline } from '../../src/databricks/client.js';
import { fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';

const metadata = { name: 'stale-tools-fixture', task: 'llm/v1/chat' };
// Owner's exact diagnostic, with no workspace or model identity.
const rejection = { reason: 'bad-request', upstreamStatus: 400,
  message: 'The endpoint rejected the request shape...\nRejected parameter: tools' };
const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
const chat = { choices: [{ message: { role: 'assistant', content: 'CHAT_OK' }, finish_reason: 'stop' }] };
const messages = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'text', text: 'MESSAGES_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const messagesPath = '/ai-gateway/anthropic/v1/messages';
const recipe = { responsesUnsupported: true, chatTokensField: 'max_completion_tokens' as const, requiredOutputBudget: false, omittedFields: [] };

async function registration() {
  const root = await mkdtemp(join(tmpdir(), 'stale-tools-'));
  const makeService = () => createDatabricksService({ dataRoot: root, now: () => fixtureNow,
    clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' },
    resolveResource: async () => metadata.name,
    fetch: async raw => {
      const route = new URL(raw).pathname;
      return Response.json(route === '/api/2.0/serving-endpoints' ? { endpoints: [metadata] }
        : route === '/api/2.1/unity-catalog/catalogs' ? { catalogs: [] } : metadata);
    } });
  const service = makeService();
  const profileId = (await service.probe()).profiles[0]!.id;
  const found = await service.lookup({ profileId, resourceId: 'fixture', kind: 'serving-endpoint' });
  const enabled = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
  return { root, service, makeService, profileId, enabled,
    runtime: () => service.resolveRuntime(enabled.appModelId),
    saved: async () => (await new DatabricksStore(root).read()).entries[0]!,
    close: () => rm(root, { recursive: true, force: true }) };
}
function post(relay: DatabricksRelay, body: Record<string, unknown> = { tools }) {
  return fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], ...body }) });
}

for (const poisoned of [false, true]) test(`HTTP tools rejection never leaves supported persisted (poisoned=${poisoned})`, async () => {
  const fixture = await registration();
  try {
    const runtime = await fixture.runtime();
    await runtime.onCapabilitiesLearned!({ ...recipe, ...(poisoned ? { tools: 'supported' as const } : {}) });
    const relay = await createDatabricksRelay({ runtime: await fixture.runtime(), fetch: async () => Response.json(rejection, { status: 400 }) });
    try {
      const response = await post(relay);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { reason: 'bad-request', upstreamStatus: 400 } });
      expect((await fixture.saved()).wireCapabilities?.tools).toBe('unknown');
      expect((await fixture.makeService().listModels()).models[0]!.capabilities.tools).toBe('unknown');
    } finally { await relay.close(); }
  } finally { await fixture.close(); }
});

test('a persisted poisoned registration recovers on its very next run and restarts on Messages', async () => {
  const fixture = await registration();
  try {
    await (await fixture.runtime()).onCapabilitiesLearned!({ ...recipe, tools: 'supported' });
    const runtime = await fixture.makeService().resolveRuntime(fixture.enabled.appModelId);
    const routes: string[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
      const route = new URL(String(input)).pathname; routes.push(route);
      expect(JSON.parse(String(init?.body)).tools).toHaveLength(1);
      if (route !== messagesPath) return Response.json(rejection, { status: 400 });
      // Invalidation is durable before recovery inference is attempted.
      expect((await fixture.saved()).wireCapabilities?.tools).toBe('unknown');
      return Response.json(messages);
    } });
    try {
      const response = await post(relay);
      expect(response.status).toBe(200); expect(await response.text()).toContain('MESSAGES_OK');
      expect(routes).toEqual(['/serving-endpoints/stale-tools-fixture/invocations', messagesPath]);
      const restarted = await fixture.makeService().resolveRuntime(fixture.enabled.appModelId);
      expect(restarted).toMatchObject({ api: 'anthropic-messages', capabilities: { tools: 'supported' },
        wireCapabilities: { tools: 'supported', toolsCompletionVersion: 1, api: 'anthropic-messages' } });
    } finally { await relay.close(); }
  } finally { await fixture.close(); }
});

for (const mode of ['error-stream', 'error-json', 'truncated-stream', 'incomplete-json'] as const) test(`HTTP 200 ${mode} is not successful tools evidence`, async () => {
  const fixture = await registration();
  try {
    await (await fixture.runtime()).onCapabilitiesLearned!({ ...recipe, tools: 'supported' });
    const relay = await createDatabricksRelay({ runtime: await fixture.runtime(), fetch: async () => mode === 'error-json'
      ? Response.json({ type: 'error', error: rejection }) : mode === 'incomplete-json' ? Response.json({})
      : new Response(mode === 'error-stream' ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: rejection })}\n\n`
        : 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const response = await post(relay, { tools, stream: mode !== 'error-json' });
      const body = await response.text();
      expect(body).toContain(mode.endsWith('json') ? '"type":"error"' : 'event: error');
      const saved = (await fixture.saved()).wireCapabilities;
      expect(saved?.toolsCompletionVersion).toBeUndefined();
      if (mode.startsWith('error')) expect(saved?.tools).toBe('unknown');
    } finally { await relay.close(); }
  } finally { await fixture.close(); }
});

test('only a complete tool-bearing stream learns support; the next run uses direct Chat', async () => {
  const fixture = await registration();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  try {
    await (await fixture.runtime()).onCapabilitiesLearned!(recipe);
    const relay = await createDatabricksRelay({ runtime: await fixture.runtime(), fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const response = await post(relay, { tools, stream: true }); // Real flushed relay headers signal upstream acceptance.
      expect((await fixture.saved()).wireCapabilities?.tools).toBeUndefined();
      source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'STREAM_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
      source.close();
      expect(await response.text()).toContain('STREAM_OK');
      expect((await fixture.saved()).wireCapabilities).toMatchObject({ tools: 'supported', toolsCompletionVersion: 1 });
    } finally { await relay.close(); }
    const service = fixture.makeService();
    const runtime = await service.resolveRuntime(fixture.enabled.appModelId);
    expect(runtime.capabilities.tools).toBe('supported');
    const routes: string[] = [];
    const relay2 = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
      routes.push(new URL(String(input)).pathname);
      expect(JSON.parse(String(init?.body)).tools).toEqual(tools);
      return Response.json(chat);
    } });
    try {
      expect(await (await post(relay2)).text()).toContain('CHAT_OK');
      expect(routes).toEqual(['/serving-endpoints/stale-tools-fixture/invocations']);
    } finally { await relay2.close(); }
    const lookedUp = await service.lookup({ profileId: fixture.profileId, resourceId: fixture.enabled.endpoint.id, kind: 'serving-endpoint' });
    expect(lookedUp.endpoint.capabilities.tools).toBe('supported');
  } finally { await fixture.close(); }
});

for (const mode of ['absent', 'omitted'] as const) test(`successful ${mode} wire tools do not learn support`, async () => {
  const fixture = await registration();
  try {
    await (await fixture.runtime()).onCapabilitiesLearned!({ ...recipe, omittedFields: mode === 'omitted' ? ['tools'] : [] });
    const relay = await createDatabricksRelay({ runtime: await fixture.runtime(), fetch: async (_input, init) => {
      expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      return Response.json(chat);
    } });
    try {
      expect((await post(relay, mode === 'omitted' ? { tools } : {})).status).toBe(200);
      expect((await fixture.saved()).wireCapabilities?.tools).toBeUndefined();
    } finally { await relay.close(); }
  } finally { await fixture.close(); }
});

for (const refresh of ['scan', 'lookup'] as const) test(`${refresh} clears legacy positive learning even with identical metadata`, async () => {
  const fixture = await registration();
  try {
    await (await fixture.runtime()).onCapabilitiesLearned!({ ...recipe, tools: 'supported' });
    if (refresh === 'scan') {
      const started = await fixture.service.startScan({ profileId: fixture.profileId });
      let resolve!: (scan: DatabricksScanResponse) => void;
      const completed = new Promise<DatabricksScanResponse>(yes => { resolve = yes; });
      const unsubscribe = await fixture.service.subscribeScan(started.scanId, event => { if (event.type === 'done') resolve(event.scan); });
      try { expect((await withDeadline(() => completed, 5000)).state).toBe('complete'); }
      finally { unsubscribe(); }
    } else {
      const found = await fixture.service.lookup({ profileId: fixture.profileId, resourceId: fixture.enabled.endpoint.id, kind: 'serving-endpoint' });
      await fixture.service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
    }
    expect((await fixture.saved()).wireCapabilities?.tools).toBeUndefined();
    const runtime = await fixture.makeService().resolveRuntime(fixture.enabled.appModelId);
    expect(runtime.capabilities.tools).toBe('unknown');
    expect(runtime.appModelId).toBe(fixture.enabled.appModelId);
  } finally { await fixture.close(); }
});
