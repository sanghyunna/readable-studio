import type { Server } from 'node:http';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHostedServer } from '../src/hosted-server.js';

const PUBLIC_ORIGIN = 'https://hosted.readable-studio.test';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const GATEWAY_MODEL = 'anthropic/claude-sonnet-4.5';
const USER_A = 'test-user-a';
const USER_B = 'test-user-b';
const SECRET_A = 'anthropic-sentinel-user-a';
const SECRET_A_ROTATED = 'second-credential-alpha';
const SECRET_B = 'gateway-sentinel-user-b';
const REJECTED_SECRET = 'reject-this-secret-sentinel';
const SENTINELS = [SECRET_A, SECRET_A_ROTATED, SECRET_B, REJECTED_SECRET];

type StartedServer = Awaited<ReturnType<typeof startHostedServer>>;

interface ProviderRequest {
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly method: string | undefined;
  readonly path: string | undefined;
}

interface ProviderFixture {
  readonly origin: string;
  readonly requests: ProviderRequest[];
  readonly server: Server;
}

const startedServers: StartedServer[] = [];
const originalProviderEnv = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  gateway: process.env.AI_GATEWAY_API_KEY,
};
let anthropicFixture: ProviderFixture;
let gatewayFixture: ProviderFixture;

beforeAll(async () => {
  [anthropicFixture, gatewayFixture] = await Promise.all([
    startProviderFixture(),
    startProviderFixture(),
  ]);
});

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map(closeHostedServer));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all([closeServer(anthropicFixture.server), closeServer(gatewayFixture.server)]);
  restoreEnv('ANTHROPIC_API_KEY', originalProviderEnv.anthropic);
  restoreEnv('AI_GATEWAY_API_KEY', originalProviderEnv.gateway);
});

describe('provider-only hosted server', () => {
  it('keeps only exact probes open and otherwise fails closed without identity', async () => {
    const started = await start({ productionIdentity: true });

    for (const path of ['/api/health', '/api/ready', '/api/version']) {
      const response = await fetch(`${started.url}${path}`);
      expect(response.status, path).toBe(200);
    }

    for (const path of ['/api/hosted/session', '/api/projects']) {
      await expectError(
        fetch(`${started.url}${path}`),
        503,
        'HOSTED_AUTH_UNAVAILABLE',
      );
    }

    for (const path of [
      '/api/app-config',
      '/api/projects/project-a/terminals',
      '/api/provider/models',
      '/api/hosted/provider/test/extra',
      '/definitely-not-a-hosted-route',
    ]) {
      await expectError(
        fetch(`${started.url}${path}`, { headers: auth(USER_A) }),
        404,
        'HOSTED_ROUTE_NOT_ALLOWED',
      );
    }
  });

  it('dispatches only exact methods and paths without rotating the session nonce', async () => {
    const started = await start();
    const session = await getSession(started, USER_A);

    for (const path of [
      '/api/hosted/session/',
      '/api/Hosted/session',
      '/API/hosted/session',
    ]) {
      await expectError(
        fetch(`${started.url}${path}`, { headers: auth(USER_A) }),
        404,
        'HOSTED_ROUTE_NOT_ALLOWED',
      );
    }
    const head = await fetch(`${started.url}/api/hosted/session`, {
      method: 'HEAD',
      headers: auth(USER_A),
    });
    expect(head.status).toBe(404);

    expect(await getProviderStatus(started, USER_A)).toEqual({
      provider: null,
      configured: false,
    });
    expect(await mutate(
      started,
      USER_A,
      session.csrfToken,
      'PUT',
      '/api/hosted/provider',
      { provider: 'anthropic', key: SECRET_A },
    )).toEqual({ result: 'set', provider: 'anthropic', configured: true });
  });

  it('admits test identities only through testComposition and returns no identity data', async () => {
    const started = await start();

    await expectError(
      fetch(`${started.url}/api/hosted/session`),
      401,
      'HOSTED_AUTH_REQUIRED',
    );

    const sessionA = await getSession(started, USER_A);
    const sessionB = await getSession(started, USER_B);

    expect(sessionA).toEqual({
      publicOrigin: PUBLIC_ORIGIN,
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/u),
      csrfExpiresAt: expect.any(Number),
      providers: [
        { id: 'anthropic', model: ANTHROPIC_MODEL },
        { id: 'vercel-ai-gateway', model: GATEWAY_MODEL },
      ],
    });
    expect(sessionB).toEqual({
      ...sessionA,
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/u),
      csrfExpiresAt: expect.any(Number),
    });
    expect(sessionB.csrfToken).not.toBe(sessionA.csrfToken);

    const serialized = JSON.stringify([sessionA, sessionB]);
    for (const privateValue of [USER_A, USER_B, 'storage-a', 'storage-b', 'Alice', 'Bob']) {
      expect(serialized).not.toContain(privateValue);
    }
    for (const serverOwnedValue of [
      'https://api.anthropic.com',
      'https://ai-gateway.vercel.sh',
      'ANTHROPIC_API_KEY',
      'AI_GATEWAY_API_KEY',
    ]) {
      expect(serialized).not.toContain(serverOwnedValue);
    }
  });

  it('cannot activate or mix the test identity composition in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const fixtureRequestCount = anthropicFixture.requests.length + gatewayFixture.requests.length;
    let resolverCalls = 0;
    try {
      process.env.NODE_ENV = 'production';
      const started = await startHostedServer({
        port: 0,
        host: '127.0.0.1',
        publicOrigin: PUBLIC_ORIGIN,
        testComposition: {
          resolveIdentity() {
            resolverCalls += 1;
            return { userKey: USER_A, sessionKey: 'session-a' };
          },
          providerBaseUrls: {
            anthropic: anthropicFixture.origin,
            'vercel-ai-gateway': gatewayFixture.origin,
          },
        },
      });
      startedServers.push(started);
      await expectError(
        fetch(`${started.url}/api/hosted/session`, { headers: auth(USER_A) }),
        503,
        'HOSTED_AUTH_UNAVAILABLE',
      );
      expect(resolverCalls).toBe(0);
      expect(anthropicFixture.requests.length + gatewayFixture.requests.length)
        .toBe(fixtureRequestCount);
    } finally {
      restoreEnv('NODE_ENV', previousNodeEnv);
    }

    const resolveIdentity = () => ({ userKey: USER_A, sessionKey: 'session-a' });
    await expect(startHostedServer({
      port: 0,
      host: '127.0.0.1',
      publicOrigin: PUBLIC_ORIGIN,
      identityAdapter: { resolveIdentity },
      testComposition: { resolveIdentity },
    })).rejects.toThrow(/mutually exclusive/u);
  });

  it('requires trusted Origin and the owning identity CSRF token for every mutation', async () => {
    const started = await start();
    const sessionA = await getSession(started, USER_A);
    const sessionB = await getSession(started, USER_B);
    const body = JSON.stringify({ provider: 'anthropic', key: SECRET_A });

    for (const origin of [undefined, 'null', 'https://preview.readable-studio.test', 'https://attacker.test']) {
      await expectError(
        fetch(`${started.url}/api/hosted/provider`, {
          method: 'PUT',
          headers: jsonHeaders(USER_A, sessionA.csrfToken, origin),
          body,
        }),
        403,
        'HOSTED_ORIGIN_INVALID',
      );
    }

    for (const csrfToken of [undefined, 'not-a-valid-token', sessionB.csrfToken]) {
      await expectError(
        fetch(`${started.url}/api/hosted/provider`, {
          method: 'PUT',
          headers: jsonHeaders(USER_A, csrfToken, PUBLIC_ORIGIN),
          body,
        }),
        419,
        'HOSTED_CSRF_INVALID',
      );
    }

    await expectError(
      fetch(`${started.url}/api/hosted/provider`, {
        method: 'PUT',
        headers: jsonHeaders('unknown-user', sessionA.csrfToken, PUBLIC_ORIGIN),
        body,
      }),
      401,
      'HOSTED_AUTH_REQUIRED',
    );
  });

  it('keeps A/B credentials isolated through fixed external provider destinations', async () => {
    anthropicFixture.requests.length = 0;
    gatewayFixture.requests.length = 0;
    const started = await start();
    const [sessionA, sessionB] = await Promise.all([
      getSession(started, USER_A),
      getSession(started, USER_B),
    ]);

    const [setA, setB] = await Promise.all([
      mutate(started, USER_A, sessionA.csrfToken, 'PUT', '/api/hosted/provider', {
        provider: 'anthropic',
        key: SECRET_A,
      }),
      mutate(started, USER_B, sessionB.csrfToken, 'PUT', '/api/hosted/provider', {
        provider: 'vercel-ai-gateway',
        key: SECRET_B,
      }),
    ]);
    expect(setA).toEqual({ result: 'set', provider: 'anthropic', configured: true });
    expect(setB).toEqual({ result: 'set', provider: 'vercel-ai-gateway', configured: true });

    const [testedA, testedB] = await Promise.all([
      mutate(started, USER_A, sessionA.csrfToken, 'POST', '/api/hosted/provider/test', {
        provider: 'anthropic',
      }),
      mutate(started, USER_B, sessionB.csrfToken, 'POST', '/api/hosted/provider/test', {
        provider: 'vercel-ai-gateway',
      }),
    ]);
    expect(testedA).toEqual({ result: 'passed', provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(testedB).toEqual({ result: 'passed', provider: 'vercel-ai-gateway', model: GATEWAY_MODEL });

    expect(anthropicFixture.requests).toHaveLength(1);
    expect(gatewayFixture.requests).toHaveLength(1);
    expect(anthropicFixture.requests[0]?.method).toBe('POST');
    expect(anthropicFixture.requests[0]?.path).toBe('/v1/messages');
    expect(gatewayFixture.requests[0]?.method).toBe('POST');
    expect(gatewayFixture.requests[0]?.path).toBe('/v1/messages');
    expect(requestText(anthropicFixture.requests)).toContain(SECRET_A);
    expect(requestText(anthropicFixture.requests)).toContain(ANTHROPIC_MODEL);
    expect(requestText(anthropicFixture.requests)).not.toContain(SECRET_B);
    expect(requestText(gatewayFixture.requests)).toContain(SECRET_B);
    expect(requestText(gatewayFixture.requests)).toContain(GATEWAY_MODEL);
    expect(requestText(gatewayFixture.requests)).not.toContain(SECRET_A);

    expect(JSON.stringify(await getProviderStatus(started, USER_A))).not.toContain(SECRET_A);
    expect(JSON.stringify(await getProviderStatus(started, USER_B))).not.toContain(SECRET_B);
    expectNoProcessGlobalSecret();
  });

  it('rotates, clears, and reports per-user credential status without returning secrets', async () => {
    anthropicFixture.requests.length = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const started = await start();
    const session = await getSession(started, USER_A);

    expect(await getProviderStatus(started, USER_A)).toEqual({ provider: null, configured: false });
    await mutate(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic', key: SECRET_A,
    });
    expect(await getProviderStatus(started, USER_A)).toEqual({
      provider: 'anthropic', configured: true,
    });
    await mutate(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic', key: SECRET_A_ROTATED,
    });
    await mutate(started, USER_A, session.csrfToken, 'POST', '/api/hosted/provider/test', {
      provider: 'anthropic',
    });
    expect(requestText(anthropicFixture.requests)).toContain(SECRET_A_ROTATED);
    expect(requestText(anthropicFixture.requests)).not.toContain(SECRET_A);

    const cleared = await mutate(
      started,
      USER_A,
      session.csrfToken,
      'DELETE',
      '/api/hosted/provider',
    );
    expect(cleared).toEqual({ result: 'cleared', provider: null, configured: false });
    expect(await getProviderStatus(started, USER_A)).toEqual({ provider: null, configured: false });
    await expectError(
      mutateResponse(started, USER_A, session.csrfToken, 'POST', '/api/hosted/provider/test', {
        provider: 'anthropic',
      }),
      409,
      'HOSTED_PROVIDER_MISSING',
    );

    await mutate(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic', key: REJECTED_SECRET,
    });
    const failed = await mutateResponse(
      started,
      USER_A,
      session.csrfToken,
      'POST',
      '/api/hosted/provider/test',
      { provider: 'anthropic' },
    );
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(REJECTED_SECRET);
    expect(await getProviderStatus(started, USER_A)).toEqual({
      provider: null,
      configured: false,
    });

    const logged = JSON.stringify([
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
    ]);
    for (const sentinel of SENTINELS) expect(logged).not.toContain(sentinel);
    expectNoProcessGlobalSecret();
  });

  it('allows tests to shorten idle eviction without persisting credentials', async () => {
    const started = await start({ idleEvictionMs: 10 });
    const session = await getSession(started, USER_A);
    await mutate(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic', key: SECRET_A,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await getProviderStatus(started, USER_A)).toEqual({
      provider: null,
      configured: false,
    });
  });

  it('accepts only the closed provider request shapes', async () => {
    const started = await start();
    const session = await getSession(started, USER_A);

    for (const body of [
      { provider: 'openai', key: 'safe-non-sentinel' },
      { provider: 'anthropic', key: '' },
    ]) {
      await expectError(
        mutateResponse(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', body),
        400,
        'HOSTED_PROVIDER_INVALID',
      );
    }

    for (const body of [
      { provider: 'anthropic', key: 'safe', baseUrl: 'https://attacker.test' },
      { provider: 'anthropic', key: 'safe', headers: { authorization: 'forged' } },
      { provider: 'anthropic', key: 'safe', env: { HOME: '/tmp/forged' } },
      { provider: 'anthropic', key: 'safe', model: 'client-selected-model' },
      { provider: 'anthropic', key: 'safe', executablePath: 'malware' },
    ]) {
      await expectError(
        mutateResponse(started, USER_A, session.csrfToken, 'PUT', '/api/hosted/provider', body),
        400,
        'BAD_REQUEST',
      );
    }

    for (const [method, path, body] of [
      ['POST', '/api/hosted/provider/test', {}],
      ['POST', '/api/hosted/provider/test', { provider: 'anthropic', extra: true }],
      ['DELETE', '/api/hosted/provider', { provider: 'anthropic' }],
    ] as const) {
      await expectError(
        mutateResponse(started, USER_A, session.csrfToken, method, path, body),
        400,
        'BAD_REQUEST',
      );
    }
    await expectError(
      fetch(`${started.url}/api/hosted/provider?owner=user-a`, { headers: auth(USER_A) }),
      400,
      'BAD_REQUEST',
    );

  });

  it('accepts an exactly 16-KiB decoded key even when JSON escaping expands its envelope', async () => {
    const started = await start();
    const session = await getSession(started, USER_A);
    const key = '\u0001'.repeat(16 * 1024);
    const body = { provider: 'anthropic', key };

    expect(Buffer.byteLength(key, 'utf8')).toBe(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeGreaterThan(20 * 1024);
    expect(await mutate(
      started,
      USER_A,
      session.csrfToken,
      'PUT',
      '/api/hosted/provider',
      body,
    )).toEqual({ result: 'set', provider: 'anthropic', configured: true });
  });
});

async function start(options: {
  idleEvictionMs?: number;
  productionIdentity?: boolean;
} = {}): Promise<StartedServer> {
  const started = await startHostedServer({
    port: 0,
    host: '127.0.0.1',
    publicOrigin: PUBLIC_ORIGIN,
    ...(options.productionIdentity ? {} : {
      testComposition: {
        resolveIdentity(request) {
          const token = request.headers.authorization?.replace(/^Bearer\s+/iu, '');
          if (token === USER_A) {
            return { userKey: USER_A, sessionKey: 'session-a', displayName: 'Alice' };
          }
          if (token === USER_B) {
            return { userKey: USER_B, sessionKey: 'session-b', displayName: 'Bob' };
          }
          return null;
        },
        providerBaseUrls: {
          anthropic: anthropicFixture.origin,
          'vercel-ai-gateway': gatewayFixture.origin,
        },
        ...(options.idleEvictionMs === undefined
          ? {}
          : { idleEvictionMs: options.idleEvictionMs }),
      },
    }),
  });
  startedServers.push(started);
  return started;
}

async function getSession(started: StartedServer, user: string): Promise<{
  csrfExpiresAt: number;
  csrfToken: string;
  publicOrigin: string;
  providers: unknown[];
}> {
  const response = await fetch(`${started.url}/api/hosted/session`, { headers: auth(user) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    csrfExpiresAt: number;
    csrfToken: string;
    publicOrigin: string;
    providers: unknown[];
  }>;
}

async function getProviderStatus(started: StartedServer, user: string): Promise<unknown> {
  const response = await fetch(`${started.url}/api/hosted/provider`, { headers: auth(user) });
  expect(response.status).toBe(200);
  return response.json();
}

async function mutate(
  started: StartedServer,
  user: string,
  csrfToken: string,
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await mutateResponse(started, user, csrfToken, method, path, body);
  expect(response.status).toBe(200);
  const text = await response.text();
  for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
  return JSON.parse(text) as unknown;
}

function mutateResponse(
  started: StartedServer,
  user: string,
  csrfToken: string,
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${started.url}${path}`, {
    method,
    headers: jsonHeaders(user, csrfToken, PUBLIC_ORIGIN),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function auth(user: string): Record<string, string> {
  return { authorization: `Bearer ${user}` };
}

function jsonHeaders(
  user: string,
  csrfToken: string | undefined,
  origin: string | undefined,
): Record<string, string> {
  return {
    ...auth(user),
    'content-type': 'application/json',
    ...(csrfToken === undefined ? {} : { 'x-readable-studio-csrf': csrfToken }),
    ...(origin === undefined ? {} : { origin }),
  };
}

async function expectError(
  responsePromise: Promise<Response>,
  status: number,
  code: string,
): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status).toBe(status);
  expect(JSON.parse(text)).toMatchObject({ error: { code } });
  for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
}

async function startProviderFixture(): Promise<ProviderFixture> {
  const requests: ProviderRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ body, headers: request.headers, method: request.method, path: request.url });
    const credential = Object.values(request.headers).join('\n');
    if (credential.includes(REJECTED_SECRET)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `fixture rejected ${REJECTED_SECRET}` } }));
      return;
    }
    const model = parseModel(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
}

function parseModel(body: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : 'fixture-model';
  } catch {
    return 'fixture-model';
  }
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function requestText(requests: ProviderRequest[]): string {
  return JSON.stringify(requests);
}

function expectNoProcessGlobalSecret(): void {
  const processGlobalText = JSON.stringify({ argv: process.argv, env: process.env });
  for (const sentinel of SENTINELS) expect(processGlobalText).not.toContain(sentinel);
}

async function closeHostedServer(started: StartedServer): Promise<void> {
  if (started.shutdown) await started.shutdown();
  if (started.server.listening) await closeServer(started.server);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
