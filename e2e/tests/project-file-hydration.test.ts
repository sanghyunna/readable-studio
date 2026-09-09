import { EventEmitter, once } from 'node:events';
import type { Frame, Page, Request, Response } from '@playwright/test';
import { describe, expect, test, vi } from 'vitest';
import { observeProjectFileHydration, readHydratedProjectFile } from '@/playwright/project-file-hydration';

const mainFrame = { parentFrame: () => null } as Frame;

function request(path = '/api/projects/owned/raw/artifact.html', errorText: string | null = 'net::ERR_ABORTED', method = 'GET'): Request {
  return {
    method: () => method,
    isNavigationRequest: () => false,
    frame: () => mainFrame,
    url: () => path.startsWith('http') ? path : `http://localhost${path}`,
    resourceType: () => path.includes('/raw/') ? 'document' : 'fetch',
    failure: () => errorText === null ? null : { errorText },
  } as Request;
}
function response(incoming: Request, status = 200): Response {
  return {
    request: () => incoming, url: () => incoming.url(),
    ok: () => status >= 200 && status < 300, status: () => status,
  } as Response;
}
function harness() {
  const page = new EventEmitter();
  const hydration = observeProjectFileHydration(page as unknown as Page);
  const complete = (incoming: Request, status = 200) => {
    page.emit('request', incoming);
    page.emit('response', response(incoming, status));
    page.emit('requestfinished', incoming);
  };
  return { page, hydration, complete };
}

describe('project-file hydration lifecycle', () => {
  test('headers never release the barrier, including a read started during drain', async () => {
    const { page, hydration } = harness();
    try {
      const first = request('/api/projects/owned/files');
      const second = request();
      page.emit('request', first);
      const navigate = vi.fn();
      const drained = hydration.drain().then(navigate);
      page.emit('request', second);
      page.emit('response', response(first));
      page.emit('response', response(second));
      expect(hydration.counts).toMatchObject({ reads: 2, responses: 2, rawResponses: 1, finished: 0, pending: 2 });
      expect(navigate).not.toHaveBeenCalled();
      page.emit('requestfinished', first);
      expect(hydration.counts.pending).toBe(1);
      expect(navigate).not.toHaveBeenCalled();
      page.emit('requestfinished', second);
      await drained;
      expect(navigate).toHaveBeenCalledOnce();
      expect(hydration.counts).toEqual({
        reads: 2, responses: 2, rawReads: 1, rawResponses: 1, rawFinished: 1, finished: 2,
        pending: 0, excludedPending: 0, cancelled: 0, superseded: 0, unprovenCancelled: 0, httpFailures: 0, transportFailures: 0, failed: 0,
      });
    } finally { hydration.dispose(); }
  });

  test.each(['none', 'legacy', 'untracked-response', 'finished-without-response', 'write', 'run'] as const)(
    'zero-match contract fails: %s', async (kind) => {
      const { page, hydration, complete } = harness();
      try {
        if (kind === 'legacy') complete(request('/api/projects/owned/files/artifact.html'));
        if (kind === 'write') complete(request(undefined, null, 'POST'));
        if (kind === 'run') complete(request('/api/runs/active/events'));
        const incoming = request();
        if (kind === 'untracked-response') page.emit('response', response(incoming));
        if (kind === 'finished-without-response') {
          page.emit('request', incoming);
          page.emit('requestfinished', incoming);
        }
        await expect(hydration.drain()).rejects.toBeInstanceOf(Error);
      } finally { hydration.dispose(); }
    },
  );

  test('list-only is explicitly no-artifact, not successful raw hydration', async () => {
    const { hydration, complete } = harness();
    try {
      complete(request('/api/projects/owned/files'));
      await hydration.drain(1_000, 'no-artifact');
      await expect(hydration.drain(1_000, 'raw')).rejects.toBeInstanceOf(Error);
      expect(hydration.counts).toMatchObject({ reads: 1, responses: 1, rawReads: 0, rawFinished: 0 });
    } finally { hydration.dispose(); }
  });

  test('no-artifact rejects even a cancelled raw request with a successful replacement', async () => {
    const { page, hydration, complete } = harness();
    try {
      const cancelled = request();
      page.emit('request', cancelled);
      page.emit('requestfailed', cancelled);
      complete(request());
      await expect(hydration.drain(1_000, 'no-artifact')).rejects.toBeInstanceOf(Error);
      await hydration.drain(1_000, 'raw');
    } finally { hydration.dispose(); }
  });

  test.each([
    ['/api/projects/owned/files', '/api/projects/owned/files', false],
    ['/api/projects/owned/files', '/api/projects/owned/files', true],
    ['/api/projects/owned/raw/artifact.html?v=1&r=0', '/api/projects/owned/raw/artifact.html?cacheBust=2', false],
    ['/api/projects/owned/raw/artifact.html?odPreviewBridge=scroll&fr=2', '/api/projects/owned/raw/artifact.html?v=2', true],
  ] as const)('corroborates cancellation with a completed same-resource replacement: %s headers=%s', async (path, nextPath, headers) => {
    const { page, hydration, complete } = harness();
    try {
      const cancelled = request(path);
      page.emit('request', cancelled);
      if (headers) page.emit('response', response(cancelled));
      page.emit('requestfailed', cancelled);
      expect(hydration.counts).toMatchObject({ cancelled: 1, superseded: 0, unprovenCancelled: 1, failed: 0 });
      complete(request(nextPath));
      await hydration.drain();
      expect(hydration.counts).toMatchObject({ cancelled: 1, superseded: 1, unprovenCancelled: 0, transportFailures: 0, failed: 0 });
      expect(hydration.requests[0]).toMatchObject({ outcome: 'cancelled', errorText: 'net::ERR_ABORTED', replacementId: 2, status: headers ? 200 : null });
    } finally { hydration.dispose(); }
  });

  test('a completed fetch can replace an iframe read independently of event order', async () => {
    const { page, hydration, complete } = harness();
    try {
      complete({ ...request(), resourceType: () => 'fetch' } as Request);
      const cancelled = request();
      page.emit('request', cancelled);
      page.emit('response', response(cancelled));
      page.emit('requestfailed', cancelled);
      await hydration.drain(1_000, 'raw');
      expect(hydration.requests[1]).toMatchObject({ replacementId: 1, resourceType: 'document' });
    } finally { hydration.dispose(); }
  });

  test.each([
    '/api/projects/other/raw/artifact.html', '/api/projects/owned/raw/other.html',
    '/api/projects/owned/files', 'http://other/api/projects/owned/raw/artifact.html',
    '/api/projects/owned/raw/artifact.html?format=other',
  ])('does not corroborate a cancellation with an unrelated success: %s', async (path) => {
    const { page, hydration, complete } = harness();
    try {
      const cancelled = request();
      page.emit('request', cancelled);
      page.emit('requestfailed', cancelled);
      complete(request(path));
      await expect(hydration.drain()).rejects.toBeInstanceOf(Error);
      expect(hydration.counts).toMatchObject({ cancelled: 1, superseded: 0, unprovenCancelled: 1, transportFailures: 0 });
    } finally { hydration.dispose(); }
  });

  test.each(['net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_FAILED', 'net::ERR_TIMED_OUT', 'net::ERR_ABORTED extra', null])(
    'genuine or unknown transport failure stays fatal despite a successful replacement: %s', async (text) => {
      const { page, hydration, complete } = harness();
      try {
        const failed = request(undefined, text);
        page.emit('request', failed);
        const rejected = expect(hydration.drain()).rejects.toBeInstanceOf(AggregateError);
        page.emit('requestfailed', failed);
        complete(request());
        await rejected;
        await expect(hydration.drain()).rejects.toBeInstanceOf(AggregateError);
        expect(hydration.counts).toMatchObject({ cancelled: 0, superseded: 0, transportFailures: 1, failed: 1 });
        expect(hydration.requests[0]?.errorText).toBe(text ?? 'requestfailed');
      } finally { hydration.dispose(); }
    },
  );

  test.each([404, 503])('HTTP %s followed by ERR_ABORTED is still fatal', async (status) => {
    const { page, hydration, complete } = harness();
    try {
      const failed = request();
      page.emit('request', failed);
      page.emit('response', response(failed, status));
      page.emit('requestfailed', failed);
      complete(request());
      await expect(hydration.drain()).rejects.toBeInstanceOf(AggregateError);
      expect(hydration.counts).toMatchObject({ cancelled: 1, httpFailures: 1, transportFailures: 0, failed: 1 });
    } finally { hydration.dispose(); }
  });

  test('bounds an unfinished body and removes subscriptions', async () => {
    vi.useFakeTimers();
    const { page, hydration } = harness();
    try {
      page.emit('request', request());
      const rejected = expect(hydration.drain(10)).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { hydration.dispose(); vi.useRealTimers(); }
    expect(page.eventNames()).toEqual([]);
  });
});

describe('document replacement boundary', () => {
  const documentRequest = () => ({ ...request('/projects/owned'), isNavigationRequest: () => true,
    resourceType: () => 'document' }) as Request;

  test('drains a live list before navigation, records only its outgoing-document successor, and awaits new live reads', async () => {
    const { page, hydration } = harness();
    const first = request('/api/projects/owned/files');
    const discarded = request('/api/projects/owned/files');
    const live = request('/api/projects/owned/files');
    const navigate = vi.fn(async () => {
      const document = documentRequest();
      page.emit('request', document);
      page.emit('response', response(document));
      page.emit('request', discarded);
      page.emit('framenavigated', mainFrame);
      page.emit('request', live);
    });
    try {
      page.emit('request', first);
      const navigated = hydration.navigate(navigate, 1_000, 'no-artifact');
      page.emit('response', response(first));
      expect(navigate).not.toHaveBeenCalled();
      page.emit('requestfinished', first);
      await navigated;
      expect(hydration.counts).toMatchObject({ pending: 1, excludedPending: 1, finished: 1, cancelled: 0 });
      expect(hydration.requests[1]).toMatchObject({ url: discarded.url(), resourceType: 'fetch',
        outcome: 'pending', status: null, replacementId: 1,
        exclusion: { reason: expect.any(String), url: 'http://localhost/projects/owned', committedAt: expect.any(String) } });
      const done = vi.fn();
      const drained = hydration.drain(1_000, 'no-artifact').then(done);
      page.emit('response', response(live));
      expect(done).not.toHaveBeenCalled();
      page.emit('requestfinished', live);
      await drained;
      expect(done).toHaveBeenCalledOnce();
      expect(hydration.counts).toMatchObject({ pending: 0, excludedPending: 1, finished: 2 });
    } finally { hydration.dispose(); }
    expect(page.eventNames()).toEqual([]);
  });

  test.each(['before-headers', 'after-commit', 'other-frame', 'raw', 'headers', 'no-counterpart', 'unarmed'] as const)(
    'never excludes a pending %s read', async (kind) => {
      vi.useFakeTimers();
      const { page, hydration, complete } = harness();
      try {
        complete(request(kind === 'no-counterpart' ? '/api/projects/other/files' : '/api/projects/owned/files'));
        const incoming = kind === 'other-frame'
          ? { ...request('/api/projects/owned/files'), frame: () => ({}) as Frame } as Request
          : request(kind === 'raw' ? undefined : '/api/projects/owned/files');
        const trigger = async () => {
          const document = documentRequest();
          page.emit('request', document);
          if (kind === 'before-headers') page.emit('request', incoming);
          page.emit('response', response(document));
          if (!['before-headers', 'after-commit'].includes(kind)) page.emit('request', incoming);
          if (kind === 'headers') page.emit('response', response(incoming));
          page.emit('framenavigated', mainFrame);
          if (kind === 'after-commit') page.emit('request', incoming);
        };
        if (kind === 'unarmed') await trigger();
        else await hydration.navigate(trigger);
        const rejected = expect(hydration.drain(10)).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(10);
        await rejected;
        expect(hydration.counts).toMatchObject({ pending: 1, excludedPending: 0 });
      } finally { hydration.dispose(); vi.useRealTimers(); }
    },
  );

  test.each(['http', 'transport', 'late-headers'] as const)('late %s revokes a discarded-document exclusion', async (kind) => {
    const { page, hydration, complete } = harness();
    const incoming = request('/api/projects/owned/files', 'net::ERR_CONNECTION_RESET');
    try {
      complete(request('/api/projects/owned/files'));
      await hydration.navigate(async () => {
        const document = documentRequest();
        page.emit('request', document);
        page.emit('response', response(document));
        page.emit('request', incoming);
        page.emit('framenavigated', mainFrame);
      });
      expect(hydration.counts.excludedPending).toBe(1);
      if (kind === 'transport') page.emit('requestfailed', incoming);
      else page.emit('response', response(incoming, kind === 'http' ? 500 : 200));
      expect(hydration.counts.excludedPending).toBe(0);
      if (kind !== 'transport') page.emit('requestfinished', incoming);
      if (kind === 'late-headers') await hydration.drain();
      else await expect(hydration.drain()).rejects.toBeInstanceOf(AggregateError);
    } finally { hydration.dispose(); }
  });

  test.each(['no-commit', 'http', 'trigger'] as const)('failed navigation cannot discard reads: %s', async (kind) => {
    const { page, hydration, complete } = harness();
    try {
      complete(request('/api/projects/owned/files'));
      await expect(hydration.navigate(async () => {
        const document = documentRequest();
        page.emit('request', document);
        page.emit('response', response(document, kind === 'http' ? 500 : 200));
        page.emit('request', request('/api/projects/owned/files'));
        if (kind !== 'no-commit') page.emit('framenavigated', mainFrame);
        if (kind === 'trigger') throw new Error('navigation failed');
      })).rejects.toBeInstanceOf(Error);
      expect(hydration.counts).toMatchObject({ pending: 1, excludedPending: 0 });
    } finally { hydration.dispose(); }
  });
});

describe('completed raw body consumer', () => {
  test.each([
    ['/api/projects/owned/raw/artifact.html', 'artifact.html'],
    ['/api/projects/owned/raw/nested/artifact.html?cacheBust=1', 'nested/artifact.html'],
    ['/api/projects/owned%20project/raw/nested/files/artifact%20%23%3F%25.html?v=1', 'nested/files/artifact #?%.html'],
  ] as const)('subscribes before triggering and reads only the completed body: %s', async (path, name) => {
    const page = new EventEmitter();
    const bodyEvents = new EventEmitter();
    const bodyStarted = once(bodyEvents, 'started', { signal: AbortSignal.timeout(5_000) });
    let finish!: (text: string) => void;
    const body = new Promise<string>((resolve) => { finish = resolve; });
    const incoming = request(path);
    const raw = { ...response(incoming), text: vi.fn(() => { bodyEvents.emit('started'); return body; }) } as unknown as Response;
    incoming.response = async () => raw;
    const result = readHydratedProjectFile(page as unknown as Page, name, async () => {
      expect(page.listenerCount('requestfinished')).toBe(1);
      page.emit('response', raw);
      expect(raw.text).not.toHaveBeenCalled();
      // None of these is the matching raw GET.
      for (const other of [request('/api/projects/owned/files'), request('/api/projects/owned/raw/other.html'), request(path, null, 'POST')]) {
        page.emit('requestfinished', other);
      }
      const cancelled = request(path);
      page.emit('requestfailed', cancelled);
      page.emit('requestfinished', incoming);
    });
    await Promise.race([bodyStarted, result]);
    finish('<h1>artifact</h1>');
    await expect(result).resolves.toBe('<h1>artifact</h1>');
    expect(page.eventNames()).toEqual([]);
  });

  test.each(['http', 'transport', 'body', 'trigger'] as const)('propagates %s failures and disposes', async (kind) => {
    const page = new EventEmitter();
    const incoming = request(undefined, 'net::ERR_CONNECTION_RESET');
    const raw = { ...response(incoming, kind === 'http' ? 503 : 200), text: async () => { throw new Error('body failed'); } } as Response;
    incoming.response = async () => raw;
    await expect(readHydratedProjectFile(page as unknown as Page, 'artifact.html', async () => {
      if (kind === 'http') page.emit('response', raw);
      if (kind === 'transport') page.emit('requestfailed', incoming);
      if (kind === 'body') page.emit('requestfinished', incoming);
      if (kind === 'trigger') throw new Error('trigger failed');
    })).rejects.toBeInstanceOf(Error);
    expect(page.eventNames()).toEqual([]);
  });
});
