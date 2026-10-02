/**
 * Regression coverage for the `readable-studio://` protocol proxy in
 * apps/packaged/src/protocol.ts.
 *
 * The packaged Electron entry registers `readable-studio://` as the loader for the
 * web runtime and forwards every renderer request to the local web
 * sidecar through Node's global `fetch` (which is undici under the
 * hood). Without a try/catch in the handler, undici throwing
 * `setTypeOfService EINVAL` from socket internals on certain macOS /
 * VPN configurations bubbled up to Electron's default uncaught
 * exception handler — surfacing as a native "JavaScript error in
 * main process" dialog the moment the user did anything that
 * triggered a fetch (e.g. Settings → Pets → Community).
 *
 * @see https://github.com/nexu-io/readable-studio/issues/895
 */

// `protocol.handle` from the `electron` module is invoked at import
// time inside `apps/packaged/src/protocol.ts`. Stub the module before
// importing so the test environment doesn't need a real Electron
// runtime.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

import { afterEach, describe, expect, it } from 'vitest';

import { handleReadableStudioRequest, packagedEntryUrl } from '../src/protocol.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readable-studio:// protocol proxy', () => {
  it.each(['', 'example.com'])('keeps default and registered protocol traffic direct with dead proxy env and NO_PROXY=%s', async (noProxy) => {
    const requests: { url: string; method: string; body: string; marker: string | undefined }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ url: request.url ?? '', method: request.method ?? '', body: Buffer.concat(chunks).toString(), marker: request.headers['x-test-marker'] as string | undefined });
        response.setHeader('x-sidecar', 'direct');
        response.end('sidecar response');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected sidecar listener');
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete env[name];
      Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: noProxy, NODE_USE_ENV_PROXY: '1' });
      const stub = 'export const protocol = { registerSchemesAsPrivileged() {}, handle(_scheme, handler) { globalThis.protocolHandler = handler; } };';
      const source = `
        import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, nextResolve) {
          return specifier === 'electron' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true } : nextResolve(specifier, context);
        } });
        const { handleReadableStudioRequest, registerReadableStudioProtocol } = await import(${JSON.stringify(new URL('../src/protocol.ts', import.meta.url).href)});
        const origin = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
        registerReadableStudioProtocol(origin);
        const results = [];
        for (const handler of [request => handleReadableStudioRequest(request, origin), globalThis.protocolHandler]) {
          const response = await handler(new Request('readable-studio://app/api/test?limit=2', { method: 'POST', headers: { 'x-test-marker': 'preserved' }, body: 'renderer body' }));
          results.push({ status: response.status, header: response.headers.get('x-sidecar'), body: await response.text() });
        }
        console.log(JSON.stringify(results));
      `;
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href, '--input-type=module', '-e', source], { env, windowsHide: true, timeout: 10000 });
      expect(JSON.parse(stdout)).toEqual(Array.from({ length: 2 }, () => ({ status: 200, header: 'direct', body: 'sidecar response' })));
      expect(requests).toEqual(Array.from({ length: 2 }, () => ({ url: '/api/test?limit=2', method: 'POST', body: 'renderer body', marker: 'preserved' })));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }, 15000);

  it('follows local redirects and streams the response before the sidecar finishes', async () => {
    let finish: (() => void) | undefined;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/stream' }).end();
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('first');
        finish = () => response.end('last');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected sidecar listener');
      const response = await handleReadableStudioRequest(new Request('readable-studio://app/redirect'), `http://127.0.0.1:${address.port}`);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
      finish!();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
      expect((await reader.read()).done).toBe(true);
      expect(requests).toEqual(['/redirect', '/stream']);
    } finally {
      finish?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it('publishes the exact packaged entry URL without a legacy alias', () => {
    expect(packagedEntryUrl()).toBe('readable-studio://app/');
  });

  it('proxies the request through fetchImpl with the rewritten target URL', async () => {
    const captured: Request[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      captured.push(input as Request);
      return new Response('ok', { status: 200 });
    };

    const request = new Request('readable-studio://app/api/codex-pets/sync', { method: 'POST' });
    const response = await handleReadableStudioRequest(request, 'http://127.0.0.1:17579/', fetchImpl);

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://127.0.0.1:17579/api/codex-pets/sync');
    expect(captured[0]!.method).toBe('POST');
  });

  it('rejects legacy and mixed protocol shapes without proxying them', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const retiredScheme = ['open', 'design'].join('-');
    const legacy = await handleReadableStudioRequest(
      new Request(`${retiredScheme}://app/api/projects`),
      'http://127.0.0.1:42424/',
      fetchImpl,
    );
    const mixed = await handleReadableStudioRequest(
      new Request('readable-studio://readable/api/projects'),
      'http://127.0.0.1:42424/',
      fetchImpl,
    );

    expect(legacy.status).toBe(400);
    expect(mixed.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves the request path, search, and hash when rewriting to the web sidecar', async () => {
    const captured: Request[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      captured.push(input as Request);
      return new Response('', { status: 204 });
    };

    const request = new Request('readable-studio://app/api/projects?limit=5#section', { method: 'GET' });
    await handleReadableStudioRequest(request, 'http://127.0.0.1:42424/', fetchImpl);

    const target = new URL(captured[0]!.url);
    expect(target.host).toBe('127.0.0.1:42424');
    expect(target.pathname).toBe('/api/projects');
    expect(target.search).toBe('?limit=5');
    // `Request` strips the hash fragment per the Fetch spec, but the
    // pathname + search above are the values the proxy is responsible
    // for getting right. Pin those.
  });

  // The flagship #895 regression: undici can throw `setTypeOfService
  // EINVAL` mid-fetch from socket internals. Without the try/catch
  // wrapper around the handler's fetch call, that rejection propagates
  // up to Electron's default uncaught exception handler and surfaces
  // as a native "JavaScript error in main process" dialog. The
  // handler must instead return a 502 Response so the renderer sees
  // a normal failure and the process keeps running.
  it('returns a 502 Response when the underlying fetch rejects (issue #895)', async () => {
    const fetchImpl: typeof fetch = async () => {
      const error = new Error('setTypeOfService EINVAL') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      error.syscall = 'setTypeOfService';
      throw error;
    };

    const request = new Request('readable-studio://app/api/codex-pets/sync', { method: 'POST' });
    const response = await handleReadableStudioRequest(request, 'http://127.0.0.1:17579/', fetchImpl);

    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: string;
      message: string;
      code?: string;
      target: string;
    };
    expect(body.error).toBe('READABLE_STUDIO_PROTOCOL_PROXY_FAILED');
    expect(body.message).toContain('setTypeOfService');
    expect(body.code).toBe('EINVAL');
    expect(body.target).toBe('http://127.0.0.1:17579/api/codex-pets/sync');
  });

  it('does not throw when fetch rejects (the actual #895 root-cause guard)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('socket hang up');
    };

    // The promise must resolve with a Response, never reject.
    await expect(
      handleReadableStudioRequest(new Request('readable-studio://app/'), 'http://127.0.0.1:1/', fetchImpl),
    ).resolves.toBeInstanceOf(Response);
  });

  it('handles non-Error rejection values without throwing', async () => {
    const fetchImpl: typeof fetch = async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'sync timeout';
    };

    const response = await handleReadableStudioRequest(
      new Request('readable-studio://app/api/probe'),
      'http://127.0.0.1:1/',
      fetchImpl,
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('sync timeout');
  });

  it('logs response metadata and html title when READABLE_STUDIO_PROTOCOL_DIAG is enabled', async () => {
    const originalDiag = process.env.READABLE_STUDIO_PROTOCOL_DIAG;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      process.env.READABLE_STUDIO_PROTOCOL_DIAG = '1';
      const fetchImpl: typeof fetch = async () =>
        new Response('<html><head><title>Blocked by corporate policy</title></head></html>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        });

      const response = await handleReadableStudioRequest(new Request('readable-studio://app/'), 'http://127.0.0.1:17579/', fetchImpl);

      expect(await response.text()).toContain('Blocked by corporate policy');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[readable-studio packaged] readable-studio proxy response status=200 contentType=text/html'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('title="Blocked by corporate policy"'),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      if (originalDiag == null) delete process.env.READABLE_STUDIO_PROTOCOL_DIAG;
      else process.env.READABLE_STUDIO_PROTOCOL_DIAG = originalDiag;
    }
  });
});
