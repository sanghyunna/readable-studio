import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksSubprocessRunner } from '../src/databricks/client.js';
import { diagnoseUpdateConnection, registerUpdateRoutes } from '../src/update-routes.js';
import { createUpdateTokenProvider, UpdateSourceError } from '../src/update-source.js';

const serverUrl = 'https://updates-1.aws.databricksapps.com';
const workspace = 'https://adb-1.azuredatabricks.net';
const bearer = 'secret-bearer-value';
const manifest = { version: '1.3.4', fileName: 'Readable-Studio-win-x64-portable.zip', size: 123, sha256: 'a'.repeat(64), notes: '', publishedAt: '2026-10-15T00:00:00Z' };
const healthy = { ok: true, service: 'readable-studio-update-server', apiVersion: 1 };
const token = async () => ({ token: bearer, host: workspace });
function http(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    return (routes[path] ?? (() => new Response('missing', { status: 404 })))();
  }) as unknown as typeof fetch;
}

/** Fake Databricks CLI: answers the exact commands the token provider issues. */
function cli(options: { profiles?: { name: string; host: string }[]; apps?: Record<string, { url: string }[] | 'auth' | 'denied'> } = {}): DatabricksSubprocessRunner {
  const profiles = options.profiles ?? [{ name: 'DEFAULT', host: workspace }];
  const apps = options.apps ?? { DEFAULT: [{ url: `${serverUrl}/` }] };
  return async (_exe, args) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v0.250.0', stderr: '', exitCode: 0 };
    if (args[0] === 'auth' && args[1] === 'profiles') return { stdout: JSON.stringify({ profiles }), stderr: '', exitCode: 0 };
    if (args[0] === 'apps') {
      const listed = apps[args[3]!] ?? [];
      if (listed === 'auth') return { stdout: '', stderr: 'Error: cannot configure default credentials. not logged in', exitCode: 1 };
      if (listed === 'denied') return { stdout: '', stderr: 'Error: PERMISSION_DENIED: forbidden', exitCode: 1 };
      return { stdout: JSON.stringify(listed), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'auth' && args[1] === 'token') return { stdout: JSON.stringify({ access_token: bearer, expiry: new Date(Date.now() + 3_600_000).toISOString() }), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'unknown command', exitCode: 1 };
  };
}
const bundled = async () => ({ path: 'C:\\Readable Studio\\resources\\app\\vendor\\databricks\\databricks.exe', source: 'bundled' as const });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('diagnoseUpdateConnection', () => {
  it.each([
    ['not a url', 'invalid-url'],
    ['http://updates.example.com', 'not-https'],
    ['https://user:pw@updates.example.com', 'invalid-url'],
  ])('rejects %s as %s without touching the CLI or network', async (input, failure) => {
    const tokenSpy = vi.fn(token);
    const report = await diagnoseUpdateConnection(input, { token: tokenSpy, fetch: http({}) });
    expect(report).toMatchObject({ ok: false, failure });
    expect(report.steps).toEqual([expect.objectContaining({ step: 'url', ok: false })]);
    expect(tokenSpy).not.toHaveBeenCalled();
  });

  it('always ends at the deadline when discovery hangs and keeps the steps so far', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = diagnoseUpdateConnection(serverUrl, { token: () => new Promise(() => {}), fetch: http({}), connectionTimeoutMs: 25_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    const report = await pending;
    expect(report).toMatchObject({ ok: false, failure: 'timeout', timeoutMs: 25_000 });
    expect(report.steps.map((step) => step.step)).toEqual(['url', 'timeout']);
  });

  it('defaults to a bounded 25 s check', async () => {
    const report = await diagnoseUpdateConnection('nope', {});
    expect(report.timeoutMs).toBe(25_000);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not-update-server'],
    [503, 'app-stopped'],
    [502, 'app-stopped'],
    [500, 'invalid-response'],
  ])('classifies HTTP %i from the health endpoint as %s and logs the status', async (status, failure) => {
    const report = await diagnoseUpdateConnection(serverUrl, { token, fetch: http({ '/api/v1/health': () => new Response('x', { status }) }) });
    expect(report).toMatchObject({ ok: false, failure });
    expect(report.steps).toContainEqual(expect.objectContaining({ step: 'health', ok: false, httpStatus: status }));
  });

  it('classifies a JSON answer from another service as not an update server and HTML as unexpected', async () => {
    expect(await diagnoseUpdateConnection(serverUrl, { token, fetch: http({ '/api/v1/health': () => Response.json({ ok: true, service: 'other' }) }) }))
      .toMatchObject({ failure: 'not-update-server' });
    expect(await diagnoseUpdateConnection(serverUrl, { token, fetch: http({ '/api/v1/health': () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) }) }))
      .toMatchObject({ failure: 'invalid-response' });
  });

  it.each([
    [{ code: 'ENOTFOUND' }, 'dns'],
    [{ code: 'EAI_AGAIN' }, 'dns'],
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [new Error('unexpected redirect'), 'not-logged-in'],
  ])('classifies network failure %o as %s', async (cause, failure) => {
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }) as unknown as typeof fetch;
    expect(await diagnoseUpdateConnection(serverUrl, { token, fetch: fetcher })).toMatchObject({ ok: false, failure });
  });

  it('classifies an aborted HTTP request as timeout', async () => {
    const fetcher = vi.fn(async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }) as unknown as typeof fetch;
    expect(await diagnoseUpdateConnection(serverUrl, { token, fetch: fetcher })).toMatchObject({ failure: 'timeout' });
  });

  it('reports a CLI that is neither bundled nor installed', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: async () => null }), fetch: http({}) });
    expect(report).toMatchObject({ ok: false, failure: 'cli-missing' });
    expect(report.steps).toContainEqual(expect.objectContaining({ step: 'cli', ok: false }));
  });

  it('reports not signed in with the workspace host to sign in to', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: bundled, runner: cli({ apps: { DEFAULT: 'auth' } }) }), fetch: http({}) });
    expect(report).toMatchObject({ ok: false, failure: 'not-logged-in', host: workspace });
    expect(report.steps).toContainEqual(expect.objectContaining({ step: 'workspace', ok: false, detail: expect.stringContaining('DEFAULT') }));
  });

  it('reports not signed in when there are no CLI profiles at all', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: bundled, runner: cli({ profiles: [] }) }), fetch: http({}) });
    expect(report).toMatchObject({ failure: 'not-logged-in' });
    expect(report.steps).toContainEqual(expect.objectContaining({ step: 'profiles', ok: false }));
  });

  it('reports the workspace that owns the app as not found among signed-in profiles', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: bundled, runner: cli({
      profiles: [{ name: 'DEFAULT', host: workspace }, { name: 'OTHER', host: 'https://adb-2.azuredatabricks.net' }],
      apps: { DEFAULT: [{ url: 'https://another.databricksapps.com' }], OTHER: [] },
    }) }), fetch: http({}) });
    expect(report).toMatchObject({ ok: false, failure: 'workspace-not-found' });
    const workspaces = report.steps.filter((step) => step.step === 'workspace').map((step) => step.detail).join('\n');
    expect(workspaces).toContain('DEFAULT');
    expect(workspaces).toContain('OTHER');
  });

  it('reports a profile without permission to list apps as forbidden', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: bundled, runner: cli({ apps: { DEFAULT: 'denied' } }) }), fetch: http({}) });
    expect(report).toMatchObject({ failure: 'forbidden' });
  });

  it('verifies every step on success, names what it found and never exposes the token', async () => {
    const fetcher = http({ '/api/v1/health': () => Response.json(healthy), '/api/v1/latest': () => Response.json(manifest) });
    const report = await diagnoseUpdateConnection(`${serverUrl}/`, { token: createUpdateTokenProvider({ resolveCli: bundled, runner: cli() }), fetch: fetcher });
    expect(report).toMatchObject({
      ok: true, serverUrl, host: workspace, profile: 'DEFAULT', latest: '1.3.4',
      cli: { path: 'C:\\Readable Studio\\resources\\app\\vendor\\databricks\\databricks.exe', source: 'bundled', version: '0.250.0' },
    });
    expect(report.failure).toBeUndefined();
    expect(report.steps.map((step) => step.step)).toEqual(['url', 'cli', 'profiles', 'workspace', 'token', 'health', 'latest']);
    expect(report.steps.every((step) => step.ok && Number.isInteger(step.elapsedMs) && step.elapsedMs >= 0)).toBe(true);
    expect(report.steps.filter((step) => step.httpStatus === 200).map((step) => step.step)).toEqual(['health', 'latest']);
    expect(JSON.stringify(report)).not.toContain(bearer);
  });

  it('labels a PATH executable as installed', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token: createUpdateTokenProvider({ resolveCli: async () => ({ path: 'C:\\tools\\databricks.exe', source: 'path' }), runner: cli() }),
      fetch: http({ '/api/v1/health': () => Response.json(healthy), '/api/v1/latest': () => Response.json(manifest) }) });
    expect(report.cli).toMatchObject({ source: 'installed' });
  });

  it('treats a missing latest release as connected with no release yet', async () => {
    const report = await diagnoseUpdateConnection(serverUrl, { token, fetch: http({ '/api/v1/health': () => Response.json(healthy) }) });
    expect(report).toMatchObject({ ok: true, latest: null });
    expect(report.steps).toContainEqual(expect.objectContaining({ step: 'latest', ok: true, httpStatus: 404 }));
  });

  it('keeps the finer classification on UpdateSourceError', () => {
    expect(new UpdateSourceError('unreachable', undefined, 'app-stopped')).toMatchObject({ reason: 'unreachable', failure: 'app-stopped' });
  });
});

describe('update connection routes', () => {
  async function serve(deps: Parameters<typeof registerUpdateRoutes>[1]) {
    const app = express(); app.use(express.json());
    registerUpdateRoutes(app, deps);
    const server: Server = createServer(app);
    server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { base, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
  }

  it('POST /api/update/connection returns the report with 200 and falls back to the configured URL', async () => {
    const { base, close } = await serve({ token, config: async () => ({ enabled: false, serverUrl }), fetch: http({ '/api/v1/health': () => new Response('stopped', { status: 503 }) }) });
    try {
      const response = await fetch(`${base}/api/update/connection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, serverUrl, failure: 'app-stopped', steps: expect.any(Array) });
    } finally { await close(); }
  });

  it('health keeps its legacy shape but adds the finer failure', async () => {
    const { base, close } = await serve({ token, fetch: http({ '/api/v1/health': () => new Response('stopped', { status: 503 }) }) });
    try {
      const response = await fetch(`${base}/api/update/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'unreachable', failure: 'app-stopped' });
    } finally { await close(); }
  });
});
