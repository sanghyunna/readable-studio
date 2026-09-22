// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDesignMdState } from '../../src/hooks/useDesignMdState';
import { deferred } from '../helpers/deferred';

const design = '## Provenance\n- Generated UTC timestamp: 2026-05-08T12:00:00Z\n';
const files = { files: [{ name: 'DESIGN.md', size: 1, mtime: 1, kind: 'text', mime: 'text/markdown' }] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('starts conversations alongside files when the design body is still pending', async () => {
  // Given: both the file listing and design body are independently held open.
  const listing = deferred<Response>();
  const body = deferred<Response>();
  const bodyStarted = deferred<void>();
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/files')) return listing.promise;
    if (url.endsWith('/conversations')) return Response.json({ conversations: [] });
    if (url.endsWith('/files/DESIGN.md')) { bodyStarted.resolve(); return body.promise; }
    throw new Error(`Unexpected URL: ${url}`);
  });

  // When: opening a project, then releasing only its listing.
  const { result } = renderHook(() => useDesignMdState('parallel'));
  const initialRequests = [...requests];
  await act(async () => {
    listing.resolve(Response.json(files));
    await bodyStarted.promise;
  });
  const requestsWhileBodyPending = [...requests];
  const loadingWhileBodyPending = result.current.loading;
  await act(async () => { body.resolve(new Response(design)); });

  // Then: three requests use two dependency rounds, not three serial rounds.
  expect(initialRequests).toEqual([
    '/api/projects/parallel/files', '/api/projects/parallel/conversations',
  ]);
  expect(requestsWhileBodyPending).toEqual([
    ...initialRequests, '/api/projects/parallel/files/DESIGN.md',
  ]);
  expect(requests).toHaveLength(3);
  expect(loadingWhileBodyPending).toBe(true);
  expect(result.current).toMatchObject({ exists: true, loading: false, error: null, isStale: false });
});

it.each(['design body', 'conversations body', 'conversations rejection'] as const)(
  'keeps the current project state when the previous project finishes its %s', async (stage) => {
    // Given: the previous project is paused at a known request/body boundary.
    const paused = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/projects/current/')) return Response.json({ files: [], conversations: [] });
      if (url.endsWith('/files')) return Response.json(files);
      if (url.endsWith('/conversations')) {
        if (stage === 'conversations rejection') {
          paused.resolve();
          await release.promise;
          throw new Error('previous project offline');
        }
        const response = Response.json({ conversations: [] });
        if (stage === 'conversations body') vi.spyOn(response, 'json').mockImplementation(async () => {
          paused.resolve();
          await release.promise;
          return { conversations: [] };
        });
        return response;
      }
      const response = new Response(design);
      if (stage === 'design body') vi.spyOn(response, 'text').mockImplementation(async () => {
        paused.resolve();
        await release.promise;
        return design;
      });
      return response;
    });
    const { result, rerender } = renderHook(({ id }) => useDesignMdState(id), {
      initialProps: { id: 'previous' },
    });
    await act(async () => { await paused.promise; });

    // When: switching to a project without DESIGN.md before the old work finishes.
    rerender({ id: 'current' });
    await act(async () => { await result.current.refresh(); });
    const current = result.current;
    await act(async () => { release.resolve(); });

    // Then: even a transport ignoring abort cannot publish the previous design/error.
    expect(current).toMatchObject({ exists: false, loading: false, error: null });
    expect(result.current).toMatchObject({ exists: false, loading: false, error: null });
  },
);
