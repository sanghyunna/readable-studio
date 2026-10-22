import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
let resolvePiPowerShell: typeof import('../../src/runtimes/pi-powershell.js').resolvePiPowerShell;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(childProcess, 'spawn');
  vi.spyOn(childProcess, 'execFile');
  vi.spyOn(fs, 'existsSync');
  syncBuiltinESMExports();
  ({ resolvePiPowerShell } = await import('../../src/runtimes/pi-powershell.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

for (const env of [{}, { systemroot: 'C:\\Windows', PATH: '' }]) {
  test(`resolves runnable native PowerShell without Git or PATH: ${JSON.stringify(env)}`, async () => {
    // Given: location variables and Git Bash are unavailable.
    const home = await mkdtemp(path.join(tmpdir(), 'pi-shell-home-'));
    const shellEnv = { ...env, PATH: '', HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
    let output = '';
    let executable: string;
    let result: { exitCode: number | null };
    try {
      executable = await resolvePiPowerShell(shellEnv);
      // When: the same Pi backend and isolated home used by the managed runtime execute.
      result = await createLocalBashOperations({ shellPath: executable }).exec(
        "[Console]::Write(('NATIVE_' + (6 * 7)))", process.cwd(),
        { env: shellEnv, timeout: 10, onData: data => { output += data.toString(); } },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    // Then: native evaluation succeeds with an argument-array hidden spawn.
    expect(result.exitCode).toBe(0);
    expect(output).toBe('NATIVE_42');
    const call = vi.mocked(childProcess.spawn).mock.calls.at(-1);
    assert.ok(call);
    expect(call[0]).toBe(executable);
    expect(call[1]).toEqual(['-c', "[Console]::Write(('NATIVE_' + (6 * 7)))"]);
    expect(call[2]).toMatchObject({ windowsHide: true, detached: false });
    expect(call[2]?.shell ?? false).toBe(false);
    const probe = vi.mocked(childProcess.execFile).mock.calls.at(-1);
    assert.ok(probe);
    expect(Array.isArray(probe[1])).toBe(true);
    expect(probe[1]).toEqual(['-NoProfile', '-NonInteractive', '-c', expect.any(String)]);
    expect(probe[2]).toMatchObject({ windowsHide: true, shell: false, timeout: 180000, maxBuffer: 4096 });
  });
}

function mockProbe(...results: Array<{ error?: NodeJS.ErrnoException; stdout: string }>) {
  let index = 0;
  vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
    const result = results[Math.min(index++, results.length - 1)]!;
    callback(result.error ?? null, result.stdout, '');
    return {} as childProcess.ChildProcess;
  });
}

test('prefers SystemRoot over WINDIR and does not search PATH', async () => {
  // Given: distinct, available OS roots and a successful native readiness probe.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  mockProbe({ stdout: 'READABLE_PI_POWERSHELL' });
  // When: resolving the interpreter.
  const result = await resolvePiPowerShell({ SystemRoot: 'D:\\OS', WINDIR: 'E:\\Windows', PATH: 'X:\\Git\\bin' });
  // Then: the native SystemRoot location wins deterministically.
  expect(result).toBe(path.win32.join('D:\\OS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

test('rejects an existing but unexecutable candidate before trying the next OS root', async () => {
  // Given: existence is not proof of interpreter readiness.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  mockProbe({ error: new Error('blocked'), stdout: '' }, { stdout: 'READABLE_PI_POWERSHELL' });
  // When: resolving from competing OS locations.
  const result = await resolvePiPowerShell({ SystemRoot: 'D:\\Blocked', WINDIR: 'E:\\Windows' });
  // Then: the validated candidate, not the first existing file, wins.
  expect(result).toBe('E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('reports failure when no candidate passes the PowerShell readiness probe', async () => {
  // Given: a file can exist without being PowerShell.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  mockProbe({ stdout: 'wrong-runtime' });
  // When / Then: resolution cannot silently declare the wrong interpreter usable.
  await expect(resolvePiPowerShell({})).rejects.toThrow('returned unexpected output');
});

test('probes without profiles or interaction and allows three minutes', async () => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  mockProbe({ stdout: 'READABLE_PI_POWERSHELL' });
  await resolvePiPowerShell({});
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-c', expect.any(String)],
    expect.objectContaining({ timeout: 180000, windowsHide: true, shell: false }),
    expect.any(Function),
  );
});

test('reuses the first successful resolution without another probe', async () => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  mockProbe({ stdout: 'READABLE_PI_POWERSHELL' });
  const first = await resolvePiPowerShell({ SystemRoot: 'D:\\OS' });
  expect(await resolvePiPowerShell({})).toBe(first);
  expect(childProcess.execFile).toHaveBeenCalledTimes(1);
});

test('reports elapsed timeout distinctly from not found and retries failures', async () => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  await expect(resolvePiPowerShell({})).rejects.toThrow('not found');
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(181025);
  mockProbe({ error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), stdout: '' });
  await expect(resolvePiPowerShell({})).rejects.toThrow(/PowerShell is starting slowly.*180 s.*180025 ms/);
  mockProbe({ stdout: 'READABLE_PI_POWERSHELL' });
  await expect(resolvePiPowerShell({})).resolves.toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('retries unexpected output on the next resolution', async () => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  mockProbe({ stdout: 'wrong-runtime' }, { stdout: 'READABLE_PI_POWERSHELL' });
  await expect(resolvePiPowerShell({})).rejects.toThrow('returned unexpected output');
  await expect(resolvePiPowerShell({})).resolves.toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(childProcess.execFile).toHaveBeenCalledTimes(2);
});
