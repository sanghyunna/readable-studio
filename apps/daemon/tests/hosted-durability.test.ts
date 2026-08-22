import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHostedDurabilityCoordinator,
  HostedDurabilityError,
  type HostedDurabilityClock,
} from '../src/hosted-durability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeClock(delays: number[] = []): HostedDurabilityClock {
  return {
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    now: Date.now,
    setTimer(callback, delayMs) {
      delays.push(delayMs);
      return setTimeout(callback, delayMs);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('hosted durability coordinator', () => {
  it('publishes the completed mutation before acknowledging its result', async () => {
    const publication = deferred<void>();
    const events: string[] = [];
    const coordinator = createHostedDurabilityCoordinator({
      poison: vi.fn(),
      publish: async (signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        events.push('publish');
        await publication.promise;
      },
      requestIdleFlush: vi.fn(),
    });

    const result = coordinator.mutate(() => {
      events.push('mutate');
      return 'saved';
    }).then((value) => {
      events.push('ack');
      return value;
    });
    await vi.waitFor(() => expect(events).toEqual(['mutate', 'publish']));
    expect(coordinator.dirty).toBe(true);

    publication.resolve();
    await expect(result).resolves.toBe('saved');
    expect(events).toEqual(['mutate', 'publish', 'ack']);
    expect(coordinator.dirty).toBe(false);
  });

  it('retries at one and four seconds, with at most three attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attemptTimes: number[] = [];
    const poison = vi.fn();
    const coordinator = createHostedDurabilityCoordinator({
      clock: fakeClock(),
      poison,
      publish: vi.fn(async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length < 3) throw new Error('disk unavailable');
      }),
      requestIdleFlush: vi.fn(),
    });

    const result = coordinator.mutate(() => 7);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toBe(7);
    expect(attemptTimes).toEqual([0, 1_000, 5_000]);
    expect(poison).not.toHaveBeenCalled();
  });

  it('poisons with a typed publication failure after the third failed attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const poison = vi.fn();
    const publish = vi.fn(async () => { throw new Error('ENOSPC'); });
    const coordinator = createHostedDurabilityCoordinator({
      clock: fakeClock(),
      poison,
      publish,
      requestIdleFlush: vi.fn(),
    });

    const result = coordinator.mutate(() => 'not-acknowledged');
    const rejection = expect(result).rejects.toMatchObject({
      code: 'HOSTED_SNAPSHOT_PUBLICATION_FAILED',
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(publish).toHaveBeenCalledTimes(3);
    expect(poison).toHaveBeenCalledTimes(1);
    expect(coordinator.dirty).toBe(true);
    expect(coordinator.poisoned).toBe(true);
  });

  it('awaits aborted publisher cleanup and prevents a later authority advance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const poison = vi.fn();
    let authorityAdvanced = false;
    const publish = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      const authorityTimer = setTimeout(() => {
        authorityAdvanced = true;
      }, 120_001);
      signal.addEventListener('abort', () => {
        clearTimeout(authorityTimer);
        setTimeout(() => reject(signal.reason), 50);
      }, { once: true });
    }));
    const coordinator = createHostedDurabilityCoordinator({
      clock: fakeClock(),
      poison,
      publish,
      requestIdleFlush: vi.fn(),
    });

    const result = coordinator.mutate(() => undefined);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'HOSTED_SNAPSHOT_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish.mock.calls[0]?.[0].aborted).toBe(true);
    expect(poison).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(poison).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(poison).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(authorityAdvanced).toBe(false);
  });

  it('rejects overlapping use instead of creating a second same-user lane', async () => {
    const publication = deferred<void>();
    const coordinator = createHostedDurabilityCoordinator({
      poison: vi.fn(),
      publish: () => publication.promise,
      requestIdleFlush: vi.fn(),
    });
    const first = coordinator.mutate(() => 'first');

    await expect(coordinator.mutate(() => 'second')).rejects.toMatchObject({
      code: 'HOSTED_DURABILITY_LANE_VIOLATION',
    });
    publication.resolve();
    await expect(first).resolves.toBe('first');
  });

  it('requests an in-lane flush after thirty dirty idle seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publish = vi.fn(async () => undefined);
    const requestIdleFlush = vi.fn(async (flush: () => Promise<void>) => flush());
    const coordinator = createHostedDurabilityCoordinator({
      clock: fakeClock(),
      poison: vi.fn(),
      publish,
      requestIdleFlush,
    });

    coordinator.markDirty();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requestIdleFlush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(requestIdleFlush).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(coordinator.dirty).toBe(false);
  });

  it('unrefs the idle timer so clean daemon exit is not held open', () => {
    const unref = vi.fn();
    const coordinator = createHostedDurabilityCoordinator({
      clock: {
        clearTimer: vi.fn(),
        now: () => 0,
        setTimer: vi.fn(() => ({ unref })),
      },
      poison: vi.fn(),
      publish: vi.fn(async () => undefined),
      requestIdleFlush: vi.fn(),
    });

    coordinator.markDirty();

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('final-flushes dirty state and cancels the idle trigger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publish = vi.fn(async () => undefined);
    const requestIdleFlush = vi.fn();
    const coordinator = createHostedDurabilityCoordinator({
      clock: fakeClock(),
      poison: vi.fn(),
      publish,
      requestIdleFlush,
    });

    coordinator.markDirty();
    await coordinator.finalFlush();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(requestIdleFlush).not.toHaveBeenCalled();
    expect(coordinator.dirty).toBe(false);
    expect(() => coordinator.markDirty()).toThrow(HostedDurabilityError);
  });
});
