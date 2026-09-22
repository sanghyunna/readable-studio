import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelDatabricksLogin,
  fetchDatabricksLogin,
  startDatabricksLogin,
  startDatabricksScan,
  streamDatabricksScanEvents,
} from '../../src/providers/databricks';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Databricks browser sign-in transport', () => {
  const job = { loginId: 'login-1', state: 'waiting-for-browser', createdAt: 't', deadlineAt: 't', completedAt: null, profileId: null, issues: [] };

  it('starts a sign-in with the host in the JSON body and returns the login job', async () => {
    const fetchMock = vi.fn(async () => Response.json(job, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(startDatabricksLogin({ host: 'https://workspace.example' })).resolves.toEqual(job);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/databricks/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ host: 'https://workspace.example' });
  });

  it('polls and cancels the job by its opaque id', async () => {
    const fetchMock = vi.fn(async () => Response.json(job));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchDatabricksLogin('login 1')).resolves.toEqual(job);
    await expect(cancelDatabricksLogin('login 1')).resolves.toEqual(job);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe('/api/databricks/login/login%201');
    expect(calls[1]![0]).toBe('/api/databricks/login/login%201');
    expect(calls[1]![1].method).toBe('DELETE');
  });

  it('surfaces the sanitized daemon error when a second sign-in is already running', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'DATABRICKS_STALE_REVISION', message: 'busy', retryable: true } }, { status: 409 }));
    await expect(startDatabricksLogin({ host: 'https://workspace.example' })).rejects.toMatchObject({ status: 409, code: 'DATABRICKS_STALE_REVISION', retryable: true });
  });
});

describe('Databricks scan transport termination', () => {
  it('reports a sanitized daemon SSE error rather than waiting for done', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: error\ndata: {"error":{"code":"DATABRICKS_UPSTREAM_UNAVAILABLE","message":"Scan failed","retryable":true}}\n\n'));
    } })));
    await expect(streamDatabricksScanEvents('scan', { onEvent })).rejects.toMatchObject({ code: 'DATABRICKS_UPSTREAM_UNAVAILABLE', retryable: true });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(['start', 'headers', 'body'] as const)('bounds a scan stalled at %s', async (phase) => {
    vi.useFakeTimers();
    let entered!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    let cancelled = false;
    vi.stubGlobal('fetch', async () => {
      if (phase !== 'body') { entered(); return new Promise<Response>(() => {}); }
      return new Response(new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; } }));
    });
    const result = phase === 'start' ? startDatabricksScan({ profileId: 'profile' }) : streamDatabricksScanEvents('scan', { onEvent: vi.fn() });
    const rejected = expect(result).rejects.toMatchObject({ status: 504, code: 'DATABRICKS_UPSTREAM_UNAVAILABLE', retryable: true });
    await requested;
    await vi.advanceTimersByTimeAsync(150_000);
    await rejected;
    if (phase === 'body') expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases an idle reader on close and accepts a fresh stream twice afterward', async () => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
      pull() { entered(); }, cancel() { cancelled = true; },
    }))).mockImplementation(async () => new Response('event: done\ndata: {"type":"done","revision":2,"scan":{"state":"complete"}}\n\n')));
    const controller = new AbortController();
    const first = streamDatabricksScanEvents('first', { onEvent: vi.fn() }, { signal: controller.signal });
    await reading;
    controller.abort();
    expect(await first).toBe(false);
    expect(cancelled).toBe(true);
    for (const id of ['second', 'third']) {
      const onEvent = vi.fn();
      expect(await streamDatabricksScanEvents(id, { onEvent })).toBe(true);
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'done' }));
    }
  });
});
