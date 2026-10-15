import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { createDatabricksPiRuntime } from '../../src/runtimes/pi-databricks.js';
import { chatStream, completed, json, namedFixture } from './named-fixture.js';

async function fixture(statuses: number[] = [200], model = 'databricks-claude-sonnet-5', enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'claude-probe-'));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    requests.push(JSON.parse(text));
    expect(request.url).toBe('/ai-gateway/anthropic/v1/messages');
    const status = statuses.shift() ?? 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    const body = requests.at(-1)!;
    if (status === 200 && body.stream) {
      response.end('data: {"type":"message_stop"}\n\n');
      return;
    }
    response.end(JSON.stringify(status === 200 ? { type: 'message', content: body.tools
      ? [{ type: 'tool_use', name: 'readable_probe', input: { ok: true } }] : [{ type: 'text', text: 'OK' }] }
      : { error: { message: status === 422 ? 'output_config.effort high is unsupported' : 'Messages unavailable' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const entry = normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: 'corporate-alias',
    metadata: { task: 'llm/v1/chat', config: { served_entities: [{ foundation_model: { name: model } }] } } });
  entry.endpoint.enabled = enabled;
  const store = new DatabricksStore(root);
  await store.update(next => {
    next.bindings = [{ id: 'profile', host: 'https://workspace.example', profileName: 'test', isDefault: true }];
    next.entries = [entry];
    next.scans = [{ scanId: 'scan', profileId: 'profile', state: 'complete', revision: 1, createdAt: new Date().toISOString(),
      startedAt: null, completedAt: null, endpoints: [entry.endpoint], cursor: null, issues: [],
      counters: { scopesChecked: 1, scopesInaccessible: 0, candidates: 1, excluded: 0 }, completeness: { serving: true, uc: true, truncated: false } }];
  });
  let now = Date.now();
  const options = { dataRoot: root, now: () => now,
    fetch: (url: string, init: RequestInit) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init),
    clientOptions: { resolveExecutable: async () => 'test.exe', runner: async (_executable: string, args: readonly string[]) => ({
      stdout: args[0] === '--version' ? 'Databricks CLI v0.278.0' : JSON.stringify({ access_token: 'token', expiry: '2099-01-01T00:00:00Z' }), stderr: '', exitCode: 0,
    }) } };
  const service = createDatabricksService(options);
  return { service, root, requests, entry, advance: () => { now += 60_001; },
    restart: () => createDatabricksService(options),
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); } };
}

test('task-only Claude lazily probes once, persists measured high and launches Pi with thinking high', async () => {
  const f = await fixture();
  try {
    const before = await f.service.listModels();
    expect(before.models[0]?.api).toBe('openai-completions');
    expect(before.models[0]?.reasoningOptions).toEqual([]);
    await Promise.all([f.service.listModels(), f.service.listModels()]);
    const runtime = await f.service.resolveRuntime(f.entry.endpoint.appModelId!);
    expect(runtime.api).toBe('anthropic-messages');
    expect(runtime.reasoningOptions).toEqual(['high']);
    expect(f.requests).toHaveLength(1);
    await runtime.onCapabilitiesLearned!({ api: 'anthropic-messages', responsesUnsupported: false,
      chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [], tools: 'supported', toolsCompletionVersion: 1 });
    expect((await f.service.listModels()).models[0]?.reasoningOptions?.map(option => option.id)).toEqual(['high']);
    expect(f.requests[0]).toMatchObject({ max_tokens: 16, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(f.requests[0]).not.toHaveProperty('reasoning_effort');
    const saved = (await new DatabricksStore(f.root).read()).entries[0]!;
    expect(saved.wireCapabilities).toMatchObject({ api: 'anthropic-messages', acceptedLevels: ['high'], probedAt: expect.any(String) });
    const normalized = normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: 'corporate-alias',
      metadata: { task: 'llm/v1/chat', config: { served_entities: [{ foundation_model: { name: 'databricks-claude-sonnet-5' } }] } } }, saved);
    expect(normalized.endpoint.reasoningOptions?.map(option => option.id)).toEqual(['high']);
    const changed = normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: 'corporate-alias',
      metadata: { task: 'llm/v1/chat', config: { served_entities: [{ foundation_model: { name: 'gpt-oss-120b' } }] } } }, saved);
    expect(changed.wireCapabilities).toBeUndefined();
    expect(changed.endpoint.api).toBe('openai-completions');
    const restarted = f.restart();
    expect((await restarted.listModels()).models[0]?.reasoningOptions?.map(option => option.id)).toEqual(['high']);
    const pi = await createDatabricksPiRuntime({ dataRoot: f.root, cwd: f.root, sessionKey: 'learned', model: f.entry.endpoint.appModelId!, service: restarted });
    try { expect(pi.invocation.args.slice(pi.invocation.args.indexOf('--thinking'), pi.invocation.args.indexOf('--thinking') + 2)).toEqual(['--thinking', 'high']); }
    finally { await pi.close(); }
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test('registration schedules the same one-shot probe without waiting for the picker', async () => {
  const f = await fixture([200], 'databricks-claude-sonnet-5', false);
  try {
    await f.service.enable(f.entry.endpoint.id, { scanId: 'scan', expectedRevision: 1 });
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).reasoningOptions).toEqual(['high']);
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test('manual alias registration probes the served Claude identity, not the alias', async () => {
  const messages: Record<string, unknown>[] = [];
  const f = await namedFixture(async (url, init) => {
    if (init.method !== 'POST') return json({ task: 'llm/v1/chat',
      config: { served_entities: [{ foundation_model: { name: 'databricks-claude-sonnet-5' } }] } });
    if (new URL(url).pathname.endsWith('/messages')) {
      messages.push(JSON.parse(String(init.body)));
      return json({ type: 'message', content: [{ type: 'text', text: 'OK' }] });
    }
    return chatStream(true);
  });
  const scan = await completed(f.service, (await f.service.startNamedScan({ profileId: f.profileId,
    names: 'corporate-alias', allowInference: true })).scanId);
  const endpoint = scan.endpoints[0]!;
  await f.service.enable(endpoint.id, { scanId: scan.scanId, expectedRevision: scan.revision });
  const runtime = await f.service.resolveRuntime(endpoint.appModelId!);
  expect(runtime.api).toBe('anthropic-messages');
  expect(runtime.reasoningOptions).toEqual(['high']);
  expect(runtime.wireCapabilities?.namedProfile).toMatchObject({ api: 'anthropic-messages', reasoning: ['high'] });
  expect(messages).toHaveLength(1);
});

test('explicit verification learns Messages once and reuses its measured effort check', async () => {
  const f = await fixture([200], 'databricks-claude-sonnet-5', false);
  try {
    const result = await f.service.verify(f.entry.endpoint.id, { scanId: 'scan', expectedRevision: 1, allowInference: true });
    expect(result.endpoint.api).toBe('anthropic-messages');
    expect(result.checks.effort).toBe('passed');
    expect(f.requests.filter(body => body.max_tokens === 16)).toHaveLength(1);
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

test('an explicit high-effort rejection tries only medium and advertises only that accepted level', async () => {
  const f = await fixture([422, 200]);
  try {
    await f.service.listModels();
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).reasoningOptions).toEqual(['medium']);
    expect(f.requests.map(body => body.output_config)).toEqual([{ effort: 'high' }, { effort: 'medium' }]);
  } finally { await f.close(); }
});

test('definitive Messages rejection stays Chat and is not probed after restart', async () => {
  const f = await fixture([400]);
  try {
    await f.service.listModels();
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).reasoningOptions).toEqual([]);
    const restarted = f.restart();
    await restarted.listModels();
    expect((await restarted.resolveRuntime(f.entry.endpoint.appModelId!)).api).toBe('openai-completions');
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test('transient 503 is debounced and retried later rather than persisted as definitive', async () => {
  const f = await fixture([503, 200]);
  try {
    await f.service.listModels();
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).api).toBe('openai-completions');
    await f.service.listModels();
    await f.service.resolveRuntime(f.entry.endpoint.appModelId!);
    expect(f.requests).toHaveLength(1);
    f.advance();
    await f.service.listModels();
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).reasoningOptions).toEqual(['high']);
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test('non-Claude served identity never incurs a Messages probe', async () => {
  const f = await fixture([200], 'gpt-oss-120b');
  try {
    await f.service.listModels();
    expect((await f.service.resolveRuntime(f.entry.endpoint.appModelId!)).api).toBe('openai-completions');
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});
