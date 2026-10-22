import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const { execAsync } = vi.hoisted(() => ({ execAsync: vi.fn() }));
vi.mock('node:child_process', async original => {
  const { promisify } = await import('node:util');
  return { ...await original<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execAsync }) };
});
import { listWindowsExecutableProcesses, stopProcessesInsideRoot } from '../src/process-images.js';

const originalPlatform = process.platform;
afterEach(() => {
  vi.useRealTimers(); execAsync.mockReset();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});
function respondAfter(delayMs: number, stdout = '[]') {
  execAsync.mockImplementation((_command: string, _args: string[], options: { timeout: number }) =>
    new Promise<{ stdout: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PowerShell timed out')), options.timeout);
      setTimeout(() => { clearTimeout(timeout); resolve({ stdout }); }, delayMs);
    }));
}
it('allows cold PowerShell and CIM enumeration to finish after 30 seconds', async () => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  respondAfter(31_000, '[{"Name":"Readable Studio.exe","ExecutablePath":"C:\\\\app\\\\studio.exe","ProcessId":123}]');
  const result = listWindowsExecutableProcesses(/readable/i).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(31_000);
  expect(await result).toMatchObject({ value: [{ pid: 123 }] });
});
it('keeps process identity checks and gives PowerShell startup plus exit confirmation separate room', async () => {
  vi.useFakeTimers(); respondAfter(121_000);
  const target = { pid: 123, executablePath: path.resolve('old', 'app.exe') };
  let listed = false;
  const result = stopProcessesInsideRoot(path.resolve('old'), { list: async () => {
    if (listed) return []; listed = true; return [target];
  } }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(121_000);
  expect(await result).toEqual({ value: [target] });
  const script = execAsync.mock.calls[0]?.[1]?.at(-1) as string;
  expect(script).toContain('WaitForExit(60000)');
  expect(script).toContain('$row.ExecutablePath -ne $image -or $p.MainModule.FileName -ne $image');
});
