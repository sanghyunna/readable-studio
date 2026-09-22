import { afterEach, expect, it, vi } from 'vitest';
import { startStartupScan } from '../../src/runtimes/detection-scan.js';
import { minimalAgentDef } from './helpers/test-helpers.js';
import type { DetectedAgent } from '../../src/runtimes/types.js';

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), availableParallelism: () => 4 }));

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const defs = ['first', 'second', 'third'].map((id) => minimalAgentDef({ id, bin: id }));
const result: DetectedAgent = { id: 'first', name: 'first', bin: 'first', versionArgs: [], streamFormat: 'plain', available: false, models: [], modelsSource: 'live' };
afterEach(() => vi.restoreAllMocks());

it('starts up to the machine bound and reports monotonic progress on out-of-order completion', async () => {
  // Given three held probes on a four-CPU machine (two workers).
  const held = defs.map(() => deferred<DetectedAgent>());
  const thirdStarted = deferred<void>();
  const probe = vi.fn((def) => {
    const index = defs.findIndex((candidate) => candidate.id === def.id);
    if (index === 2) thirdStarted.resolve();
    const pending = held[index];
    if (!pending) throw new Error('unknown fixture');
    return pending.promise;
  });
  // When the second probe finishes before the first.
  const session = startStartupScan(defs, probe);
  const completion = Promise.all([...session.promises.values()]);
  try {
    expect(probe).toHaveBeenCalledTimes(2);
    held[1]?.resolve({ ...result, id: 'second' });
    await thirdStarted.promise;
    // Then only the free worker advances, with a stable oldest-active label.
    expect(probe).toHaveBeenCalledTimes(3);
    expect(session.progress).toMatchObject({ completed: 1, total: 3, currentAgentId: 'first' });
  } finally {
    held.forEach((pending) => pending.resolve(result));
    await completion;
  }
  expect(session.progress).toEqual({ phase: 'done', currentAgentId: null, currentAgentName: null, completed: 3, total: 3 });
});

it('settles queued consumers without launching them when cancelled', async () => {
  // Given held work occupying both scheduler slots.
  const controller = new AbortController();
  const held = deferred<DetectedAgent>();
  const probe = vi.fn(() => held.promise);
  const session = startStartupScan(defs, probe, controller.signal);
  const completion = Promise.allSettled([...session.promises.values()]);
  // When the owner cancels scheduling (subprocess coverage lives in detection-cancellation).
  controller.abort();
  const settled = await completion;
  held.resolve(result);
  // Then queued work never starts and all consumers settle.
  expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected', 'rejected']);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(session.progress).toMatchObject({ phase: 'cancelled', completed: 0, total: 3, currentAgentId: null });
});

it('settles consumers without starting probes when already aborted', async () => {
  // Given an already cancelled owner.
  const controller = new AbortController(); controller.abort();
  const probe = vi.fn(async () => result);
  // When the session starts.
  const session = startStartupScan(defs, probe, controller.signal);
  const settled = await Promise.allSettled([...session.promises.values()]);
  // Then every queued consumer rejects without work.
  expect(settled.every((entry) => entry.status === 'rejected')).toBe(true);
  expect(probe).not.toHaveBeenCalled();
});

it('publishes a terminal error and does not launch queued work when a probe rejects', async () => {
  // Given a failing probe boundary.
  const probe = vi.fn(async () => { throw new Error('fixture failure'); });
  // When the session runs.
  const session = startStartupScan(defs, probe);
  const settled = await Promise.allSettled([...session.promises.values()]);
  // Then active and queued consumers settle without starting the third probe.
  expect(session.progress).toMatchObject({ phase: 'failed', completed: 0, total: 3 });
  expect(settled.every((entry) => entry.status === 'rejected')).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});
