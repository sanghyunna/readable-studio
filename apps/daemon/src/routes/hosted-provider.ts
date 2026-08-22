import { randomBytes, randomUUID } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';

import {
  HOSTED_PROVIDER_IDS,
  type HostedProviderClearResponse,
  type HostedProviderDescriptor,
  type HostedProviderId,
  type HostedProviderSetResponse,
  type HostedProviderStatusResponse,
  type HostedProviderTestResponse,
  type HostedSessionResponse,
} from '@readable-studio/contracts';
import type { Express, RequestHandler } from 'express';

import {
  HostedRuntimeError,
  type HostedProviderCredential,
  type HostedRuntimeRegistry,
} from '../hosted-runtime-registry.js';
import {
  HostedHttpError,
  hostedRequestState,
} from './hosted-http.js';

const CSRF_TTL_MS = 10 * 60_000;
const MAX_CSRF_BINDINGS = 65_536;
const MAX_PROVIDER_SECRET_BYTES = 16 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROVIDER_CONNECT_TIMEOUT_MS = 5_000;
const PROVIDER_CALL_TIMEOUT_MS = 60_000;

type ProviderEntry = HostedProviderDescriptor & {
  readonly baseUrl: string;
};

export const HOSTED_PROVIDER_CATALOGUE: readonly ProviderEntry[] = Object.freeze([
  Object.freeze({
    id: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    baseUrl: 'https://api.anthropic.com',
  }),
  Object.freeze({
    id: 'vercel-ai-gateway',
    model: 'anthropic/claude-sonnet-4.5',
    baseUrl: 'https://ai-gateway.vercel.sh',
  }),
]);

export type HostedCsrfState = {
  readonly expiresAt: number;
  readonly token: string;
};

export interface HostedProviderRouteDependencies {
  readonly authenticate: RequestHandler;
  readonly csrf: Map<string, HostedCsrfState>;
  readonly json: RequestHandler;
  readonly noInput: RequestHandler;
  readonly providerBaseUrls: Readonly<Record<HostedProviderId, string>>;
  readonly publicOrigin: string;
  readonly registry: HostedRuntimeRegistry;
  readonly requireMutationAuthority: RequestHandler;
}

export function registerHostedProviderRoutes(
  app: Express,
  dependencies: HostedProviderRouteDependencies,
): void {
  const {
    authenticate,
    csrf,
    json,
    noInput,
    providerBaseUrls,
    publicOrigin,
    registry,
    requireMutationAuthority,
  } = dependencies;

  app.get('/api/hosted/session', authenticate, noInput, (_request, response) => {
    removeExpiredCsrf(csrf);
    const state = hostedRequestState(response);
    if (!csrf.has(state.bindingKey) && csrf.size >= MAX_CSRF_BINDINGS) {
      throw new HostedRuntimeError(
        'HOSTED_CAPACITY_EXHAUSTED',
        'hosted session capacity is exhausted',
      );
    }
    const nonce: HostedCsrfState = {
      expiresAt: Date.now() + CSRF_TTL_MS,
      token: randomBytes(32).toString('base64url'),
    };
    csrf.set(state.bindingKey, nonce);
    const body: HostedSessionResponse = {
      publicOrigin,
      csrfToken: nonce.token,
      csrfExpiresAt: nonce.expiresAt,
      providers: HOSTED_PROVIDER_CATALOGUE.map(({ id, model }) => ({ id, model })),
    };
    response.set('Cache-Control', 'no-store').json(body);
  });

  app.get('/api/hosted/provider', authenticate, noInput, (_request, response) => {
    const body: HostedProviderStatusResponse = registry.credentialStatus(
      hostedRequestState(response).lease,
    );
    response.set('Cache-Control', 'no-store').json(body);
  });

  app.put(
    '/api/hosted/provider',
    authenticate,
    requireMutationAuthority,
    json,
    async (request, response) => {
      const body = closedObject(request.body, ['provider', 'key']);
      const provider = providerId(body.provider);
      const key = providerSecret(body.key);
      await registry.replaceCredential(hostedRequestState(response).lease, { provider, key });
      const result: HostedProviderSetResponse = { result: 'set', provider, configured: true };
      response.set('Cache-Control', 'no-store').json(result);
    },
  );

  app.post(
    '/api/hosted/provider/test',
    authenticate,
    requireMutationAuthority,
    json,
    async (request, response) => {
      const body = closedObject(request.body, ['provider']);
      const provider = providerId(body.provider);
      const lease = hostedRequestState(response).lease;
      const current = registry.credentialStatus(lease);
      if (!current.configured || current.provider == null) {
        throw new HostedHttpError(
          'HOSTED_PROVIDER_MISSING',
          'hosted provider credential is not configured',
          409,
        );
      }
      if (current.provider !== provider) {
        throw new HostedHttpError(
          'HOSTED_PROVIDER_INVALID',
          'hosted provider does not match the configured credential',
          400,
        );
      }
      const entry = providerEntry(provider);
      await registry.dispatch(lease, {
        runId: `provider-test-${randomUUID()}`,
        conversationId: 'provider-test',
        execute: async ({ credential, signal }) => {
          if (credential == null || credential.provider !== provider) {
            throw new HostedHttpError(
              'HOSTED_PROVIDER_MISSING',
              'hosted provider credential is not configured',
              409,
            );
          }
          await testProvider(entry, credential, providerBaseUrls[provider], signal);
          return { value: undefined };
        },
      });
      const result: HostedProviderTestResponse = {
        result: 'passed',
        provider,
        model: entry.model,
      };
      response.set('Cache-Control', 'no-store').json(result);
    },
  );

  app.delete(
    '/api/hosted/provider',
    authenticate,
    requireMutationAuthority,
    noInput,
    async (_request, response) => {
      await registry.replaceCredential(hostedRequestState(response).lease, null);
      const result: HostedProviderClearResponse = {
        result: 'cleared',
        provider: null,
        configured: false,
      };
      response.set('Cache-Control', 'no-store').json(result);
    },
  );
}

export function hostedProviderDestinations(
  overrides: Partial<Record<HostedProviderId, string>> | undefined,
): Record<HostedProviderId, string> {
  const destinations = Object.fromEntries(
    HOSTED_PROVIDER_CATALOGUE.map((entry) => [entry.id, entry.baseUrl]),
  ) as Record<HostedProviderId, string>;
  if (overrides == null) return destinations;
  for (const id of HOSTED_PROVIDER_IDS) {
    const override = overrides[id];
    if (override !== undefined) destinations[id] = loopbackFixtureOrigin(override);
  }
  return destinations;
}

export function hostedProviderModel(provider: HostedProviderId): string {
  return providerEntry(provider).model;
}

function loopbackFixtureOrigin(input: string): string {
  const parsed = new URL(input);
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)
    || parsed.origin !== input
  ) {
    throw new Error('hosted provider test destinations must be exact loopback HTTP origins');
  }
  return parsed.origin;
}

function removeExpiredCsrf(states: Map<string, HostedCsrfState>): void {
  const now = Date.now();
  for (const [binding, state] of states) {
    if (state.expiresAt <= now) states.delete(binding);
  }
}

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostedHttpError('BAD_REQUEST', 'hosted request body is invalid', 400);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HostedHttpError(
      'BAD_REQUEST',
      'hosted request body contains unsupported fields',
      400,
    );
  }
  return record;
}

function providerId(value: unknown): HostedProviderId {
  if (typeof value !== 'string' || !HOSTED_PROVIDER_IDS.includes(value as HostedProviderId)) {
    throw new HostedHttpError('HOSTED_PROVIDER_INVALID', 'hosted provider is invalid', 400);
  }
  return value as HostedProviderId;
}

function providerSecret(value: unknown): string {
  if (typeof value !== 'string') invalidProviderCredential();
  const bytes = Buffer.from(value, 'utf8');
  if (
    bytes.length < 1
    || bytes.length > MAX_PROVIDER_SECRET_BYTES
    || bytes.toString('utf8') !== value
    || /[\u0000\r\n]/u.test(value)
  ) invalidProviderCredential();
  return value;
}

function invalidProviderCredential(): never {
  throw new HostedHttpError(
    'HOSTED_PROVIDER_INVALID',
    'hosted provider credential is invalid',
    400,
  );
}

function providerEntry(provider: HostedProviderId): ProviderEntry {
  const entry = HOSTED_PROVIDER_CATALOGUE.find((candidate) => candidate.id === provider);
  if (entry == null) {
    throw new HostedHttpError('HOSTED_PROVIDER_INVALID', 'hosted provider is invalid', 400);
  }
  return entry;
}

async function testProvider(
  entry: ProviderEntry,
  credential: HostedProviderCredential,
  baseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const body = JSON.stringify({
    model: entry.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Reply with OK' }],
    stream: false,
  });
  let result: { status: number; body: string };
  try {
    result = await providerRequest(new URL('/v1/messages', baseUrl), credential.key, body, signal);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new HostedHttpError(
        'HOSTED_PROVIDER_TEST_TIMED_OUT',
        'hosted provider test timed out',
        504,
      );
    }
    throw new HostedHttpError('HOSTED_PROVIDER_TEST_FAILED', 'hosted provider test failed', 502);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new HostedHttpError('HOSTED_PROVIDER_TEST_FAILED', 'hosted provider test failed', 502);
  }
  try {
    const parsed = JSON.parse(result.body) as { content?: unknown; id?: unknown };
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.content)) {
      throw new Error('invalid shape');
    }
  } catch {
    throw new HostedHttpError('HOSTED_PROVIDER_TEST_FAILED', 'hosted provider test failed', 502);
  }
}

function providerRequest(
  url: URL,
  key: string,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let connected = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let callTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: unknown, value?: { status: number; body: string }): void => {
      if (settled) return;
      settled = true;
      if (connectTimer != null) clearTimeout(connectTimer);
      if (callTimer != null) clearTimeout(callTimer);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined && value !== undefined) resolve(value);
      else reject(error ?? new Error('provider request failed'));
    };
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': key,
      },
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
          request.destroy(new Error('hosted provider response exceeded the fixed limit'));
          return;
        }
        chunks.push(buffer);
      });
      response.once('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.once('error', finish);
    });
    const onAbort = (): void => {
      request.destroy(signal.reason instanceof Error
        ? signal.reason
        : new Error('hosted provider request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.once('socket', (socket: Socket) => {
      const onConnected = (): void => {
        connected = true;
        if (connectTimer != null) clearTimeout(connectTimer);
      };
      if (!socket.connecting) onConnected();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', onConnected);
      connectTimer = setTimeout(() => {
        if (!connected) {
          request.destroy(Object.assign(new Error('provider connect timed out'), {
            code: 'ETIMEDOUT',
          }));
        }
      }, PROVIDER_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
    });
    request.once('error', finish);
    callTimer = setTimeout(() => {
      request.destroy(Object.assign(new Error('provider call timed out'), { code: 'ETIMEDOUT' }));
    }, PROVIDER_CALL_TIMEOUT_MS);
    callTimer.unref?.();
    if (signal.aborted) onAbort();
    else request.end(body);
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    || /timed out|timeout/iu.test(error.message)
  );
}
