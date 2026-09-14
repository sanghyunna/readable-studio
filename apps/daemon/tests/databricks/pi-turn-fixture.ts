import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabricksSubprocessRunner } from '../../src/databricks/client.js';
import { fixtureStream, protocolFixture } from './runtime-fixture.js';

export const upstreamHost = 'https://pi-turn-workspace.invalid';
export const upstreamBearer = 'dapi_FIXTURE_UPSTREAM_NEVER_IN_PI_CHILD';
export const fixtureNow = Date.parse('2026-09-10T12:00:00Z');
const profileName = 'Fixture profile with spaces';

export const fixtureCliRunner: DatabricksSubprocessRunner = async (_executable, args) => {
  let payload: unknown;
  if (args.length === 1 && args[0] === '--version') {
    return { stdout: 'Databricks CLI v0.278.0', stderr: '', exitCode: 0 };
  }
  if (args[1] === 'profiles') {
    assert.deepEqual(args, ['auth', 'profiles', '--output', 'json']);
    payload = { profiles: [{ name: profileName, host: upstreamHost, is_default: true }] };
  } else {
    assert.deepEqual(args, ['auth', 'token', '--profile', profileName]);
    payload = { access_token: upstreamBearer, expiry: new Date(fixtureNow + 3_600_000).toISOString() };
  }
  return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 };
};

export interface GatewayRequest {
  path: string;
  authorization: string | undefined;
  body: { model: string; stream: boolean; messages: Array<{ role: string; content: unknown }>; input: Array<{ role: string; content: unknown }> } & Record<string, unknown>;
}

/** Real TCP fixture upstream. Only CLI acquisition and the upstream origin are substituted. */
export async function createPiTurnFixture() {
  const directory = new URL('./fixtures/', import.meta.url);
  const [serving, services, claudeMetadata] = await Promise.all([
    'serving-endpoints-list.json', 'uc-model-services-list.json', 'uc-model-service-get.json',
  ].map(async (name) => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  const luna = protocolFixture('openai-completions');
  const claude = protocolFixture('anthropic-messages');
  const [catalog, schema] = luna.request.body.model.split('.');
  const requests: GatewayRequest[] = [];
  const errors: string[] = [];
  const routes: string[] = [];
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers.authorization, `Bearer ${upstreamBearer}`);
    const url = new URL(request.url!, upstreamHost);
    routes.push(url.pathname);
    if (request.method === 'GET') {
      if (url.pathname === '/api/2.0/serving-endpoints') return json(response, serving);
      if (url.pathname === '/api/2.1/unity-catalog/catalogs') return json(response, { catalogs: [{ name: catalog }] });
      if (url.pathname === '/api/2.1/unity-catalog/schemas') {
        assert.equal(url.searchParams.get('catalog_name'), catalog);
        return json(response, { schemas: [{ name: schema }] });
      }
      if (url.pathname === '/api/2.1/unity-catalog/model-services') {
        assert.equal(url.searchParams.get('parent'), `schemas/${catalog}.${schema}`);
        assert.equal(url.searchParams.get('view'), 'FULL');
        return json(response, services);
      }
      const resource = decodeURIComponent(url.pathname).replace('/api/2.1/unity-catalog/model-services/', '');
      if (resource === claude.request.body.model) return json(response, claudeMetadata);
      if (resource === luna.request.body.model) {
        // The capture has Luna's list entry and wire response, not a separate GET.
        // Derive its metadata using the same UC routing shape as the Claude GET.
        const metadata = structuredClone(claudeMetadata);
        metadata.name = `model-services/${resource}`;
        metadata.supported_api_types = ['mlflow/v1/chat/completions'];
        const target = metadata.config.routing.destinations[0].external_model_config.target;
        target.native_api_types = ['openai/v1/chat/completions'];
        target.model = luna.response.body.model;
        return json(response, metadata);
      }
    }
    assert.equal(request.method, 'POST');
    const anthropic = url.pathname === '/ai-gateway/anthropic/v1/messages';
    const responses = url.pathname === '/ai-gateway/openai/v1/responses';
    assert.ok(anthropic || responses || url.pathname === '/ai-gateway/openai/v1/chat/completions', `Unexpected fixture route: ${url.pathname}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: GatewayRequest['body'] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: url.pathname, authorization: request.headers.authorization, body });
    const fixture = anthropic ? claude : luna;
    assert.equal(body.model, fixture.request.body.model);
    if (anthropic) assert.equal(request.headers['anthropic-version'], '2023-06-01');
    if (!body.stream) return json(response, fixture.response.body, fixture.response.status);
    if (responses) {
      assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.equal(body.reasoning_effort, undefined);
      assert.ok(Array.isArray(body.input));
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(responses ? await readFile(new URL('luna-responses-stream.txt', directory), 'utf8')
      : fixtureStream(anthropic ? 'anthropic-messages' : 'openai-completions'));
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
      json(response, { error: { message: 'Fixture protocol assertion failed' } }, 500);
    });
  });
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Fail closed: no DNS or cloud request, including on an unexpected URL.
    assert.equal(url.origin, upstreamHost);
    assert.equal(init?.redirect, 'error');
    return nativeFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  return {
    requests, errors, routes, fetch: localFetch,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
