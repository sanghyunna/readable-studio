import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksScanResponse } from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError, withDeadline, type DatabricksSubprocessRunner } from '../../src/databricks/client.js';
import { DatabricksCredentials } from '../../src/databricks/credentials.js';
import { classifyProtocol, normalizeResource } from '../../src/databricks/catalogue.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { createDatabricksService, type DatabricksService, type DatabricksServiceOptions } from '../../src/databricks/service.js';
import type { DatabricksFetch } from '../../src/databricks/scan.js';
import { createDatabricksPiRuntime, renderDatabricksPiProvider } from '../../src/runtimes/pi-databricks.js';
import { databricksPublic } from '../../src/databricks-routes.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const serving = JSON.parse(await readFile(new URL('serving-endpoints-list.json', fixtures), 'utf8'));
const services = JSON.parse(await readFile(new URL('uc-model-services-list.json', fixtures), 'utf8'));
const claude = JSON.parse(await readFile(new URL('uc-model-service-get.json', fixtures), 'utf8'));
const luna = JSON.parse(await readFile(new URL('luna-chat-completions.json', fixtures), 'utf8'));
const claudeMessage = JSON.parse(await readFile(new URL('claude-messages.json', fixtures), 'utf8'));
const claudeStream = await readFile(new URL('claude-messages-stream.txt', fixtures), 'utf8');
const host = 'https://private-workspace.example';
const profileName = 'Discovered profile with spaces';
const now = Date.parse('2026-09-10T12:00:00Z');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function runner(clock: () => number = () => now): DatabricksSubprocessRunner {
  return vi.fn(async (_executable, args, options) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBeGreaterThan(0);
    if (args[0] === '--version') return { stdout: 'Databricks CLI v0.278.0', stderr: '', exitCode: 0 };
    if (args[1] === 'profiles') return { stdout: JSON.stringify({ profiles: [{ name: profileName, host }] }), stderr: '', exitCode: 0 };
    expect(args).toEqual(['auth', 'token', '--profile', profileName]);
    return { stdout: JSON.stringify({ access_token: 'private-bearer', expiry: new Date(clock() + 3600_000).toISOString() }), stderr: '', exitCode: 0 };
  });
}

const workspaceFetch: DatabricksFetch = async (raw, init) => {
  expect(init.headers).toMatchObject({ Authorization: 'Bearer private-bearer' });
  expect(init.redirect).toBe('error');
  const url = new URL(raw);
  const [catalog, schema] = luna.request.body.model.split('.');
  if (url.pathname === '/api/2.0/serving-endpoints') return json(serving);
  if (url.pathname === '/api/2.1/unity-catalog/catalogs') return json({ catalogs: [{ name: catalog }] });
  if (url.pathname === '/api/2.1/unity-catalog/schemas') {
    expect(url.searchParams.get('catalog_name')).toBe(catalog);
    return json({ schemas: [{ name: schema }] });
  }
  if (url.pathname === '/api/2.1/unity-catalog/model-services') {
    expect(url.searchParams.get('parent')).toBe(`schemas/${catalog}.${schema}`);
    expect(url.searchParams.get('view')).toBe('FULL');
    return json(services);
  }
  if (decodeURIComponent(url.pathname).endsWith(claude.name)) return json(claude);
  if (decodeURIComponent(url.pathname).endsWith(`/model-services/${luna.request.body.model}`)) {
    const metadata = structuredClone(claude);
    metadata.name = `model-services/${luna.request.body.model}`;
    metadata.supported_api_types = ['mlflow/v1/chat/completions'];
    metadata.config.routing.destinations[0].external_model_config.target.native_api_types = ['openai/v1/chat/completions'];
    metadata.config.routing.destinations[0].external_model_config.target.model = luna.response.body.model;
    return json(metadata);
  }
  throw new Error('Unexpected fixture request');
};

async function setup(overrides: Partial<DatabricksServiceOptions> = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'readable-databricks-'));
  roots.push(dataRoot);
  const cliRunner = runner(overrides.now);
  const service = createDatabricksService({ dataRoot, now: () => now,
    clientOptions: { runner: cliRunner, resolveExecutable: async () => 'C:\\test tools\\databricks.exe' },
    fetch: workspaceFetch, ...overrides });
  const discovered = await service.probe();
  expect(discovered.issues).toEqual([]);
  const profileId = discovered.profiles[0]!.id;
  return { service, profileId, dataRoot, cliRunner };
}

async function done(service: DatabricksService, scanId: string): Promise<DatabricksScanResponse> {
  const completion = deferred<DatabricksScanResponse>();
  // subscribeScan replays terminal state, so completion before subscription is safe.
  const unsubscribe = await service.subscribeScan(scanId, (event) => { if (event.type === 'done') completion.resolve(event.scan); });
  try { return await withDeadline(() => completion.promise, 5000); }
  finally { unsubscribe(); }
}
async function scan(service: DatabricksService, profileId: string) {
  return done(service, (await service.startScan({ profileId })).scanId);
}
function assertPublic(value: unknown) {
  const serialized = JSON.stringify(value);
  // Real identity is allowed in UI DTOs, but credentials/raw metadata never are.
  expect(serialized).not.toContain('private-bearer');
  expect(serialized).not.toContain('access_token');
  expect(serialized).not.toContain('external_model_config');
  expect(serialized).not.toContain('Authorization');
}

describe('daemon Databricks facade', () => {
  it('allows real service, served model, profile and workspace labels in scanned/registered UI DTOs while keeping opaque handles', async () => {
    const { service, profileId, cliRunner, dataRoot } = await setup();
    const result = await scan(service, profileId);
    expect(result.state).toBe('complete');
    expect(result.completeness).toEqual({ serving: true, uc: true, truncated: false });
    expect(result.counters).toEqual({ scopesChecked: 4, scopesInaccessible: 0, candidates: 13, excluded: 3 });
    const uc = result.endpoints.filter((endpoint) => endpoint.kind === 'uc-model-service');
    expect(uc).toHaveLength(2);
    expect(uc.map((endpoint) => endpoint.api).sort()).toEqual(['anthropic-messages', 'openai-completions']);
    expect(serving.endpoints.some((endpoint: { name: string }) => endpoint.name === luna.request.body.model)).toBe(false);
    expect((await service.status()).profiles[0]).toMatchObject({
      id: profileId, label: profileName, displayName: profileName,
      workspaceLabel: host, workspaceDisplayLabel: host,
    });
    expect(result.endpoints.filter((endpoint) => endpoint.kind === 'serving-endpoint').map((endpoint) => endpoint.displayName))
      .toEqual(serving.endpoints.filter((endpoint: { task: string }) => endpoint.task === 'llm/v1/chat').map((endpoint: { name: string }) => endpoint.name));
    const anthropic = uc.find((endpoint) => endpoint.api === 'anthropic-messages')!;
    expect(anthropic).toMatchObject({ displayName: claude.name.replace('model-services/', ''), servedModelName: 'claude-sonnet-5', label: 'claude-sonnet-5' });
    expect(anthropic.reasoningOptions?.map((option) => option.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const enabled = await service.enable(anthropic.id, { scanId: result.scanId, expectedRevision: result.revision });
    assertPublic([result, enabled, await service.status(), await service.listModels()]);
    const runtime = await service.resolveRuntime(enabled.appModelId);
    expect(runtime.reasoningOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(runtime).toMatchObject({ api: 'anthropic-messages', baseUrl: `${host}/ai-gateway/anthropic`, model: claude.name.replace('model-services/', ''), compat: { forceAdaptiveThinking: true }, apiKey: 'private-bearer' });
    const openai = uc.find((endpoint) => endpoint.api === 'openai-completions')!;
    expect(openai).toMatchObject({ displayName: luna.request.body.model, servedModelName: luna.response.body.model, label: luna.response.body.model });
    const openaiEnabled = await service.enable(openai.id, { scanId: result.scanId, expectedRevision: result.revision });
    expect(openai.reasoningOptions?.map((option) => option.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(await service.resolveRuntime(openaiEnabled.appModelId)).toMatchObject({ api: 'openai-completions', baseUrl: `${host}/ai-gateway/openai/v1`, model: luna.request.body.model,
      reasoningOptions: ['low', 'medium', 'high', 'xhigh'] });
    const persisted = new DatabricksStore(dataRoot);
    expect((await persisted.read()).entries.filter((entry) => entry.endpoint.enabled)).toHaveLength(2);
    expect(vi.mocked(cliRunner).mock.calls.filter((call) => call[1][1] === 'token')).toHaveLength(1);
    await service.disable(enabled.endpoint.id, { expectedRevision: (await service.listModels()).revision });
    await expect(service.resolveRuntime(enabled.appModelId)).rejects.toMatchObject({ code: 'DATABRICKS_SCAN_EXPIRED' });
    await service.disconnect(profileId);
    expect((await service.listModels()).models).toEqual([]);
    expect((await service.status()).profiles).toEqual([]);
    expect(vi.mocked(cliRunner).mock.calls.every((call) => !call[1].some((arg) => ['login', 'logout'].includes(arg)))).toBe(true);
  });

  it('persists registered Sonnet 5 and Luna maxima and writes them to the actual managed Pi config after restart', async () => {
    const { service, profileId, dataRoot } = await setup();
    const result = await scan(service, profileId);
    for (const [servedModelName, contextWindow, maxTokens, levels] of [
      ['claude-sonnet-5', 1_000_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-5.6-luna', 1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
    ] as const) {
      const endpoint = result.endpoints.find((entry) => entry.servedModelName === servedModelName)!;
      expect(databricksPublic.scan(result).endpoints.find((item) => item.id === endpoint.id)!.reasoningOptions?.map(({ id }) => id)).toEqual(levels);
      const registered = await service.enable(endpoint.id, { scanId: result.scanId, expectedRevision: result.revision });
      expect(databricksPublic.model(registered).endpoint.reasoningOptions?.map(({ id }) => id)).toEqual(levels);
      expect(registered.endpoint.capabilities).toMatchObject({ contextWindow, maxTokens,
        limitSources: { contextWindow: 'model-table', maxTokens: 'model-table' } });
      const restart = createDatabricksService({ dataRoot, now: () => now, fetch: workspaceFetch,
        clientOptions: { runner: runner(), resolveExecutable: async () => 'databricks.exe' } });
      const saved = (await restart.listModels()).models.find((entry) => entry.id === endpoint.id)!;
      expect(saved.capabilities).toEqual(registered.endpoint.capabilities);
      expect(saved.reasoningOptions).toEqual(registered.endpoint.reasoningOptions);
      expect(databricksPublic.models(await restart.listModels()).models.find((entry) => entry.id === endpoint.id)!.reasoningOptions)
        .toEqual(saved.reasoningOptions);
      expect(databricksPublic.models(await restart.listModels()).models.find((entry) => entry.id === endpoint.id)!.capabilities).toEqual(saved.capabilities);
      expect((await restart.getScan(result.scanId)).endpoints.find((entry) => entry.id === endpoint.id)!.capabilities).toEqual(saved.capabilities);
      const runtime = await restart.resolveRuntime(registered.appModelId);
      expect(runtime.reasoningOptions).toEqual(levels);
      const relay = { baseUrl: 'http://127.0.0.1:1234', capabilityKey: 'local', modelAlias: registered.appModelId };
      for (const level of levels) {
        const rendered = renderDatabricksPiProvider(runtime, relay, level);
        expect(rendered.settings.defaultThinkingLevel).toBe(level);
        const mapping = rendered.models.providers.databricks.models[0]!.thinkingLevelMap;
        expect(mapping[level]).toBe(level);
        expect(Object.entries(mapping).filter(([, value]) => value !== null).map(([id]) => id)).toEqual(levels);
      }
      if (servedModelName === 'gpt-5.6-luna') expect(() => renderDatabricksPiProvider(runtime, relay, 'max')).toThrow();
      const handle = await createDatabricksPiRuntime({ dataRoot, cwd: dataRoot, sessionKey: endpoint.id,
        model: registered.appModelId, service: restart });
      try {
        const config = JSON.parse(await readFile(join(handle.invocation.agentDir, 'models.json'), 'utf8'));
        expect(config.providers.databricks.models[0]).toMatchObject({ contextWindow, maxTokens });
        expect(Object.entries(config.providers.databricks.models[0].thinkingLevelMap).filter(([, value]) => value !== null).map(([id]) => id)).toEqual(levels);
      } finally { await handle.close(); }
    }
  });

  it('keeps unknown maxima visible in the public model list while the Pi config avoids the legacy silent caps', async () => {
    const { service, profileId, dataRoot } = await setup({ fetch: async (raw, init) => {
      if (!decodeURIComponent(new URL(raw).pathname).endsWith(claude.name)) return workspaceFetch(raw, init);
      const metadata = structuredClone(claude);
      metadata.config.routing.destinations[0].external_model_config.target.model = 'unlisted-model';
      return json(metadata);
    } });
    const result = await scan(service, profileId);
    const endpoint = result.endpoints.find((entry) => entry.servedModelName === 'unlisted-model')!;
    const registered = await service.enable(endpoint.id, { scanId: result.scanId, expectedRevision: result.revision });
    const restarted = createDatabricksService({ dataRoot });
    const publicModel = databricksPublic.models(await restarted.listModels()).models[0]!;
    expect(publicModel.capabilities).toMatchObject({ contextWindow: null, maxTokens: null,
      limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
    expect(publicModel.label).toBe('unlisted-model');
    expect(publicModel.label).toBe(publicModel.servedModelName);
    const config = renderDatabricksPiProvider(await service.resolveRuntime(registered.appModelId),
      { baseUrl: 'http://127.0.0.1:1234', capabilityKey: 'local', modelAlias: registered.appModelId });
    const rendered = config.models.providers.databricks.models[0]!;
    expect(rendered.contextWindow).toBe(1_000_000);
    expect(rendered.maxTokens).toBe(128_000);
    expect(rendered.contextWindow).not.toBe(32_768);
    expect(rendered.maxTokens).not.toBe(4_096);
  });

  it('refreshes enabled capabilities on rescan and re-registration through lookup', async () => {
    let maxTokens = 150_000;
    const { service, profileId } = await setup({ fetch: async (raw, init) => {
      if (!decodeURIComponent(new URL(raw).pathname).endsWith(claude.name)) return workspaceFetch(raw, init);
      return json({ ...claude, max_output_tokens: maxTokens });
    } });
    const first = await scan(service, profileId);
    const endpoint = first.endpoints.find((entry) => entry.api === 'anthropic-messages')!;
    const registered = await service.enable(endpoint.id, { scanId: first.scanId, expectedRevision: first.revision });
    expect(registered.endpoint.capabilities.maxTokens).toBe(150_000);
    maxTokens = 180_000;
    await scan(service, profileId);
    expect((await service.resolveRuntime(registered.appModelId)).capabilities.maxTokens).toBe(180_000);
    maxTokens = 200_000;
    const lookup = await service.lookup({ profileId, resourceId: endpoint.id, kind: endpoint.kind });
    const refreshed = await service.enable(endpoint.id, { scanId: lookup.scanId, expectedRevision: lookup.revision });
    expect(refreshed.endpoint.capabilities).toMatchObject({ contextWindow: 1_000_000, maxTokens: 200_000,
      limitSources: { contextWindow: 'model-table', maxTokens: 'metadata' } });
    expect(refreshed.appModelId).toBe(registered.appModelId);
  });

  it.each([
    { served_entities: [{ external_model: { name: 'gpt-5.6-luna' } }] },
    { served_entities: [{ entity_name: 'models.default.custom-chat' }] },
    { served_models: [{ model_name: 'models.default.legacy-chat' }] },
  ])('uses explicit serving model metadata while keeping the endpoint own name: %j', (config) => {
    const resource = { kind: 'serving-endpoint' as const, name: 'team-chat-endpoint', metadata: { task: 'llm/v1/chat', config } };
    const entry = normalizeResource('test-secret', 'profile-id', resource);
    const entity = config.served_entities?.[0];
    const expected = entity && 'external_model' in entity ? entity.external_model.name
      : entity && 'entity_name' in entity ? entity.entity_name : config.served_models?.[0]?.model_name;
    expect(entry.endpoint).toMatchObject({ displayName: resource.name, servedModelName: expected,
      label: expected });
    expect(entry.upstreamName).toBe(resource.name);
  });

  it('labels every live routed model without naming deleted or zero-traffic destinations', () => {
    const destination = claude.config.routing.destinations[0];
    const metadata = structuredClone(claude);
    metadata.config.routing.destinations.push(
      { ...destination, is_deleted: true, external_model_config: { target: { model: 'deleted-model' } } },
      { ...destination, traffic_percentage: 0, external_model_config: { target: { model: 'inactive-model' } } },
      { ...destination, external_model_config: { target: { model: 'second-live-model' } } },
    );
    const entry = normalizeResource('secret', 'profile', { kind: 'uc-model-service', name: 'catalog.schema.service', metadata });
    expect(entry.endpoint.servedModelName).toBe('claude-sonnet-5, second-live-model');
    expect(JSON.stringify(entry)).not.toContain('deleted-model');
    expect(JSON.stringify(entry)).not.toContain('inactive-model');
  });

  it('restores service labels from an older private catalogue without rescanning or changing registered IDs', async () => {
    const { service, profileId, dataRoot } = await setup();
    const result = await scan(service, profileId);
    const enabled = await service.enable(result.endpoints[0]!.id, { scanId: result.scanId, expectedRevision: result.revision });
    const store = new DatabricksStore(dataRoot);
    const legacy = await store.update((generation) => {
      for (const endpoint of [...generation.entries.map((entry) => entry.endpoint), ...generation.scans.flatMap((snapshot) => snapshot.endpoints)]) {
        delete endpoint.displayName;
        delete endpoint.servedModelName;
        endpoint.label = `Serving endpoint ${endpoint.id.slice(-8)}`;
      }
    });
    const fetch = vi.fn<DatabricksFetch>();
    const restarted = createDatabricksService({ dataRoot, fetch });
    const models = await restarted.listModels();
    expect(models.revision).toBe(legacy.revision);
    expect(models.models[0]).toMatchObject({ id: enabled.endpoint.id, appModelId: enabled.appModelId,
      displayName: serving.endpoints[0].name, label: serving.endpoints[0].name });
    expect((await restarted.getScan(result.scanId)).endpoints[0]).toMatchObject({ displayName: serving.endpoints[0].name });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses stable opaque identifiers across scans and restarts, and never writes tokens into generations', async () => {
    const { service, profileId, dataRoot } = await setup();
    const first = await scan(service, profileId);
    const pointerPath = join(dataRoot, 'databricks', 'current.json');
    const firstPointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const firstBytes = await readFile(join(dataRoot, 'databricks', firstPointer.file), 'utf8');
    const second = await scan(service, profileId);
    expect(second.endpoints.map((endpoint) => [endpoint.id, endpoint.appModelId])).toEqual(first.endpoints.map((endpoint) => [endpoint.id, endpoint.appModelId]));
    expect(await readFile(join(dataRoot, 'databricks', firstPointer.file), 'utf8')).toBe(firstBytes);
    const currentPointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    expect(currentPointer.file).not.toBe(firstPointer.file);
    const currentBytes = await readFile(join(dataRoot, 'databricks', currentPointer.file), 'utf8');
    for (const bytes of [firstBytes, currentBytes]) {
      expect(bytes).not.toContain('private-bearer'); expect(bytes).not.toContain('access_token'); expect(bytes).not.toContain('Authorization');
    }
    const enabled = await service.enable(second.endpoints[0]!.id, { scanId: second.scanId, expectedRevision: second.revision });
    const restart = createDatabricksService({ dataRoot, clientOptions: { runner: runner(), resolveExecutable: async () => 'databricks.exe' }, fetch: workspaceFetch, now: () => now });
    expect((await restart.resolveRuntime(enabled.appModelId)).apiKey).toBe('private-bearer');
    expect((await restart.getScan(first.scanId)).endpoints).toEqual(first.endpoints);
    expect((await restart.status()).profiles[0]!.id).toBe(profileId);
  });

  it('consumes continuation tokens at serving, catalog, schema, and model-service levels', async () => {
    const requested: string[] = [];
    const { service, profileId } = await setup({ fetch: async (raw, init) => {
      const url = new URL(raw); requested.push(url.pathname + url.search);
      const fields: Record<string, string> = { '/api/2.0/serving-endpoints': 'endpoints', '/api/2.1/unity-catalog/catalogs': 'catalogs', '/api/2.1/unity-catalog/schemas': 'schemas', '/api/2.1/unity-catalog/model-services': 'model_services' };
      const field = fields[url.pathname];
      if (field && !url.searchParams.has('page_token')) return json({ [field]: [], next_page_token: 'private-continuation' });
      return workspaceFetch(raw, init);
    } });
    const result = await scan(service, profileId);
    expect(result.state).toBe('complete');
    expect(requested.filter((url) => url.includes('page_token=private-continuation'))).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain('private-continuation');
  });

  it('detects repeated tokens and returns partial counters rather than an empty complete result', async () => {
    const { service, profileId } = await setup({ fetch: async (raw, init) => new URL(raw).pathname === '/api/2.0/serving-endpoints'
      ? json({ endpoints: serving.endpoints.slice(0, 1), next_page_token: 'repeat' }) : workspaceFetch(raw, init) });
    const result = await scan(service, profileId);
    expect(result.state).toBe('partial');
    expect(result.completeness).toEqual({ serving: false, uc: true, truncated: true });
    expect(result.endpoints).toHaveLength(3);
    expect(result.counters.scopesInaccessible).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain('DATABRICKS_UPSTREAM_UNAVAILABLE');
  });

  it('keeps readable serving results when a UC scope denies permission', async () => {
    const { service, profileId } = await setup({ fetch: async (raw, init) => new URL(raw).pathname === '/api/2.1/unity-catalog/schemas'
      ? json({ message: `${host} private-bearer` }, 403) : workspaceFetch(raw, init) });
    const result = await scan(service, profileId);
    expect(result.state).toBe('partial');
    expect(result.completeness).toEqual({ serving: true, uc: false, truncated: false });
    expect(result.counters.scopesInaccessible).toBe(1);
    expect(result.endpoints).toHaveLength(8);
    expect(result.issues[0]!.code).toBe('DATABRICKS_PERMISSION_DENIED');
    assertPublic(result);
  });

  it('bounds a hung branch and preserves the completed branch', async () => {
    vi.useFakeTimers();
    try {
      const requested = deferred<void>();
      const { service, profileId } = await setup({ scanOptions: { branchTimeoutMs: 500, requestTimeoutMs: 300 }, fetch: async (raw, init) => {
        if (new URL(raw).pathname === '/api/2.1/unity-catalog/catalogs') { requested.resolve(); return new Promise<Response>(() => {}); }
        return workspaceFetch(raw, init);
      } });
      const started = await service.startScan({ profileId });
      const finished = done(service, started.scanId);
      await requested.promise;
      await vi.advanceTimersByTimeAsync(300);
      const result = await finished;
      expect(result.state).toBe('partial'); expect(result.completeness.serving).toBe(true);
      expect(result.completeness.truncated).toBe(true); expect(result.endpoints).toHaveLength(8);
    } finally { vi.useRealTimers(); }
  });

  it('runs branches concurrently and cancels both without waiting for an uncooperative fetch', async () => {
    const servingStarted = deferred<void>(); const ucStarted = deferred<void>();
    const signals: AbortSignal[] = [];
    const { service, profileId } = await setup({ fetch: async (raw, init) => {
      signals.push(init.signal!);
      if (new URL(raw).pathname === '/api/2.0/serving-endpoints') servingStarted.resolve(); else ucStarted.resolve();
      return new Promise<Response>(() => {});
    } });
    const started = await service.startScan({ profileId });
    const finished = done(service, started.scanId);
    await withDeadline(() => Promise.all([servingStarted.promise, ucStarted.promise]), 5000);
    const cancelled = await service.cancelScan(started.scanId);
    expect(cancelled.state).toBe('cancelled'); expect((await finished).state).toBe('cancelled');
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await service.listModels()).models).toEqual([]);
  });

  it('pages public snapshots using daemon cursors and rejects stale revisions', async () => {
    const { service, profileId } = await setup();
    const result = await scan(service, profileId);
    const first = await service.getScan(result.scanId, { limit: 3 });
    expect(first.endpoints).toHaveLength(3); expect(first.cursor).not.toBeNull();
    const second = await service.getScan(result.scanId, { cursor: first.cursor!, limit: 3 });
    expect(second.endpoints).toEqual(result.endpoints.slice(3, 6));
    await expect(service.enable(result.endpoints[0]!.id, { scanId: result.scanId, expectedRevision: result.revision - 1 })).rejects.toMatchObject({ code: 'DATABRICKS_STALE_REVISION' });
    await expect(service.startScan({ profileId, scopeIds: ['unknown'] })).rejects.toMatchObject({ code: 'DATABRICKS_SCAN_EXPIRED' });
    await scan(service, profileId);
    await expect(service.enable(result.endpoints[0]!.id, { scanId: result.scanId, expectedRevision: result.revision })).rejects.toMatchObject({ code: 'DATABRICKS_STALE_REVISION' });
  });

  it('looks up an opaque known resource through direct GET and shares the enable revision store', async () => {
    const { service, profileId } = await setup(); const result = await scan(service, profileId);
    const endpoint = result.endpoints.find((candidate) => candidate.api === 'anthropic-messages')!;
    const lookedUp = await service.lookup({ profileId, resourceId: endpoint.id, kind: endpoint.kind });
    expect(lookedUp.endpoint.id).toBe(endpoint.id);
    expect((await service.enable(endpoint.id, { scanId: lookedUp.scanId, expectedRevision: lookedUp.revision })).endpoint.enabled).toBe(true);
    assertPublic(lookedUp);
  });

  it('requires explicit inference consent and only marks checks actually exercised as passed', async () => {
    const inference: Array<Record<string, unknown>> = [];
    const { service, profileId } = await setup({ fetch: async (raw, init) => {
      if (init.method !== 'POST') return workspaceFetch(raw, init);
      const body = JSON.parse(String(init.body)); inference.push(body);
      expect(body.model).toBe(claude.name.replace('model-services/', ''));
      if (body.stream) return new Response(claudeStream, { headers: { 'content-type': 'text/event-stream' } });
      if (body.tools) return json({ ...claudeMessage.response.body, content: [{ type: 'tool_use', id: 'test-tool', name: 'readable_probe', input: { ok: true } }] });
      expect(body.thinking).toEqual({ type: 'adaptive' }); expect(body.output_config).toEqual({ effort: 'high' });
      return json(claudeMessage.response.body);
    } });
    const result = await scan(service, profileId);
    expect(inference).toEqual([]);
    const endpoint = result.endpoints.find((candidate) => candidate.api === 'anthropic-messages')!;
    await expect(service.verify(endpoint.id, { scanId: result.scanId, expectedRevision: result.revision, allowInference: false as true })).rejects.toMatchObject({ code: 'DATABRICKS_VERIFICATION_REQUIRED' });
    expect(inference).toEqual([]);
    const verified = await service.verify(endpoint.id, { scanId: result.scanId, expectedRevision: result.revision, allowInference: true });
    expect(verified.result).toBe('passed'); expect(verified.checks).toEqual({ streaming: 'passed', tools: 'passed', effort: 'passed' });
    expect(verified.endpoint.capabilities.tools).toBe('supported'); expect(verified.endpoint.evidence).toBe('verified');
    expect(inference).toHaveLength(3); assertPublic(verified);
  });
});

describe('CLI and expiry boundaries', () => {
  it.each([
    ['missing', null, ''], ['uninvocable', 'databricks.exe', 'throw'],
    ['unsupported', 'databricks.exe', 'Databricks CLI v0.18.0'], ['ready', 'databricks.exe', 'Databricks CLI v0.278.0'],
  ] as const)('distinguishes %s', async (expected, executable, stdout) => {
    const client = new DatabricksClient({ resolveExecutable: async () => executable, runner: async () => {
      if (stdout === 'throw') throw new Error('private path'); return { stdout, stderr: '', exitCode: 0 };
    } });
    expect((await client.probe()).cli).toBe(expected);
  });

  it('passes an explicit executable override without shell interpolation', async () => {
    const resolveExecutable = vi.fn(async (override?: string | null) => override!);
    const cliRunner = runner();
    const client = new DatabricksClient({ executablePath: 'C:\\user tools\\databricks.exe', resolveExecutable, runner: cliRunner });
    expect((await client.probe()).cli).toBe('ready');
    expect(resolveExecutable).toHaveBeenCalledWith('C:\\user tools\\databricks.exe');
    expect(vi.mocked(cliRunner).mock.calls[0]!.slice(0, 2)).toEqual(['C:\\user tools\\databricks.exe', ['--version']]);
  });

  it('refreshes by absolute expiry with an injected clock and coalesces concurrent refresh callers', async () => {
    let clock = now; let calls = 0;
    const refreshStarted = deferred<void>(); const refresh = deferred<unknown>();
    const client = new DatabricksClient({ resolveExecutable: async () => 'databricks.exe', runner: async (_executable, args) => {
      if (args[0] === '--version') return { stdout: 'Databricks CLI v0.278.0', stderr: '', exitCode: 0 };
      calls++; expect(args).toEqual(['auth', 'token', '--profile', profileName]);
      const payload = calls === 1 ? { access_token: 'first', expiry: new Date(now + 600_000).toISOString(), expires_in: 999999 }
        : (refreshStarted.resolve(), await refresh.promise);
      return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 };
    } });
    await client.probe();
    const credentials = new DatabricksCredentials(client, () => clock);
    const binding = { id: 'opaque', profileName, host, isDefault: false };
    expect(await credentials.acquire(binding)).toBe('first');
    clock = now + 479_999;
    expect(await credentials.acquire(binding)).toBe('first'); expect(calls).toBe(1);
    clock = now + 480_000;
    const a = credentials.acquire(binding); const b = credentials.acquire(binding);
    await refreshStarted.promise; expect(calls).toBe(2);
    refresh.resolve({ access_token: 'second', expiry: new Date(clock + 600_000).toISOString() });
    expect(await Promise.all([a, b])).toEqual(['second', 'second']);
  });

  it.each([
    ['keyring is locked private-bearer', 'DATABRICKS_KEYRING_UNAVAILABLE'],
    ['network unreachable private-bearer', 'DATABRICKS_UPSTREAM_UNAVAILABLE'],
    ['authentication expired private-bearer', 'DATABRICKS_AUTH_REQUIRED'],
    ['unknown command token', 'DATABRICKS_CLI_UNSUPPORTED'],
  ] as const)('surfaces a typed sanitized failure for %s without using stale cache', async (stderr, code) => {
    let clock = now; let calls = 0;
    const client = new DatabricksClient({ resolveExecutable: async () => 'databricks.exe', runner: async (_executable, args) => {
      if (args[0] === '--version') return { stdout: 'Databricks CLI v0.278.0', stderr: '', exitCode: 0 };
      calls++;
      return calls === 1 ? { stdout: JSON.stringify({ access_token: 'private-bearer', expiry: new Date(now + 600_000).toISOString() }), stderr: '', exitCode: 0 }
        : { stdout: '', stderr, exitCode: 1 };
    } });
    await client.probe(); const credentials = new DatabricksCredentials(client, () => clock);
    const binding = { id: 'opaque', profileName, host, isDefault: false };
    expect(await credentials.acquire(binding)).toBe('private-bearer'); clock += 600_000;
    await expect(credentials.acquire(binding)).rejects.toMatchObject({ code, message: code });
  });

  it.each([{ access_token: 'private-bearer', expires_in: 3600 }, { access_token: 'private-bearer', expiry: '2020-01-01T00:00:00Z' }])('rejects relative-only or expired CLI tokens', async (payload) => {
    const client = new DatabricksClient({ resolveExecutable: async () => 'databricks.exe', runner: async (_exe, args) => ({ stdout: args[0] === '--version' ? 'Databricks CLI v0.278.0' : JSON.stringify(payload), stderr: '', exitCode: 0 }) });
    await client.probe();
    await expect(new DatabricksCredentials(client, () => now).acquire({ id: 'opaque', profileName, host, isDefault: false })).rejects.toBeInstanceOf(DatabricksServiceError);
  });

  it('does not infer a protocol from a model name or conflicting routing metadata', () => {
    expect(classifyProtocol({ kind: 'uc-model-service', name: 'claude-openai-gpt', metadata: {} })).toBeNull();
    const contradictory = structuredClone(claude);
    contradictory.config.routing.destinations[0].external_model_config.target.native_api_types = [];
    expect(classifyProtocol({ kind: 'uc-model-service', name: claude.name, metadata: contradictory })).toBeNull();
    expect(classifyProtocol({ kind: 'uc-model-service', name: 'arbitrary-name', metadata: claude })).toBe('anthropic-messages');
  });
});
