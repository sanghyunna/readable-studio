import { runInNewContext } from 'node:vm';
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { settle } from '../lib/playwright/rail-geometry.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function animation(iterations = 1) {
  const completion = deferred<void>();
  let subscriptions = 0;
  const value = {
    playState: 'running',
    effect: { getComputedTiming: () => ({ iterations }) },
    get finished() { subscriptions++; return completion.promise; },
  };
  return {
    value,
    subscriptions: () => subscriptions,
    finish() { value.playState = 'finished'; completion.resolve(); },
    cancel() { value.playState = 'idle'; completion.reject(new DOMException('Cancelled', 'AbortError')); },
    fail(error: Error) { completion.reject(error); },
  };
}

// Execute the exact serialized page callback without a browser/DOM renderer.
// Frames and animation completion are explicit signals, never elapsed-time waits.
function harness() {
  let frame = deferred<() => void>();
  const timers = new Map<number, () => void>();
  let animations: ReturnType<typeof animation>['value'][] = [];
  const page = {
    async evaluate(callback: (timeout: number) => Promise<void>, timeout: number) {
      return runInNewContext(`(${callback.toString()})(timeout)`, {
        timeout,
        document: { fonts: { ready: Promise.resolve() }, getAnimations: () => animations },
        requestAnimationFrame(callback: () => void) { frame.resolve(callback); return 1; },
        cancelAnimationFrame() {},
        setTimeout(callback: () => void) { timers.set(1, callback); return 1; },
        clearTimeout(id: number) { timers.delete(id); },
      });
    },
  } as unknown as Page;
  return {
    page, timers,
    setAnimations(...values: ReturnType<typeof animation>[]) { animations = values.map((item) => item.value); },
    async paint() {
      const callback = await frame.promise;
      frame = deferred<() => void>();
      callback();
    },
  };
}

test('settle awaits a finite animation and the rendered frame after completion', async () => {
  const h = harness(), active = animation();
  h.setAnimations(active);
  const done = settle(h.page);
  await h.paint();
  expect(active.subscriptions()).toBe(1);
  active.finish();
  await h.paint();
  await done;
  expect(h.timers.size).toBe(0);
});

test('settle follows a cancelled transition into its replacement, not its rejected finished promise', async () => {
  const h = harness(), original = animation(), replacement = animation();
  h.setAnimations(original);
  const done = settle(h.page);
  await h.paint();
  h.setAnimations(replacement);
  original.cancel();
  await h.paint();
  expect(replacement.subscriptions()).toBe(1);
  expect(h.timers.size).toBe(1);
  replacement.finish();
  await h.paint();
  await done;
  expect(h.timers.size).toBe(0);
});

test('settle accepts a cancelled transition with no remaining animation', async () => {
  const h = harness(), active = animation();
  h.setAnimations(active);
  const done = settle(h.page);
  await h.paint();
  h.setAnimations();
  active.cancel();
  await h.paint();
  await done;
});

test('settle ignores infinite decorative animations', async () => {
  const h = harness(), infinite = animation(Infinity);
  h.setAnimations(infinite);
  const done = settle(h.page);
  await h.paint();
  await done;
  expect(infinite.subscriptions()).toBe(0);
});

for (const error of [new Error('Unexpected animation failure'), new DOMException('Still running', 'AbortError')]) {
  test(`settle propagates ${error.name} without cancellation state evidence`, async () => {
    const h = harness(), active = animation();
    h.setAnimations(active);
    const rejected = expect(settle(h.page)).rejects.toBe(error);
    await h.paint();
    active.fail(error);
    await rejected;
    expect(h.timers.size).toBe(0);
  });
}
