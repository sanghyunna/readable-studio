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
