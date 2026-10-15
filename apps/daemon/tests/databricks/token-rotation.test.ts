import { expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabricksClient, DatabricksServiceError } from '../../src/databricks/client.js';
import { DatabricksCredentials } from '../../src/databricks/credentials.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { upstreamFailure } from '../../src/databricks/failure.js';
import { protocolFixture, runtimeFixture } from './runtime-fixture.js';
import { createPiTurnFixture, fixtureCliRunner, fixtureNow, upstreamBearer } from './pi-turn-fixture.js';

const success = { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
const binding = { id: 'profile', profileName: 'test', host: 'https://workspace.example', isDefault: true };

async function withRelay(provider: (force?: boolean) => Promise<{ token: string; expiresAt: number }>,
  upstream: typeof fetch, run: (request: () => Promise<Response>) => Promise<void>) {
  const runtime = runtimeFixture('openai-completions');
  runtime.tokenProvider = provider;
  const relay = await createDatabricksRelay({ runtime, fetch: upstream,
    delay: async () => { throw new Error('Auth must never enter generic retry'); } });
  try {
    await run(() => fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [] }) }));
  } finally { await relay.close(); }
}

test('cached credentials rotate before the 120-second margin throughout a simulated 70-minute run', async () => {
  let now = Date.parse('2026-10-14T00:00:00Z');
  let acquisitions = 0;
  const client = new DatabricksClient({ resolveExecutable: async () => 'fixture.exe', runner: async (_exe, args) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v0.278.0', stderr: '', exitCode: 0 };
    return {
      stdout: JSON.stringify({ access_token: `token-${++acquisitions}`, expiry: new Date(now + 3_600_000).toISOString() }),
      stderr: '', exitCode: 0,
    };
  } });
  await client.probe();
  const credentials = new DatabricksCredentials(client, () => now);
  await credentials.acquire(binding); // Launch-time token.
  const headers: string[] = [];
  await withRelay(force => credentials.acquireToken(binding, force), async (_url, init) => {
    headers.push(new Headers(init?.headers).get('authorization')!);
    return Response.json(success);
  }, async request => {
    expect((await request()).status).toBe(200);
    now += 59 * 60_000;
    expect((await request()).status).toBe(200);
    now += 11 * 60_000;
    expect((await request()).status).toBe(200);
  });
  expect(acquisitions).toBe(2);
  expect(headers).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-2']);
});

for (const [status, body] of [
  [401, { message: 'rejected' }],
  [403, { message: 'Invalid access token' }],
  [403, { error_code: 'UNAUTHENTICATED' }],
  [403, { error: { error_code: 'INVALID_TOKEN' } }],
] as const) {
  test(`auth rejection ${status} ${JSON.stringify(body)} refreshes once and retries immediately`, async () => {
    const provider = vi.fn(async (force?: boolean) => ({ token: force ? 'new-token' : 'old-token', expiresAt: Infinity }));
    const headers: string[] = [];
    await withRelay(provider, async (_url, init) => {
      headers.push(new Headers(init?.headers).get('authorization')!);
      return headers.length === 1 ? Response.json(body, { status }) : Response.json(success);
    }, async request => { expect((await request()).status).toBe(200); });
    expect(headers).toEqual(['Bearer old-token', 'Bearer new-token']);
    expect(provider.mock.calls.filter(([force]) => force === true)).toHaveLength(1);
  });
}

test('genuine permission 403 makes exactly one attempt without forced refresh', async () => {
  const provider = vi.fn(async (_force?: boolean) => ({ token: 'token', expiresAt: Infinity }));
  const upstream = vi.fn(async () => Response.json({ error_code: 'PERMISSION_DENIED', message: 'Access denied' }, { status: 403 }));
  await withRelay(provider, upstream, async request => {
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { reason: 'permission-denied', retryable: false } });
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls.filter(([force]) => force === true)).toHaveLength(0);
});

for (const failBeforeRequest of [false, true]) {
  test(`refresh failure is an immediate auth error (before request=${failBeforeRequest})`, async () => {
    const provider = vi.fn(async (force?: boolean) => {
      if (force || failBeforeRequest) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
      return { token: 'old-token', expiresAt: Infinity };
    });
    const upstream = vi.fn(async () => Response.json({}, { status: 401 }));
    await withRelay(provider, upstream, async request => {
      const response = await request();
      expect(await response.json()).toMatchObject({ error: { reason: 'auth', retryable: false } });
    });
    expect(upstream).toHaveBeenCalledTimes(failBeforeRequest ? 0 : 1);
  });
}

test('a second auth rejection terminates after exactly two attempts', async () => {
  const provider = vi.fn(async (_force?: boolean) => ({ token: 'token', expiresAt: Infinity }));
  const upstream = vi.fn(async () => Response.json({ message: 'token is expired' }, { status: 403 }));
  await withRelay(provider, upstream, async request => {
    expect(await (await request()).json()).toMatchObject({ error: { reason: 'auth', retryable: false } });
  });
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(provider.mock.calls.filter(([force]) => force === true)).toHaveLength(1);
});

test('token expiry recognition is case insensitive without misclassifying permission messages', () => {
  for (const message of ['Token expired', 'EXPIRED', 'INVALID ACCESS TOKEN', 'token is expired', 'The access token is expired. Sign in again.']) {
    expect(upstreamFailure(403, { message }, []).reason).toBe('auth');
  }
  expect(upstreamFailure(403, { message: 'Permission expired for model access' }, []).reason).toBe('permission-denied');
});

test('static workspace PAT auth rejects once and invokes the existing invalidation callback', async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.onAuthRejected = vi.fn(async () => undefined);
  const upstream = vi.fn(async () => Response.json({}, { status: 401 }));
  const relay = await createDatabricksRelay({ runtime, fetch: upstream });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${relay.capabilityKey}` },
      body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
    expect(response.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(runtime.onAuthRejected).toHaveBeenCalledTimes(1);
  } finally { await relay.close(); }
});

test('stream auth errors never replay a request after a successful HTTP response', async () => {
  const provider = vi.fn(async (_force?: boolean) => ({ token: 'token', expiresAt: Infinity }));
  const upstream = vi.fn(async () => new Response(
    'data: {"error":{"type":"authentication_error","message":"Token expired"}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }));
  await withRelay(provider, upstream, async request => {
    const response = await request();
    expect(await response.text()).toContain('auth');
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls.filter(([force]) => force === true)).toHaveLength(0);
});

test('service runtime retains an expiry-aware provider across requests and reports a lost CLI login', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'databricks-token-provider-'));
  const fixture = await createPiTurnFixture();
  let now = fixtureNow;
  let acquisitions = 0;
  let loggedIn = true;
  try {
    const service = createDatabricksService({
      dataRoot: root, now: () => now, fetch: fixture.fetch,
      clientOptions: {
        resolveExecutable: async () => 'fixture.exe',
        runner: async (exe, args, options) => {
          if (args[1] !== 'token') return fixtureCliRunner(exe, args, options);
          if (!loggedIn) return { stdout: '', stderr: 'not logged in', exitCode: 1 };
          acquisitions++;
          return { stdout: JSON.stringify({
            access_token: acquisitions === 1 ? upstreamBearer : `rotated-${acquisitions}`,
            expiry: new Date(now + 3_600_000).toISOString(),
          }), stderr: '', exitCode: 0 };
        },
      },
      resolveResource: async () => protocolFixture('openai-completions').request.body.model,
    });
    const profiles = await service.probe();
    const found = await service.lookup({ profileId: profiles.profiles[0]!.id,
      resourceId: 'fixture-resource', kind: 'uc-model-service' });
    const registered = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
    const runtime = await service.resolveRuntime(registered.appModelId);
    expect(runtime.tokenProvider).toBeTypeOf('function');
    expect((await runtime.tokenProvider!()).token).toBe(upstreamBearer);
    now += 59 * 60_000;
    const headers: string[] = [];
    const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
      headers.push(new Headers(init?.headers).get('authorization')!);
      return Response.json(success);
    } });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [] }) });
      expect(response.status).toBe(200);
      expect(headers).toEqual(['Bearer rotated-2']);
    } finally { await relay.close(); }
    loggedIn = false;
    await expect(runtime.tokenProvider!(true)).rejects.toMatchObject({ code: 'DATABRICKS_AUTH_REQUIRED' });
    expect(acquisitions).toBe(2);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
