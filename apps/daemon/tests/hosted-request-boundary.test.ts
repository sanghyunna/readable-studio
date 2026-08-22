import express from 'express';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedRequestBoundary,
  createHostedRequestBodyGuard,
  getHostedAuthContext,
  hasCanonicalHostedRawPath,
  HOSTED_ROUTE_CHARACTERIZATION,
  isHostedRouteAllowed,
  type HostedIdentityResolver,
} from '../src/hosted-request-boundary.js';
import { startServer } from '../src/server.js';
import { toolTokenRegistry } from '../src/tool-tokens.js';

const context = {
  userKey: 'identity:user-a',
  storageKey: 'user-a',
  requestId: 'request-1',
  displayName: 'User A',
} as const;

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(
  resolver?: HostedIdentityResolver,
): Promise<{ baseUrl: string; resolverRequests: string[]; handlerRequests: string[] }> {
  const resolverRequests: string[] = [];
  const handlerRequests: string[] = [];
  const app = express();
  const effectiveResolver: HostedIdentityResolver = resolver
    ? async (request, metadata) => {
        resolverRequests.push(metadata.path);
        return resolver(request, metadata);
      }
    : (_request, metadata) => {
        resolverRequests.push(metadata.path);
        return context;
      };
  app.use(
    createHostedRequestBoundary({
      testComposition: true,
      resolveIdentity: effectiveResolver,
    }),
  );
  app.use(express.json());
  app.use(createHostedRequestBodyGuard());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/projects/:id', (req, res) => {
    handlerRequests.push(`GET ${req.path}`);
    res.json({ projectId: req.params.id, auth: getHostedAuthContext(req) });
  });
  app.patch('/api/projects/:id', (req, res) => {
    handlerRequests.push(`PATCH ${req.path}`);
    res.json({ ok: true });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, resolverRequests, handlerRequests };
}

describe('hosted request boundary', () => {
  it('accepts canonical escaped content segments without accepting encoded authority paths', () => {
    const canonical = (originalUrl: string) => hasCanonicalHostedRawPath({
      originalUrl,
      url: originalUrl,
      path: originalUrl,
    } as Parameters<typeof hasCanonicalHostedRawPath>[0]);
    const token = `odpv_${'a'.repeat(43)}`;
    expect(canonical('/api/projects/project-a/files/pages/My%20Deck.html')).toBe(true);
    expect(canonical(`/api/projects/project-a/preview/${token}/assets/%E2%9C%93.svg`)).toBe(true);
    for (const path of [
      '/api/projects/%70roject-a/files/index.html',
      '/api/projects/project-a/files/%2Foutside',
      '/api/projects/project-a/files/%2e%2e/secret',
      '/api/projects/project-a/files/%252Foutside',
      '/api/projects/project-a/files/bad%2fcase',
    ]) expect(canonical(path)).toBe(false);
  });
  it('keeps probes open but fails closed when no identity adapter exists', async () => {
    const app = express();
    app.use(createHostedRequestBoundary({}));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/projects/:id', (_req, res) => res.json({ ok: true }));
    const server = await new Promise<http.Server>((resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(fetch(`${baseUrl}/api/health`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${baseUrl}/api/projects/a`)).resolves.toMatchObject({ status: 503 });
  });

  it('does not activate data routes for an unmarked identity resolver', async () => {
    const app = express();
    app.use(createHostedRequestBoundary({ resolveIdentity: () => context }));
    app.get('/api/projects/:id', (_req, res) => res.json({ ok: true }));
    const server = await new Promise<http.Server>((resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/a`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'HOSTED_AUTH_UNAVAILABLE' } });
  });

  it('does not activate the test composition outside the test runtime', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { baseUrl, resolverRequests, handlerRequests } = await listen(() => context);
      const response = await fetch(`${baseUrl}/api/projects/a`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'HOSTED_AUTH_UNAVAILABLE' } });
      expect(resolverRequests).toEqual([]);
      expect(handlerRequests).toEqual([]);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('attaches immutable server identity to an allowed request', async () => {
    const { baseUrl, resolverRequests, handlerRequests } = await listen(() => context);
    const response = await fetch(`${baseUrl}/api/projects/a`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      projectId: string;
      auth: { userKey: string; storageKey: string; displayName: string; requestId: string };
    };
    expect(body).toMatchObject({
      projectId: 'a',
      auth: {
        userKey: context.userKey,
        storageKey: context.storageKey,
        displayName: context.displayName,
      },
    });
    expect(body.auth.requestId).not.toBe(context.requestId);
    expect(body.auth.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(resolverRequests).toEqual(['/api/projects/a']);
  });

  it('rejects unknown routes and wrong methods before route handlers run', async () => {
    const { baseUrl, resolverRequests, handlerRequests } = await listen(() => context);
    for (const response of [
      await fetch(`${baseUrl}/api/not-allowed`),
      await fetch(`${baseUrl}/api/projects/a`, { method: 'POST' }),
    ]) {
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('HOSTED_ROUTE_NOT_ALLOWED');
    }
    expect(resolverRequests).toEqual([]);
    expect(handlerRequests).toEqual([]);
  });

  it.each([
    ['query', '/api/projects/a?userKey=attacker', undefined],
    ['query account', '/api/projects/a?account=attacker', undefined],
    ['query storage', '/api/projects/a?storage=attacker', undefined],
    ['nested query owner', '/api/projects/a?filters%5BownerId%5D=attacker', undefined],
    ['nested query user', '/api/projects/a?filters%5BuserId%5D=attacker', undefined],
    ['array query user', '/api/projects/a?userId%5B%5D=attacker', undefined],
    ['header', '/api/projects/a', { 'x-user-key': 'attacker' }],
    ['forwarded header', '/api/projects/a', { 'x-forwarded-user': 'attacker' }],
    ['header user-id', '/api/projects/a', { 'user-id': 'attacker' }],
    ['header owner-key', '/api/projects/a', { 'owner-key': 'attacker' }],
    ['header account-id', '/api/projects/a', { 'account-id': 'attacker' }],
    ['generic user header', '/api/projects/a', { user: 'attacker' }],
    ['generic owner header', '/api/projects/a', { owner: 'attacker' }],
    ['generic tenant header', '/api/projects/a', { tenant: 'attacker' }],
    ['generic namespace header', '/api/projects/a', { namespace: 'attacker' }],
  ])('rejects client-selected ownership from %s', async (_kind, path, headers) => {
    const { baseUrl } = await listen(() => context);
    const response = await fetch(
      `${baseUrl}${path}`,
      headers === undefined ? undefined : { headers },
    );
    expect(response.status).toBe(400);
  });

  it('rejects client-selected ownership in a JSON body', async () => {
    const { baseUrl } = await listen(() => context);
    const response = await fetch(`${baseUrl}/api/projects/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerId: 'attacker' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects encoded, slash, backslash, and ownership-bearing path variants', async () => {
    const { baseUrl, resolverRequests, handlerRequests } = await listen(() => context);
    for (const suffix of ['%2fsecret', '%5csecret', '%2e%2e%2fsecret']) {
      const response = await fetch(`${baseUrl}/api/projects/a${suffix}`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('HOSTED_ROUTE_NOT_ALLOWED');
    }
    for (const path of [
      '/api/projects/a;ownerId=attacker',
      '/api/projects/a;user.id=attacker',
      '/api/projects/a;owner.id=attacker',
      '/api/projects/a[ownerId]=attacker',
      '/api/projects/a;meta[userId]=attacker',
      '/api/projects/a;userId[]=attacker',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('HOSTED_ROUTE_NOT_ALLOWED');
    }
    expect(resolverRequests).toEqual([]);
    expect(handlerRequests).toEqual([]);
    expect(isHostedRouteAllowed('GET', '/api/projects/..')).toBe(false);
    expect(isHostedRouteAllowed('GET', '/api/projects/.')).toBe(false);
  });

  it.each([
    'user.ts',
    'ownerId.json',
    'storageKey.css',
    'user.id',
    'ownerId',
    'namespaceId',
    'accountKey',
    'storageId',
    'tenantKey',
    'user',
    'a;title=user',
    'a;value=ownerId',
  ])(
    'allows ordinary hosted path identifiers that resemble ownership fields: %s',
    async (identifier) => {
      const { baseUrl } = await listen(() => context);
      const response = await fetch(`${baseUrl}/api/projects/${identifier}`);
      expect(response.status).toBe(200);
    },
  );

  it('fails closed when a resolver returns an invalid context', async () => {
    const { baseUrl } = await listen(() => ({ ...context, storageKey: '../escape' }));
    expect((await fetch(`${baseUrl}/api/projects/a`)).status).toBe(500);
  });

  it.each(['Alice', 'CON', 'NUL', 'COM1'])(
    'rejects non-canonical or Windows-reserved storage key %s',
    async (storageKey) => {
      const { baseUrl } = await listen(() => ({ ...context, storageKey }));
      expect((await fetch(`${baseUrl}/api/projects/a`)).status).toBe(500);
    },
  );

  it('fails closed for deeply nested and wide ownership payloads', async () => {
    const { baseUrl } = await listen(() => context);
    const nested = { metadata: { audit: { ownerId: 'attacker' } } };
    const wide = {
      ...Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`field-${index}`, index])),
      userKey: 'attacker',
    };
    for (const body of [nested, wide]) {
      const response = await fetch(`${baseUrl}/api/projects/a`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const wideArray = Array.from({ length: 10_001 }, () => 0);
    const wideArrayResponse = await fetch(`${baseUrl}/api/projects/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: wideArray }),
    });
    expect(wideArrayResponse.status).toBe(400);
  });

  it('allows ordinary primitive and array fields', async () => {
    const { baseUrl } = await listen(() => context);
    for (const body of [
      { title: 'hello', count: 1, enabled: true, empty: null },
      { attachments: ['a.png', 'b.png'], tags: [] },
    ]) {
      const response = await fetch(`${baseUrl}/api/projects/a`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
  });

  it('allows generic labels inside an otherwise valid hosted payload', async () => {
    const { baseUrl } = await listen(() => context);
    const response = await fetch(`${baseUrl}/api/projects/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'Design team',
        namespace: 'editor-canvas',
        tenant: 'copy',
        user: 'display label',
      }),
    });
    expect(response.status).toBe(200);
  });

  it.each(HOSTED_ROUTE_CHARACTERIZATION.allowed)(
    'keeps characterized hosted route allowed: $method $path',
    ({ method, path }) => {
      expect(isHostedRouteAllowed(method, path)).toBe(true);
    },
  );

  it('allows only the exact standalone export POST path', () => {
    expect(isHostedRouteAllowed('POST', '/api/exports/standalone-html')).toBe(true);
    expect(isHostedRouteAllowed('GET', '/api/exports/standalone-html')).toBe(false);
    expect(isHostedRouteAllowed('POST', '/api/exports/standalone-html/extra')).toBe(false);
    expect(isHostedRouteAllowed('GET', '/api/projects/a/export/index.html')).toBe(false);
  });

  it.each(HOSTED_ROUTE_CHARACTERIZATION.excluded)(
    'keeps characterized local route excluded: $method $path',
    ({ method, path }) => {
      expect(isHostedRouteAllowed(method, path)).toBe(false);
    },
  );

  it('installs the boundary in the real daemon and leaves local startup unchanged', async () => {
    const close = async (started: {
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    }) => {
      await started.shutdown?.();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    };

    const hosted = (await startServer({
      port: 0,
      returnServer: true,
      hostedRequestBoundary: {},
    })) as { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
    try {
      expect((await fetch(`${hosted.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${hosted.url}/api/projects`)).status).toBe(503);
      expect(
        (
          await fetch(`${hosted.url}/api/projects`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await fetch(`${hosted.url}/api/not-allowed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
          })
        ).status,
      ).toBe(404);
    } finally {
      await close(hosted);
    }

    const hostedWithIdentity = (await startServer({
      port: 0,
      returnServer: true,
      hostedRequestBoundary: {
        testComposition: true,
        resolveIdentity: () => ({
          userKey: 'identity:multipart',
          storageKey: 'multipart',
        }),
      },
    })) as { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
    try {
      const multipart = new FormData();
      const filename = `hosted-owner-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      multipart.set('ownerId', 'attacker');
      multipart.set('file', new Blob(['should be removed'], { type: 'text/plain' }), filename);
      const multipartResponse = await fetch(`${hostedWithIdentity.url}/api/projects/a/files`, {
        method: 'POST',
        body: multipart,
      });
      expect(multipartResponse.status).toBe(400);
      const multipartBody = await multipartResponse.json() as { error: { code: string } };
      expect(multipartBody.error.code).toBe('HOSTED_OWNER_FIELD_FORBIDDEN');
      const uploadDir = path.join(os.tmpdir(), 'readable-uploads');
      let leftovers: string[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        leftovers = (await readdir(uploadDir)).filter((entry) => entry.endsWith(`-${filename}`));
        if (leftovers.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(leftovers).toEqual([]);
    } finally {
      await close(hostedWithIdentity);
    }

    const local = (await startServer({
      port: 0,
      returnServer: true,
    })) as { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
    try {
      expect((await fetch(`${local.url}/api/projects`)).status).toBe(200);
    } finally {
      await close(local);
    }
  });

  it('replays representative hosted workflows twice with deterministic route assertions', async () => {
    const fixture = await installHostedClaudeFixture();
    const started = (await startServer({
      port: 0,
      returnServer: true,
      hostedRequestBoundary: {
        testComposition: true,
        resolveIdentity: () => ({
          userKey: 'identity:trace',
          storageKey: 'trace',
          displayName: 'Trace',
        }),
      },
    })) as { url: string; server: http.Server; shutdown?: () => Promise<void> | void };

    type TraceRecord = { status: number; code?: string; legacyError?: string; stream?: boolean };

    const jsonBody = async (response: Response): Promise<Record<string, any>> => {
      const body = await response.json() as unknown;
      return body && typeof body === 'object' ? body as Record<string, any> : {};
    };

    const recordResponse = async (response: Response): Promise<TraceRecord> => {
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
      const error = record?.error && typeof record.error === 'object'
        ? record.error as Record<string, unknown>
        : undefined;
      const code = typeof error?.code === 'string' ? error.code : undefined;
      const legacyError = typeof record?.error === 'string' ? record.error : undefined;
      return {
        status: response.status,
        ...(code ? { code } : {}),
        ...(legacyError ? { legacyError } : {}),
      };
    };

    const request = async (
      method: string,
      requestPath: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<TraceRecord> => {
      const response = await fetch(`${started.url}${requestPath}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return recordResponse(response);
    };

    const openSse = async (
      requestPath: string,
      init: RequestInit = {},
    ): Promise<TraceRecord> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await fetch(`${started.url}${requestPath}`, {
          ...init,
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body?.getReader();
        expect(reader).toBeDefined();
        await reader!.read();
        await reader!.cancel();
        return { status: response.status, stream: true };
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    };

    const waitForTerminal = async (runId: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${started.url}/api/runs/${runId}`);
        if (response.status === 200) {
          const body = await jsonBody(response);
          if (body.status === 'succeeded') return;
          if (['failed', 'canceled'].includes(body.status)) {
            throw new Error(`run ${runId} ended ${String(body.status)}: ${JSON.stringify(body)}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`run ${runId} did not reach a terminal state`);
    };

    const replayTrace = async (iteration: number): Promise<TraceRecord[]> => {
      const projectId = `hosted-trace-${iteration}`;
      const records: TraceRecord[] = [];
      const runIds: string[] = [];
      let artifactPath: string | undefined;

      try {
        records.push(await request('GET', '/api/health'));
        records.push(await request('GET', '/api/projects'));
        records.push(await request('GET', '/api/agents/catalog'));
        records.push(await request('GET', '/api/skills'));
        records.push(await request('GET', '/api/design-systems'));

        for (const [method, requestPath] of [
          ['GET', '/api/agents'],
          ['GET', '/api/app-config'],
          ['GET', `/api/projects/${projectId}/raw/index.html`],
          ['DELETE', `/api/projects/${projectId}/raw/index.html`],
          ['OPTIONS', `/api/projects/${projectId}/raw/index.html`],
          ['POST', '/api/import/folder'],
          ['POST', '/api/provider/models'],
          ['POST', '/api/test/connection'],
          ['GET', '/api/desktop/rollback-approvals/next'],
          ['GET', '/api/daemon/status'],
          ['GET', '/api/metrics'],
          ['GET', '/api/critique/conformance'],
          ['GET', '/api/automation-templates'],
          ['GET', '/api/memory'],
          ['GET', '/api/templates'],
          ['GET', '/api/design-templates'],
          ['GET', `/api/skills/${projectId}/assets/example.js`],
          ['POST', '/api/tools/media/generate'],
          ['GET', '/api/asset-cache'],
          ['POST', `/api/projects/${projectId}/handoff`],
          ['GET', '/api/analytics/config'],
          ['POST', '/api/observability/event'],
          ['GET', `/api/runs/${projectId}/devloop-iterations`],
          ['POST', `/api/runs/${projectId}/replay`],
          ['POST', `/api/projects/${projectId}/conversations/conversation/rollback`],
          ['POST', `/api/projects/${projectId}/conversations/conversation/agent-rollback-request`],
          ['POST', `/api/projects/${projectId}/conversations/conversation/agent-rollback-execute`],
        ] as const) {
          const denied = await request(method, requestPath);
          expect(denied.status).toBe(404);
          expect(denied.code).toBe('HOSTED_ROUTE_NOT_ALLOWED');
          records.push(denied);
        }

        const projectResponse = await fetch(`${started.url}/api/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: projectId,
            name: 'Hosted trace',
            skipDiscoveryBrief: true,
            pluginId: fixture.pluginId,
          }),
        });
        const projectBody = await jsonBody(projectResponse);
        expect(projectResponse.status).toBe(200);
        expect(projectBody.conversationId).toEqual(expect.any(String));
        expect(projectBody.appliedPluginSnapshotId).toEqual(expect.any(String));
        const snapshotId = projectBody.appliedPluginSnapshotId as string;
        const conversationId = projectBody.conversationId as string;

        const projectReadResponse = await fetch(`${started.url}/api/projects/${projectId}`);
        expect(projectReadResponse.status).toBe(200);
        const projectReadBody = await jsonBody(projectReadResponse);
        expect(projectReadBody.project).toMatchObject({ id: projectId });
        records.push({ status: projectReadResponse.status });
        const genericGenUiResponse = await fetch(`${started.url}/api/projects/${projectId}/genui/prefill`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
          snapshotId,
          surfaceId: 'hosted-trace-surface',
          value: { owner: 'Design team', namespace: 'editor-canvas', user: 'display label' },
          schema: { user: { type: 'string' } },
          }),
        });
        expect(genericGenUiResponse.status).toBe(200);
        const genericGenUiBody = await jsonBody(genericGenUiResponse);
        expect(genericGenUiBody.surface).toMatchObject({
          value: { owner: 'Design team', namespace: 'editor-canvas', user: 'display label' },
        });
        records.push({ status: genericGenUiResponse.status });
        const fileWriteResponse = await fetch(`${started.url}/api/projects/${projectId}/files`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'index.html',
            content: '<!doctype html><html><body>Hosted trace</body></html>',
          }),
        });
        expect(fileWriteResponse.status).toBe(200);
        const fileWriteBody = await jsonBody(fileWriteResponse);
        expect(fileWriteBody.file).toMatchObject({ name: 'index.html' });
        records.push({ status: fileWriteResponse.status });
        const filesResponse = await fetch(`${started.url}/api/projects/${projectId}/files`);
        expect(filesResponse.status).toBe(200);
        const filesBody = await jsonBody(filesResponse);
        expect(filesBody.files).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'index.html' }),
        ]));
        records.push({ status: filesResponse.status });
        const fileResponse = await fetch(`${started.url}/api/projects/${projectId}/files/index.html`);
        expect(fileResponse.status).toBe(200);
        expect(await fileResponse.text()).toContain('Hosted trace');
        records.push({ status: fileResponse.status });
        const filePreviewResponse = await fetch(`${started.url}/api/projects/${projectId}/files/index.html/preview`);
        expect(filePreviewResponse.status).toBe(415);
        const filePreviewBody = await jsonBody(filePreviewResponse);
        expect(filePreviewBody.error?.code).toBe('BAD_REQUEST');
        expect(filePreviewBody.error?.message).toContain('unsupported preview type');
        records.push({ status: filePreviewResponse.status, code: filePreviewBody.error?.code });

        const previewUrlResponse = await fetch(`${started.url}/api/projects/${projectId}/preview-url?file=index.html`);
        expect(previewUrlResponse.status).toBe(200);
        const previewUrlBody = await jsonBody(previewUrlResponse);
        expect(previewUrlBody.url).toEqual(expect.any(String));
        records.push({ status: previewUrlResponse.status });
        const previewResponse = await fetch(`${started.url}${previewUrlBody.url as string}`);
        expect(previewResponse.status).toBe(200);
        expect(await previewResponse.text()).toContain('Hosted trace');
        records.push({ status: previewResponse.status });
        const archiveResponse = await fetch(`${started.url}/api/projects/${projectId}/archive`);
        expect(archiveResponse.status).toBe(200);
        expect(archiveResponse.headers.get('content-type')).toContain('application/zip');
        expect((await archiveResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
        records.push({ status: archiveResponse.status });
        const manifestResponse = await fetch(`${started.url}/api/projects/${projectId}/export/manifest`);
        expect(manifestResponse.status).toBe(200);
        expect((await jsonBody(manifestResponse)).files).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'index.html' }),
        ]));
        records.push({ status: manifestResponse.status });

        const lintResponse = await fetch(`${started.url}/api/artifacts/lint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ html: '<!doctype html><html><body>Lint trace</body></html>' }),
        });
        expect(lintResponse.status).toBe(200);
        expect((await jsonBody(lintResponse)).findings).toEqual(expect.any(Array));
        records.push({ status: lintResponse.status });
        const artifactResponse = await fetch(`${started.url}/api/artifacts/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            identifier: `hosted-trace-${iteration}`,
            html: '<!doctype html><html><body>Artifact trace</body></html>',
          }),
        });
        const artifactBody = await jsonBody(artifactResponse);
        expect(artifactResponse.status).toBe(200);
        artifactPath = typeof artifactBody.path === 'string' ? artifactBody.path : undefined;
        expect(artifactPath).toEqual(expect.any(String));
        expect(artifactBody.url).toEqual(expect.any(String));
        records.push({ status: artifactResponse.status });

        const grant = toolTokenRegistry.mint({
          runId: `hosted-trace-tool-${iteration}`,
          projectId,
          allowedEndpoints: ['/api/tools/design-systems/read'],
          allowedOperations: ['design-systems:read'],
          ttlMs: 60_000,
        });
        try {
          const toolResponse = await fetch(`${started.url}/api/tools/design-systems/read`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${grant.token}`,
            },
            body: JSON.stringify({ path: 'manifest.json' }),
          });
          const toolRecord = await recordResponse(toolResponse);
          expect(toolRecord.code).toBe('DESIGN_SYSTEM_NOT_FOUND');
          records.push(toolRecord);
        } finally {
          toolTokenRegistry.revokeToken(grant.token, 'manual');
        }

        const runResponse = await fetch(`${started.url}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            conversationId,
            agentId: 'claude',
            message: 'hosted trace run',
            sessionMode: 'design',
          }),
        });
        const runBody = await jsonBody(runResponse);
        expect(runResponse.status).toBe(202);
        expect(runBody.runId).toEqual(expect.any(String));
        const runId = runBody.runId as string;
        runIds.push(runId);
        records.push({ status: runResponse.status });
        await waitForTerminal(runId);
        records.push(await request('GET', `/api/runs/${runId}`));
        const firstRunEvents = await fetch(`${started.url}/api/runs/${runId}/events`);
        expect(firstRunEvents.status).toBe(200);
        const firstRunEventText = await firstRunEvents.text();
        expect(firstRunEventText).toContain('tool_use');
        expect(firstRunEventText).toContain('hosted fixture response');
        records.push(await openSse(`/api/runs/${runId}/events`, {
          headers: { 'Last-Event-ID': '1' },
        }));
        records.push(await openSse(`/api/runs/${runId}/agui`, {
          headers: { 'Last-Event-ID': '1' },
        }));
        records.push(await request('POST', `/api/runs/${runId}/cancel`));

        const resumedResponse = await fetch(`${started.url}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            conversationId,
            agentId: 'claude',
            message: 'hosted trace resumed prompt',
            sessionMode: 'design',
          }),
        });
        const resumedBody = await jsonBody(resumedResponse);
        expect(resumedResponse.status).toBe(202);
        expect(resumedBody.runId).toEqual(expect.any(String));
        const resumedRunId = resumedBody.runId as string;
        runIds.push(resumedRunId);
        records.push({ status: resumedResponse.status });
        await waitForTerminal(resumedRunId);
        const resumedEvents = await fetch(`${started.url}/api/runs/${resumedRunId}/events`);
        expect(resumedEvents.status).toBe(200);
        const resumedEventText = await resumedEvents.text();
        expect(resumedEventText).toContain('tool_use');
        const fixtureArgs = (await readFile(fixture.argsLogPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
        const firstArgs = fixtureArgs.find((args) => args.includes('--session-id'));
        const resumeArgs = fixtureArgs.find((args) => args.includes('--resume'));
        const firstSessionIndex = firstArgs?.indexOf('--session-id') ?? -1;
        const resumeIndex = resumeArgs?.indexOf('--resume') ?? -1;
        expect(firstSessionIndex).toBeGreaterThanOrEqual(0);
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(firstArgs?.[firstSessionIndex + 1]).toEqual(expect.any(String));
        expect(resumeArgs?.[resumeIndex + 1]).toBe(firstArgs?.[firstSessionIndex + 1]);
        records.push(await openSse(`/api/runs/${resumedRunId}/events`, {
          headers: { 'Last-Event-ID': '1' },
        }));
        records.push(await openSse(`/api/projects/${projectId}/events`));

        const chatResponse = await fetch(`${started.url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            conversationId,
            agentId: 'claude',
            message: 'hosted trace chat prompt',
            sessionMode: 'design',
          }),
        });
        expect(chatResponse.status).toBe(200);
        expect(chatResponse.headers.get('content-type')).toContain('text/event-stream');
        const chatText = await chatResponse.text();
        expect(chatText).toContain('hosted fixture response');
        expect(chatText).toContain('tool_use');
        records.push({ status: chatResponse.status, stream: true });
      } finally {
        for (const runId of runIds) {
          await request('POST', `/api/runs/${runId}/cancel`).catch(() => undefined);
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const checkpointResponse = await fetch(`${started.url}/api/projects/${projectId}/checkpoints`);
          if (checkpointResponse.status === 200) {
            const checkpointBody = await jsonBody(checkpointResponse);
            if (Array.isArray(checkpointBody.checkpoints) && checkpointBody.checkpoints.length >= runIds.length * 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await request('DELETE', `/api/projects/${projectId}`).catch(() => undefined);
        if (artifactPath) await rm(path.dirname(artifactPath), { recursive: true, force: true });
      }

      return records;
    };

    try {
      const first = await replayTrace(1);
      const second = await replayTrace(2);
      expect(second).toEqual(first);
    } finally {
      await started.shutdown?.();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      await fixture.restore();
    }
  });
});

async function installHostedClaudeFixture(): Promise<{
  pluginId: string;
  argsLogPath: string;
  restore: () => Promise<void>;
}> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'readable-hosted-boundary-claude-'));
  const { bin, argsLogPath } = await writeHostedClaudeFixture(binDir);
  const local = await startServer({ port: 0, returnServer: true }) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  let handedOff = false;
  try {
    const previousResponse = await fetch(`${local.url}/api/app-config`);
    const previous = await previousResponse.json() as { config?: Record<string, unknown> };
    const configured = await fetch(`${local.url}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'claude',
        agentCliEnv: { claude: { CLAUDE_BIN: bin } },
      }),
    });
    if (configured.status !== 200) throw new Error(`fixture config failed: ${configured.status}`);
    const pluginsResponse = await fetch(`${local.url}/api/plugins`);
    const pluginsBody = await pluginsResponse.json() as { plugins?: Array<{ id?: string }> };
    const pluginId = pluginsBody.plugins?.find((plugin) => typeof plugin.id === 'string')?.id;
    if (!pluginId) throw new Error('hosted fixture could not find a bundled plugin');
    await local.shutdown?.();
    await new Promise<void>((resolve) => local.server.close(() => resolve()));
    handedOff = true;
    return {
      pluginId,
      argsLogPath,
      restore: async () => {
        const restoreServer = await startServer({ port: 0, returnServer: true }) as {
          url: string;
          server: http.Server;
          shutdown?: () => Promise<void> | void;
        };
        try {
          await fetch(`${restoreServer.url}/api/app-config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentId: Object.hasOwn(previous.config ?? {}, 'agentId')
                ? previous.config?.agentId
                : null,
              agentCliEnv: Object.hasOwn(previous.config ?? {}, 'agentCliEnv')
                ? previous.config?.agentCliEnv
                : null,
            }),
          });
        } finally {
          await restoreServer.shutdown?.();
          await new Promise<void>((resolve) => restoreServer.server.close(() => resolve()));
          await rm(binDir, { recursive: true, force: true });
        }
      },
    };
  } finally {
    if (!handedOff) {
      await local.shutdown?.();
      await new Promise<void>((resolve) => local.server.close(() => resolve()));
      await rm(binDir, { recursive: true, force: true });
    }
  }
}

async function writeHostedClaudeFixture(dir: string): Promise<{
  bin: string;
  argsLogPath: string;
}> {
  const runnerPath = path.join(dir, 'claude-fixture.cjs');
  const argsLogPath = path.join(dir, 'args.jsonl');
  const body = `const fs = require('node:fs');
const argsLogPath = ${JSON.stringify(argsLogPath)};
if (process.argv.includes('--version')) { console.log('claude-code hosted-fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: claude -p --input-format stream-json --output-format stream-json --verbose --add-dir DIR'); process.exit(0); }
fs.appendFileSync(argsLogPath, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'hosted-fixture', session_id: 'hosted-trace-session' }));
console.log(JSON.stringify({ type: 'assistant', message: { id: 'hosted-fixture-message', content: [
  { type: 'tool_use', id: 'hosted-fixture-tool', name: 'Read', input: { path: 'index.html' } },
  { type: 'text', text: 'hosted fixture response' }
], stop_reason: 'end_turn' } }));
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }));
setTimeout(() => process.exit(0), 20);
`;
  await writeFile(runnerPath, body, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, 'claude-fixture.cmd');
    await writeFile(cmdPath, `@echo off\n"${process.execPath}" "${runnerPath}" %*\n`, 'utf8');
    return { bin: cmdPath, argsLogPath };
  }
  const bin = path.join(dir, 'claude-fixture');
  await writeFile(bin, `#!/usr/bin/env node\n${body}`, 'utf8');
  await chmod(bin, 0o755);
  return { bin, argsLogPath };
}
