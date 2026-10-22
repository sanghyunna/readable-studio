import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: spawnMock,
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true }));
import { probeIsolatedAgentSupport, spawnIsolatedAgent } from '../src/isolated-process.js';

const originalPlatform = process.platform;
const capabilities = { appContainer: true, filesystemAcl: true, internetClient: true, killOnJobClose: true, loopbackDenied: true };
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    control: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn(), stdio: [] as PassThrough[],
  });
  process.stdio = [process.stdin, process.stdout, process.stderr, process.control];
  process.kill.mockImplementation(() => { process.exitCode = 1; process.emit('exit', 1); process.emit('close', 1); });
  return process;
}
afterEach(() => {
  vi.useRealTimers(); spawnMock.mockReset();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});
it('allows a slow capability probe to finish after the old 15-second limit', async () => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  const probe = child(); spawnMock.mockReturnValue(probe);
  const result = probeIsolatedAgentSupport({ helperPath: String.raw`C:\protected\helper.exe` });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(probe.kill).not.toHaveBeenCalled();
  probe.stdout.write(JSON.stringify({ supported: true, capabilities })); probe.emit('exit', 0); probe.emit('close', 0);
  await expect(result).resolves.toEqual({ supported: true, capabilities });
});
it('waits for slow ACL preparation before returning the isolated child', async () => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  const probe = child(); const launched = child();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const selected = args[0] === '--probe' ? probe : launched;
    queueMicrotask(() => {
      if (selected === probe) {
        probe.stdout.write(JSON.stringify({ supported: true, capabilities })); probe.emit('exit', 0); probe.emit('close', 0);
      } else launched.emit('spawn');
    });
    return selected;
  });
  const result = spawnIsolatedAgent({ command: String.raw`C:\bin\agent.exe`, cwd: String.raw`C:\project`,
    helperPath: String.raw`C:\protected\helper.exe`, readExecutePaths: [], writablePaths: [String.raw`C:\project`] });
  const observed = result.then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(121_000);
  expect(launched.kill).not.toHaveBeenCalled();
  launched.control.write(`${JSON.stringify({ status: 'ready', profileName: 'test' })}\n`);
  expect(await observed).toEqual({ value: launched });
});
it('does not start a probe or helper for an already canceled run', async () => {
  const controller = new AbortController(); controller.abort(new Error('canceled'));
  await expect(probeIsolatedAgentSupport({ signal: controller.signal })).rejects.toThrow('canceled');
  await expect(spawnIsolatedAgent({ command: 'agent', cwd: String.raw`C:\project`,
    readExecutePaths: [], writablePaths: [], signal: controller.signal })).rejects.toThrow('canceled');
  expect(spawnMock).not.toHaveBeenCalled();
});
it('owns canceled probe cleanup and does not launch an agent after a late successful probe', async () => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  const probe = child(); spawnMock.mockReturnValue(probe);
  const controller = new AbortController();
  const result = spawnIsolatedAgent({ command: String.raw`C:\bin\agent.exe`, cwd: String.raw`C:\project`,
    helperPath: String.raw`C:\protected\helper.exe`, readExecutePaths: [], writablePaths: [], signal: controller.signal })
    .catch(error => error);
  controller.abort(new Error('canceled'));
  await vi.advanceTimersByTimeAsync(31_000);
  expect(probe.kill).not.toHaveBeenCalled();
  probe.stdout.write(JSON.stringify({ supported: true, capabilities })); probe.emit('close', 0);
  expect(await result).toEqual(new Error('canceled'));
  expect(spawnMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])('owns readiness cancellation until helper close and ignores late ready (forced=%s)', async forced => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  const probe = child(); const launched = child();
  const writeControl = vi.spyOn(launched.control, 'write');
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const selected = args[0] === '--probe' ? probe : launched;
    queueMicrotask(() => {
      if (selected === probe) {
        probe.stdout.write(JSON.stringify({ supported: true, capabilities })); probe.emit('close', 0);
      } else launched.emit('spawn');
    });
    return selected;
  });
  const controller = new AbortController(); let settled = false;
  const result = spawnIsolatedAgent({ command: String.raw`C:\bin\agent.exe`, cwd: String.raw`C:\project`,
    helperPath: String.raw`C:\protected\helper.exe`, readExecutePaths: [], writablePaths: [],
    broker: { pipeName: String.raw`\\.\pipe\LOCAL\ReadableStudio.test`, handleRequest: async () => '' },
    signal: controller.signal }).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error('canceled'));
  await vi.advanceTimersByTimeAsync(0);
  expect(launched.stdin.writableEnded).toBe(true);
  expect(launched.control.writableEnded).toBe(true);
  expect(settled).toBe(false);
  launched.control.emit('data', `${JSON.stringify({ status: 'ready', profileName: 'late' })}\n`);
  expect(writeControl).not.toHaveBeenCalled();
  if (forced) await vi.advanceTimersByTimeAsync(180_000);
  else { launched.exitCode = 0; launched.emit('close', 0); }
  expect(await result).toEqual(new Error('canceled'));
  expect(launched.kill).toHaveBeenCalledTimes(forced ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});
