// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackMessagePersist } from '../../src/components/ProjectView';
import type { SaveMessageResult } from '../../src/state/projects';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ProjectView message persistence tracking', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  async function settle(pending: Set<Promise<unknown>>) {
    await Promise.all(Array.from(pending));
    // Let the cleanup continuation and any unhandled-rejection dispatch run.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('tracks a successful save until it settles and reports nothing', async () => {
    const pending = new Set<Promise<unknown>>();
    const onFailure = vi.fn();
    const save = deferred<SaveMessageResult>();
    trackMessagePersist(pending, save.promise, onFailure);
    expect(pending.size).toBe(1);
    save.resolve({ ok: true });
    await settle(pending);
    expect(pending.size).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it.each([
    ['HTTP failure', { ok: false, status: 500 } as SaveMessageResult],
    ['network failure', { ok: false, status: null } as SaveMessageResult],
  ])('reports a foreground %s once and empties tracking', async (_label, result) => {
    const pending = new Set<Promise<unknown>>();
    const onFailure = vi.fn();
    const save = deferred<SaveMessageResult>();
    trackMessagePersist(pending, save.promise, onFailure);
    save.resolve(result);
    await settle(pending);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(result);
    expect(pending.size).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('handles a rejecting save without an unhandled rejection', async () => {
    const pending = new Set<Promise<unknown>>();
    const onFailure = vi.fn();
    const save = deferred<SaveMessageResult>();
    trackMessagePersist(pending, save.promise, onFailure);
    save.reject(new TypeError('connection refused'));
    await settle(pending);
    expect(onFailure).toHaveBeenCalledWith({ ok: false, status: null });
    expect(pending.size).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('keeps keepalive failures quiet in the foreground', async () => {
    const pending = new Set<Promise<unknown>>();
    const onFailure = vi.fn();
    const failed = deferred<SaveMessageResult>();
    const rejected = deferred<SaveMessageResult>();
    trackMessagePersist(pending, failed.promise, onFailure, { keepalive: true });
    trackMessagePersist(pending, rejected.promise, onFailure, { keepalive: true });
    failed.resolve({ ok: false, status: 503 });
    rejected.reject(new TypeError('unload'));
    await settle(pending);
    expect(onFailure).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('ignores a missing save promise', () => {
    const pending = new Set<Promise<unknown>>();
    trackMessagePersist(pending, undefined, vi.fn());
    expect(pending.size).toBe(0);
  });
});
