// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRuntimeUsername } from '../../src/hooks/useRuntimeUser';

const RETRY_INTERVAL_MS = 5000;

type FetchOutcome =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'malformed-ok' }
  | { readonly kind: 'non-ok' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'deferred-ok'; readonly body: unknown };

type RecordedCall = {
  readonly offsetMs: number;
  readonly signal: AbortSignal;
};

type FetchHarness = {
  readonly calls: RecordedCall[];
  readonly settleDeferred: () => void;
};

function assertNever(value: never): never {
  throw new TypeError(`Unexpected fetch outcome: ${JSON.stringify(value)}`);
}

function installFetch(outcomes: readonly FetchOutcome[]): FetchHarness {
  const calls: RecordedCall[] = [];
  const deferredResolvers: Array<() => void> = [];
  const startedAt = Date.now();

  vi.spyOn(globalThis, 'fetch').mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
    const outcome = outcomes[calls.length] ?? { kind: 'reject' };
    calls.push({ offsetMs: Date.now() - startedAt, signal: init?.signal ?? new AbortController().signal });

    switch (outcome.kind) {
      case 'ok':
        return Promise.resolve(Response.json(outcome.body));
      case 'malformed-ok':
        return Promise.resolve(new Response('not json', { status: 200 }));
      case 'non-ok':
        return Promise.resolve(Response.json({}, { status: 503 }));
      case 'reject':
        return Promise.reject(new TypeError('network unavailable'));
      case 'deferred-ok':
        return new Promise<Response>((resolve) => {
          deferredResolvers.push(() => resolve(Response.json(outcome.body)));
        });
      default:
        return assertNever(outcome);
    }
  });

  return {
    calls,
    settleDeferred: () => {
      for (const resolve of deferredResolvers) resolve();
    },
  };
}

async function advanceBy(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRuntimeUsername', () => {
  it('returns a valid username from the first response with one fetch', async () => {
    // Given
    const { calls } = installFetch([{ kind: 'ok', body: { username: 'winuser' } }]);

    // When
    const { result } = renderHook(() => useRuntimeUsername());
    await advanceBy(25000);

    // Then
    expect(result.current).toBe('winuser');
    expect(calls.map(({ offsetMs }) => offsetMs)).toEqual([0]);
  });

  it('returns a username on the fifth attempt after four rejected fetches', async () => {
    // Given
    const { calls } = installFetch([
      { kind: 'reject' },
      { kind: 'reject' },
      { kind: 'reject' },
      { kind: 'reject' },
      { kind: 'ok', body: { username: 'winuser' } },
    ]);

    // When
    const { result } = renderHook(() => useRuntimeUsername());
    await advanceBy(20000);

    // Then
    expect(result.current).toBe('winuser');
    expect(calls.map(({ offsetMs }) => offsetMs)).toEqual([0, 5000, 10000, 15000, 20000]);
  });

  it('stops forever after five rejected fetches', async () => {
    // Given
    const { calls } = installFetch([{ kind: 'reject' }]);

    // When
    const { result } = renderHook(() => useRuntimeUsername());
    await advanceBy(60000);

    // Then
    expect(result.current).toBeNull();
    expect(calls.map(({ offsetMs }) => offsetMs)).toEqual([0, 5000, 10000, 15000, 20000]);
  });

  it('retries non-OK responses at the same bounded cadence', async () => {
    // Given
    const { calls } = installFetch([
      { kind: 'non-ok' },
      { kind: 'non-ok' },
      { kind: 'ok', body: { username: 'lateuser' } },
    ]);

    // When
    const { result } = renderHook(() => useRuntimeUsername());
    await advanceBy(10000);

    // Then
    expect(result.current).toBe('lateuser');
    expect(calls.map(({ offsetMs }) => offsetMs)).toEqual([0, 5000, 10000]);
  });

  it.each([
    ['a null username', { kind: 'ok', body: { username: null } }],
    ['a missing username', { kind: 'ok', body: {} }],
    ['a non-string username', { kind: 'ok', body: { username: 42 } }],
    ['an empty username', { kind: 'ok', body: { username: '' } }],
    ['malformed JSON', { kind: 'malformed-ok' }],
  ] satisfies ReadonlyArray<readonly [string, FetchOutcome]>)('does not retry an OK response containing %s', async (_case, outcome) => {
    // Given
    const { calls } = installFetch([outcome]);

    // When
    const { result } = renderHook(() => useRuntimeUsername());
    await advanceBy(30000);

    // Then
    expect(result.current).toBeNull();
    expect(calls.map(({ offsetMs }) => offsetMs)).toEqual([0]);
  });

  it('clears a pending retry and aborts its controller on unmount', async () => {
    // Given
    const { calls } = installFetch([{ kind: 'reject' }]);
    const { unmount } = renderHook(() => useRuntimeUsername());
    await advanceBy(0);

    // When
    unmount();
    await advanceBy(60000);

    // Then
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it('aborts an active retry and ignores its response after unmount', async () => {
    // Given
    const harness = installFetch([
      { kind: 'reject' },
      { kind: 'deferred-ok', body: { username: 'ghostuser' } },
    ]);
    const { result, unmount } = renderHook(() => useRuntimeUsername());
    await advanceBy(RETRY_INTERVAL_MS);

    // When
    unmount();
    harness.settleDeferred();
    await advanceBy(60000);

    // Then
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.signal.aborted).toBe(true);
    expect(result.current).toBeNull();
  });
});
