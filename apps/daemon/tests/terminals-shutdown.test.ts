import { afterEach, expect, it, vi } from 'vitest';
import { createTerminalService } from '../src/terminals.js';

const child = vi.hoisted(() => ({ exited: (_event: { exitCode: number }) => {}, immediate: false }));
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({
  pid: 1, onData: vi.fn(), onExit: (listener: typeof child.exited) => { child.exited = listener; },
  kill: () => { if (child.immediate) child.exited({ exitCode: 0 }); },
})) }));

afterEach(() => { vi.useRealTimers(); child.immediate = false; });

it('honors a longer child shutdown grace instead of truncating it at one second', async () => {
  vi.useFakeTimers();
  const service = createTerminalService();
  await service.create({ cwd: process.cwd() });
  let stopped = false;
  const pending = service.shutdownActive().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  await pending;
  expect(stopped).toBe(true);
});

it('returns immediately when the terminal exits without consuming the whole grace', async () => {
  vi.useFakeTimers();
  child.immediate = true;
  const service = createTerminalService();
  await service.create({ cwd: process.cwd() });
  await service.shutdownActive();
  expect(vi.getTimerCount()).toBe(1); // Only the existing exited-session cache cleanup remains.
});
