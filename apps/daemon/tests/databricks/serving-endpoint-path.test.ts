import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { listenOnFetchCompatiblePort } from '../../src/fetch-compatible-listener.js';
import { fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';

// Fixture from the owner's measured workspace facts. No endpoint_url is supplied.
const resource = { kind: 'serving-endpoint' as const, name: 'databricks-gpt-oss-120b', metadata: {
  name: 'databricks-gpt-oss-120b', task: 'llm/v1/chat', ai_gateway: {},
  config: { served_entities: [{ entity_name: 'system.ai.gpt-oss-120b' }] },
} };
const invocationPath = '/serving-endpoints/databricks-gpt-oss-120b/invocations';
const tools = [{ type: 'function', function: { name: 'readable_probe', parameters: {
  type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'],
} } }];
const completion = { model: 'system.ai.gpt-oss-120b', choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'call_probe', type: 'function', function: { name: 'readable_probe', arguments: '{"ok":true}' } }],
}, finish_reason: 'tool_calls' }] };

test('catalogue uses the endpoint route identity, not its served model, and encodes one path segment', () => {
  const entry = normalizeResource('secret', 'profile', resource);
  expect(entry.basePath).toBe(invocationPath);
  expect(entry.upstreamName).toBe(resource.name);
  expect(entry.endpoint.servedModelName).toBe('system.ai.gpt-oss-120b');
  expect(normalizeResource('secret', 'profile', { ...resource, name: 'route /?#' }).basePath)
    .toBe('/serving-endpoints/route%20%2F%3F%23/invocations');
});

for (const legacy of [false, true]) test(`serving invocation survives restart and carries tools without model (legacy=${legacy})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'serving-invocation-'));
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const workspace = await listenOnFetchCompatiblePort(createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === `/api/2.0/serving-endpoints/${resource.name}`) {
      response.end(JSON.stringify(resource.metadata)); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ path: request.url!, body });
    // A strict fixture enforces the measured successful shape; it does not claim
    // the real workspace has been measured rejecting an extra model field.
    if (request.url !== invocationPath) {
      response.writeHead(404); response.end(JSON.stringify({ error_code: 'ENDPOINT_NOT_FOUND' })); return;
    }
    if (Object.hasOwn(body, 'model') || Object.hasOwn(body, 'input')) {
      response.writeHead(400); response.end(JSON.stringify({ message: 'Expected model-free Chat invocation' })); return;
    }
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ ...completion, choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else response.end(JSON.stringify(completion));
  }));
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${workspace.port}${url.pathname}${url.search}`, init);
  };
  const makeService = () => createDatabricksService({ dataRoot: root, now: () => fixtureNow,
    clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' },
    resolveResource: async () => resource.name, fetch: transport,
  });
  try {
    const service = makeService();
    const profileId = (await service.probe()).profiles[0]!.id;
    const found = await service.lookup({ profileId, resourceId: 'fixture', kind: 'serving-endpoint' });
    const registered = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
    if (legacy) await new DatabricksStore(root).update(generation => {
      generation.entries[0]!.basePath = '/serving-endpoints';
      // An old Responses recipe must not divert a serving invocation.
      generation.entries[0]!.wireCapabilities = { responsesUnsupported: false,
        responsesPath: '/ai-gateway/codex/v1/responses', chatTokensField: 'max_tokens',
        requiredOutputBudget: false, omittedFields: [] };
    });
    const restarted = makeService();
    const runtime = await restarted.resolveRuntime(registered.appModelId);
    expect(new URL(runtime.baseUrl).pathname).toBe(invocationPath);
    expect(runtime.model).toBe(resource.name);
    const relay = await createDatabricksRelay({ runtime, fetch: transport });
    try {
      for (const withTools of [false, true]) {
        const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
          signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${relay.capabilityKey}` },
          body: JSON.stringify({ model: relay.modelAlias, max_tokens: 64,
            messages: [{ role: 'user', content: 'Reply OK.' }], ...(withTools ? { tools } : {}) }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: relay.modelAlias, choices: completion.choices });
      }
      // The child surface is Chat; Responses input is not forwarded to invocations.
      const denied = await fetch(`${relay.baseUrl}/responses`, { method: 'POST',
        signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, input: [] }),
      });
      expect(denied.status).toBe(403); await denied.text();
      expect(requests).toHaveLength(2);
      expect(requests.map(request => request.path)).toEqual([invocationPath, invocationPath]);
      expect(requests[0]!.body).toEqual({ max_tokens: 64, messages: [{ role: 'user', content: 'Reply OK.' }] });
      expect(requests[1]!.body).toEqual({ ...requests[0]!.body, tools });
    } finally { await relay.close(); }
    // The owner verification surface must use exactly the same model-free route.
    const verified = await restarted.verify(found.endpoint.id, { scanId: found.scanId,
      expectedRevision: found.revision, allowInference: true });
    expect(verified.checks).toEqual({ streaming: 'passed', tools: 'passed', effort: 'passed' });
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.path).toBe(invocationPath);
      expect(Object.hasOwn(request.body, 'model')).toBe(false);
    }
    const saved = (await new DatabricksStore(root).read()).entries[0]!;
    expect(saved.basePath).toBe(invocationPath);
    expect(saved.endpoint.appModelId).toBe(registered.appModelId);
    expect(saved.upstreamName).toBe(resource.name);
  } finally {
    workspace.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => workspace.server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
