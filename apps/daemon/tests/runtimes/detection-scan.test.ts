import { expect, it, vi } from 'vitest';
import * as scans from '../../src/runtimes/detection.js';
import { minimalAgentDef } from './helpers/test-helpers.js';
import type { DetectedAgent } from '../../src/runtimes/types.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  let reject: (error: Error) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const defs = ['first', 'second'].map((id) => minimalAgentDef({ id, bin: id }));
const result: DetectedAgent = { id: 'first', name: 'first', bin: 'first', versionArgs: [], streamFormat: 'plain', available: false, models: [], modelsSource: 'live' };

it('reports each current agent when the first-run session probes sequentially', async () => {
  // Given a first probe held at its completion boundary.
  const first = deferred<DetectedAgent>();
  const secondStarted = deferred<void>();
  const second = deferred<DetectedAgent>();
  const probe = vi.fn((def) => { if (def.id === 'first') return first.promise; secondStarted.resolve(); return second.promise; });
  // When the session starts and both consumers subscribe.
  const session = scans.startStartupScan(defs, probe);
  const completion = Promise.all([...session.promises.values()]);
  expect(session.progress).toMatchObject({ phase: 'running', currentAgentId: 'first', completed: 0, total: 2 });
  expect(probe).toHaveBeenCalledTimes(1);
  first.resolve(result);
  await secondStarted.promise;
  expect(session.progress).toMatchObject({ phase: 'running', currentAgentId: 'second', completed: 1, total: 2 });
  second.resolve({ ...result, id: 'second' });
  await completion;
  // Then the completed session has a terminal state and no current agent.
  expect(session.progress).toEqual({ phase: 'done', currentAgentId: null, currentAgentName: null, completed: 2, total: 2 });
});

it('stops queued probes when a session is cancelled', async () => {
  // Given an active first probe and a queued second probe.
  const pending = deferred<DetectedAgent>();
  const probe = vi.fn(() => pending.promise);
  const controller = new AbortController();
  const session = scans.startStartupScan(defs, probe, controller.signal);
  const completion = Promise.allSettled([...session.promises.values()]);
  // When the session owner cancels it.
  controller.abort();
  await completion;
  pending.resolve(result);
  // Then observers see cancellation, and queued work never starts.
  expect(session.progress).toMatchObject({ phase: 'cancelled', completed: 0, total: 2, currentAgentId: null });
  expect(probe).toHaveBeenCalledTimes(1);
});

it('publishes a terminal error when the probe boundary rejects', async () => {
  // Given an unexpected probe failure.
  const error = new Error('fixture failure');
  const probe = vi.fn(async () => { throw error; });
  // When the session runs.
  const session = scans.startStartupScan(defs, probe);
  const settled = await Promise.allSettled([...session.promises.values()]);
  // Then every subscriber settles and no queued probe starts.
  expect(session.progress).toMatchObject({ phase: 'failed', completed: 0, total: 2 });
  expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
  expect(probe).toHaveBeenCalledTimes(1);
});
