import { EventEmitter, once } from 'node:events';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openSettledSwitcherPopover } from '@/playwright/native-page-zoom';
import { T } from '@/timeouts';

// Execute the actual renderer subscription, not a mock of the settle helper.
// DOM commits and animation completion are independent, explicitly released
// signals; no timer is used except when testing the bounded failure itself.
function harness() {
  const events = new EventEmitter();
  let mutation!: () => void;
  const observe = vi.fn();
  const disconnect = vi.fn();
  let mounted = false;
  const popover = {
    style: { left: '', top: '' }, isConnected: true,
    getAnimations: vi.fn<() => Array<{ finished: Promise<unknown> }>>(() => []),
  };
  class Observer {
    constructor(callback: () => void) { mutation = callback; }
    observe = observe;
    disconnect = disconnect;
  }
  vi.stubGlobal('MutationObserver', Observer);
  vi.stubGlobal('document', { documentElement: {}, querySelector: () => mounted ? popover : null });
  vi.stubGlobal('window', { setTimeout });
  const page = { evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg) } as unknown as Page;
  const opened = once(events, 'opened', { signal: AbortSignal.timeout(5_000) });
  const open = async () => {
    expect(observe).toHaveBeenCalledOnce();
    mounted = true;
    mutation();
    events.emit('opened');
  };
  const position = (left = '100px', top = '200px') => {
    popover.style = { left, top };
    mutation();
  };
  return { page, popover, open, opened, position, disconnect };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native zoom popover own-position/animation barrier', () => {
  test('a mounted visible menu is not ready until its inline placement commits', async () => {
    const value = harness();
    const measured = vi.fn();
    const result = openSettledSwitcherPopover(value.page, 'menu', value.open).then(measured);
    await Promise.race([value.opened, result]);
    expect(value.popover.getAnimations).not.toHaveBeenCalled();
    expect(measured).not.toHaveBeenCalled();
    value.position();
    await result;
    expect(measured).toHaveBeenCalledOnce();
    expect(value.disconnect).toHaveBeenCalledOnce();
  });

  test('waits for the popover animation, not just placement or a document resize', async () => {
    const value = harness();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    value.popover.getAnimations.mockReturnValue([{ finished }]);
    const measured = vi.fn();
    const result = openSettledSwitcherPopover(value.page, 'menu', value.open).then(measured);
    await Promise.race([value.opened, result]);
    value.position();
    expect(value.popover.getAnimations).toHaveBeenCalledOnce();
    expect(measured).not.toHaveBeenCalled();
    finish();
    await result;
    expect(measured).toHaveBeenCalledOnce();
  });

  test('wrong committed coordinates reach geometry assertions without readiness tolerances', async () => {
    const value = harness();
    const result = openSettledSwitcherPopover(value.page, 'menu', value.open);
    await Promise.race([value.opened, result]);
    value.position('-500px', '-500px');
    await result;
    expect(value.popover.style).toEqual({ left: '-500px', top: '-500px' });
  });

  test.each(['cancelled-animation', 'detached'] as const)('fails rather than swallowing %s', async (kind) => {
    const value = harness();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    value.popover.getAnimations.mockReturnValue([{ finished }]);
    const result = openSettledSwitcherPopover(value.page, 'menu', value.open);
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    await value.opened;
    value.position();
    if (kind === 'cancelled-animation') fail(new Error('animation cancelled'));
    else { value.popover.isConnected = false; finish(); }
    await rejected;
    expect(value.disconnect).toHaveBeenCalledOnce();
  });

  test('bounds missing position and disposes its observer', async () => {
    vi.useFakeTimers();
    const value = harness();
    const result = openSettledSwitcherPopover(value.page, 'menu', value.open);
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    await value.opened;
    await vi.advanceTimersByTimeAsync(T.medium);
    await rejected;
    expect(value.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
