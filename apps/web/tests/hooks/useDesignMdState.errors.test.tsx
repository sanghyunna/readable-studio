// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDesignMdState } from '../../src/hooks/useDesignMdState';
import { deferred } from '../helpers/deferred';

const design = '## Provenance\n- Generated UTC timestamp: 2026-05-08T12:00:00Z\n';
const files = { files: [{ name: 'DESIGN.md', size: 1, mtime: 1, kind: 'text', mime: 'text/markdown' }] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  { name: 'files transport', endpoint: '/files', response: () => Promise.reject(new TypeError('files offline')), error: 'files offline' },
  { name: 'files HTTP', endpoint: '/files', response: async () => new Response('', { status: 503 }), error: 'GET files → HTTP 503' },
  { name: 'files JSON', endpoint: '/files', response: async () => new Response('{'), error: SyntaxError },
  { name: 'design transport', endpoint: '/files/DESIGN.md', response: () => Promise.reject(new TypeError('design offline')), error: 'design offline' },
  { name: 'design HTTP', endpoint: '/files/DESIGN.md', response: async () => new Response('', { status: 503 }), error: 'GET DESIGN.md → HTTP 503' },
  { name: 'design body', endpoint: '/files/DESIGN.md', response: async () => {
    const response = new Response(design);
    vi.spyOn(response, 'text').mockRejectedValue(new TypeError('body failed'));
    return response;
  }, error: 'body failed' },
])('preserves the earlier error when $name and conversations both fail', async ({ endpoint, response, error }) => {
  // Given: conversations rejects immediately, before the dependent chain finishes.
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/conversations')) throw new Error('conversations offline');
    if (url.endsWith(endpoint)) return response();
    if (url.endsWith('/files')) return Response.json(files);
    return new Response(design);
  });
  const { result } = renderHook(() => useDesignMdState('precedence'));

  // When: explicitly refreshing through the hook's public completion promise.
  await act(async () => { await result.current.refresh(); });

  // Then: the original files/design failure wins, with no unhandled rejection.
  if (typeof error === 'string') expect(result.current.error?.message).toBe(error);
  else expect(result.current.error).toBeInstanceOf(error);
  expect(result.current.loading).toBe(false);
  if (endpoint === '/files') expect(requests.some(url => url.endsWith('/files/DESIGN.md'))).toBe(false);
});

it.each(['early', 'late'] as const)('ignores an irrelevant conversations rejection when DESIGN.md is absent (%s)', async (timing) => {
  // Given: a project without DESIGN.md and a rejecting speculative request.
  const rejection = deferred<void>();
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/conversations')) {
      await rejection.promise;
      throw new Error('conversations offline');
    }
    return Response.json({ files: [] });
  });
  const { result } = renderHook(() => useDesignMdState('missing'));

  // When: the missing-file path finishes without waiting for conversations.
  await act(async () => {
    if (timing === 'early') rejection.resolve();
    await result.current.refresh();
  });
  const settled = result.current;
  await act(async () => { rejection.resolve(); });

  // Then: no error, no body request, and late rejection cannot change the result.
  expect(settled).toMatchObject({ exists: false, loading: false, error: null });
  expect(result.current).toMatchObject({ exists: false, loading: false, error: null });
  expect(requests.filter(url => url.endsWith('/files/DESIGN.md'))).toHaveLength(0);
});

it.each([
  { name: 'transport', response: () => Promise.reject(new TypeError('conversations offline')), error: TypeError },
  { name: 'non-Error rejection', response: () => Promise.reject('offline'), error: Error },
  { name: 'JSON', response: async () => new Response('{'), error: SyntaxError },
])('surfaces the conversations error when its $name fails after a valid design', async ({ response, error }) => {
  // Given: the design chain succeeds, so conversations errors are relevant.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/conversations')) return response();
    if (url.endsWith('/files')) return Response.json(files);
    return new Response(design);
  });
  const { result } = renderHook(() => useDesignMdState('conversations-error'));

  // When: refreshing the complete state.
  await act(async () => { await result.current.refresh(); });

  // Then: rejection/parse failures still reach the hook's error state.
  expect(result.current.error).toBeInstanceOf(error);
  expect(result.current.loading).toBe(false);
});

it('keeps the empty-conversations fallback when their HTTP response is unsuccessful', async () => {
  // Given: non-OK conversations with an invalid body must not be parsed.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/conversations')) return new Response('{', { status: 503 });
    if (url.endsWith('/files')) return Response.json(files);
    return new Response(design);
  });
  const { result } = renderHook(() => useDesignMdState('http-fallback'));

  // When: refreshing the design status.
  await act(async () => { await result.current.refresh(); });

  // Then: the valid design remains fresh rather than surfacing an HTTP error.
  expect(result.current).toMatchObject({ exists: true, loading: false, error: null, isStale: false });
});
