import { EventEmitter } from 'node:events';
import type { Page, Request as WireRequest } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { classifyClientFetchCancellation, installClientFetchCancellationProbe,
  observeClientFetchCancellations, type ClientFetchRead } from '@/playwright/client-fetch-cancellation';

const url = 'http://localhost/api/runtime/user';
const read: ClientFetchRead = { url, method: 'GET', resourceType: 'fetch', status: null,
  finished: false, errorText: 'net::ERR_ABORTED', token: 'document:1' };
const started = { token: read.token!, url, kind: 'started' as const, at: '2026-09-09T00:00:00.000Z', stack: 'owner', reason: null };
const aborted = { ...started, kind: 'aborted' as const, at: '2026-09-09T00:00:00.001Z', stack: 'cleanup', reason: 'AbortError' };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit client cancellation corroboration', () => {
  test('records URL, resource type, reason and exact ownership without a completed counterpart', () => {
    expect(classifyClientFetchCancellation(read, [started, aborted])).toMatchObject({
      url, resourceType: 'fetch', finished: false, status: null, corroborated: true,
      reason: 'client-abort-signal', ownership: { token: read.token, ownerStack: 'owner', abortStack: 'cleanup', abortReason: 'AbortError' },
    });
  });

  test.each(['none', 'start-only', 'abort-only', 'wrong-token', 'wrong-url', 'reversed'] as const)(
    'missing or mismatched lifecycle proof is not accepted: %s', (kind) => {
      const signals = kind === 'none' ? [] : kind === 'start-only' ? [started] : kind === 'abort-only' ? [aborted]
        : kind === 'wrong-token' ? [started, { ...aborted, token: 'document:2' }]
        : kind === 'wrong-url' ? [started, { ...aborted, url: `${url}?other` }]
        : [aborted, started];
      expect(classifyClientFetchCancellation(read, signals).corroborated).toBe(false);
    },
  );

  test.each([
    { method: 'POST' }, { resourceType: 'document' }, { finished: true }, { token: null },
    { errorText: null }, { errorText: 'requestfailed' }, { errorText: 'net::ERR_FAILED' },
    { errorText: 'net::ERR_CONNECTION_RESET' }, { errorText: 'net::ERR_ABORTED extra' },
    { status: 404 }, { status: 503 }, { status: 302 },
  ])('does not excuse a non-cancellation or genuine failure: %j', (change) => {
    const result = classifyClientFetchCancellation({ ...read, ...change }, [started, aborted]);
    expect(result.corroborated).toBe(false);
    expect(result.ownership).toBeNull();
    if (change.status !== undefined) expect(result.httpFailure).toBe(true);
    if (change.errorText) expect(result.transportFailure).toBe(true);
  });

  test.each(['/api/projects/p/files', '/api/projects/p/files/', '/api/projects/p/raw/nested/file.html']) (
    'never weakens project-file completion rules: %s', (path) => {
      const target = `http://localhost${path}`;
      expect(classifyClientFetchCancellation({ ...read, url: target },
        [{ ...started, url: target }, { ...aborted, url: target }]).corroborated).toBe(false);
    },
  );

  test('is evidence-based, not a runtime-user URL allowlist', () => {
    const target = 'http://localhost/api/another-owned-read';
    expect(classifyClientFetchCancellation({ ...read, url: target, status: 200 },
      [{ ...started, url: target }, { ...aborted, url: target }]).corroborated).toBe(true);
  });
});

function browser(fetch: typeof globalThis.fetch) {
  const target = { fetch, location: new URL('http://localhost/'), top: null as unknown };
  target.top = target;
  vi.stubGlobal('window', target);
  return target;
}

describe('shipped lifecycle probe and wire observer', () => {
  test('correlates two concurrent same-URL owners, retaining the surviving request and original signal', async () => {
    const page = new EventEmitter();
    const wireRequests: WireRequest[] = [];
    const nativeFetch = vi.fn<typeof fetch>((input, init) => {
      const incoming = { url: () => String(input), method: () => 'GET', resourceType: () => 'fetch',
        headers: () => Object.fromEntries(new Headers(init?.headers).entries()),
        failure: () => ({ errorText: 'net::ERR_ABORTED' }) } as unknown as WireRequest;
      wireRequests.push(incoming);
      page.emit('request', incoming);
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          page.emit('requestfailed', incoming);
          reject(init!.signal!.reason);
        }, { once: true });
      });
    });
    const target = browser(nativeFetch);
    vi.spyOn(console, 'debug').mockImplementation((text: string) => {
      page.emit('console', { type: () => 'debug', text: () => text });
    });
    const initPage = Object.assign(page, { addInitScript: async (install: typeof installClientFetchCancellationProbe, options: { header: string; marker: string }) => install(options) });
    const observer = await observeClientFetchCancellations(initPage as unknown as Page);
    const first = new AbortController();
    const second = new AbortController();
    try {
      const rejected = expect(target.fetch(url, { signal: first.signal })).rejects.toMatchObject({ name: 'AbortError' });
      const surviving = expect(target.fetch(url, { signal: second.signal })).rejects.toMatchObject({ name: 'AbortError' });
      first.abort();
      await rejected;
      expect(nativeFetch.mock.calls[0]?.[1]?.signal).toBe(first.signal);
      expect(observer.requests).toHaveLength(2);
      expect(observer.requests[0]).toMatchObject({ corroborated: true, ownership: { ownerStack: expect.any(String), abortStack: expect.any(String) } });
      expect(observer.requests[1]).toMatchObject({ corroborated: false, errorText: null, finished: false });
      expect(observer.requests[0]?.token).not.toBe(observer.requests[1]?.token);
      expect(observer.classify(wireRequests[0]!)).toEqual(observer.requests[0]);
      second.abort();
      await surviving;
      // Headers can arrive before abort; a genuine error still overrides proof.
      const response = { request: () => wireRequests[1], status: () => 503 };
      page.emit('response', response);
      expect(observer.requests[1]).toMatchObject({ corroborated: false, httpFailure: true });
    } finally { observer.dispose(); }
    expect(page.eventNames()).toEqual([]);
  });

  test('records abort after response headers without consuming or replacing the body', async () => {
    const body = Response.json({ username: 'local-user' });
    const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(body);
    const target = browser(nativeFetch);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    installClientFetchCancellationProbe({ header: 'x-probe', marker: 'probe:' });
    const controller = new AbortController();
    const incoming = new Request(url, { signal: controller.signal, headers: { 'x-original': 'keep' } });
    expect(await target.fetch(incoming)).toBe(body);
    expect(body.bodyUsed).toBe(false);
    expect(new Headers(nativeFetch.mock.calls[0]?.[1]?.headers).get('x-original')).toBe('keep');
    controller.abort('owner-unmounted');
    const signals = debug.mock.calls.map(([message]) => JSON.parse(String(message).slice('probe:'.length)));
    expect(signals.map((signal) => signal.kind)).toEqual(['started', 'aborted']);
    expect(signals[1].reason).toBe('owner-unmounted');
  });

  test.each(['cross-origin', 'raw', 'files', 'write', 'no-signal', 'already-aborted', 'iframe', 'blank'] as const)(
    'leaves %s traffic untouched', async (kind) => {
      const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response());
      const target = browser(nativeFetch);
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      if (kind === 'iframe') target.top = {};
      if (kind === 'blank') target.location = new URL('about:blank');
      installClientFetchCancellationProbe({ header: 'x-probe', marker: 'probe:' });
      const controller = new AbortController();
      if (kind === 'already-aborted') controller.abort();
      const input = kind === 'cross-origin' ? 'https://other/api/runtime/user' : kind === 'raw'
        ? 'http://localhost/api/projects/p/raw/a.html' : kind === 'files' ? 'http://localhost/api/projects/p/files' : url;
      const init = { method: kind === 'write' ? 'POST' : 'GET', signal: kind === 'no-signal' ? null : controller.signal };
      await target.fetch(input, init);
      expect(nativeFetch).toHaveBeenCalledExactlyOnceWith(input, init);
      expect(debug).not.toHaveBeenCalled();
    },
  );

  test('init failure rejects and removes all subscriptions', async () => {
    const page = Object.assign(new EventEmitter(), { addInitScript: async () => { throw new Error('init failed'); } });
    await expect(observeClientFetchCancellations(page as unknown as Page)).rejects.toThrow('init failed');
    expect(page.eventNames()).toEqual([]);
  });
});
