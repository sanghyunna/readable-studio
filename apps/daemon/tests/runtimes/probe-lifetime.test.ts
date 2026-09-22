import { ChildProcess, spawn } from 'node:child_process';
import * as childProcesses from 'node:child_process';
import { cachedSafeProbe, _resetAgentDetectionCacheForTests } from '../../src/runtimes/detection-cache.js';
import { piAgentDef } from '../../src/runtimes/defs/pi.js';
import { afterEach, expect, test, vi } from 'vitest';
import { withProbeLifetime } from '../../src/runtimes/probe-lifetime.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: vi.fn(),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); _resetAgentDetectionCacheForTests(); });

test.each(['unstarted', 'missing-close', 'pending-probe'] as const)('settles at its deadline with %s lifecycle', async (behavior) => {
  // Given an owned child whose lifecycle cannot complete normally.
  vi.useFakeTimers();
  const controller = new AbortController();
  let outcome: unknown = 'pending';
  const result = withProbeLifetime(controller.signal, async () => {
    const child = new ChildProcess();
    if (behavior === 'missing-close') {
      child.emit('spawn');
      child.emit('exit', 0, null);
    }
    if (behavior === 'pending-probe') return new Promise<void>(() => {});
  });
  void result.then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
  const reason = new DOMException('Probe deadline', 'TimeoutError');
  setTimeout(() => controller.abort(reason), 100);
  // When the actual deadline fires, without any child close event.
  await vi.advanceTimersByTimeAsync(100);
  // Then settlement is independent of the child or adapter cooperating.
  expect(outcome).toBe(behavior === 'unstarted' ? 'resolved' : reason);
});

test.each(['ENOENT', 'EACCES'])('settles when spawn reports %s without close', async (code) => {
  // Given an OS spawn failure whose close event is absent.
  const failure = Object.assign(new Error('spawn failed'), { code });
  // When the child reports only its error.
  const result = withProbeLifetime(new AbortController().signal, () => new Promise<void>((_resolve, reject) => {
    const child = new ChildProcess();
    child.once('error', reject);
    child.emit('error', failure);
  }));
  // Then no lifecycle join masks the failure.
  await expect(result).rejects.toBe(failure);
});

test('settles on abort even when the tree-kill callback never arrives', async () => {
  // Given a started child and an unresponsive OS cleanup command.
  vi.useFakeTimers();
  vi.spyOn(childProcesses, 'execFile').mockImplementation(() => new ChildProcess());
  const controller = new AbortController();
  let outcome: unknown = 'pending';
  const result = withProbeLifetime(controller.signal, async () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 123 });
    vi.spyOn(child, 'kill').mockReturnValue(true);
    child.emit('spawn');
  });
  void result.catch((error: unknown) => { outcome = error; });
  // When the deadline aborts while the child never closes.
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  // Then the cleanup callback cannot keep the probe pending.
  expect(outcome).toBe(controller.signal.reason);
});

test.each([false, true])('bounds cached probes without cooperative cancellation (owner=%s)', async (owned) => {
  // Given an adapter that never returns, with or without an external owner.
  vi.useFakeTimers();
  let outcome: unknown = 'pending';
  const options = owned ? { signal: new AbortController().signal } : {};
  const result = cachedSafeProbe(() => new Promise(() => {}), piAgentDef, {}, options);
  void result.catch((error: unknown) => { outcome = error; });
  // When the probe's own budget expires.
  await vi.advanceTimersByTimeAsync(60_000);
  // Then it rejects even without an owner-provided deadline.
  expect(outcome).toMatchObject({ name: 'TimeoutError' });
});

test('settles a real failed spawn without waiting for its deadline', async () => {
  // Given a real missing executable rather than a mocked promise.
  const controller = new AbortController();
  // When Node reports a spawn error.
  const result = withProbeLifetime(controller.signal, () => new Promise<void>((resolve, reject) => {
    const child = spawn(`missing-probe-${process.pid}`, []);
    child.once('error', reject);
    child.once('close', () => resolve());
  }));
  // Then the spawn failure remains observable.
  await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
});
