import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { resolvePiPowerShell } from '../../src/runtimes/pi-powershell.js';

beforeEach(() => {
  vi.spyOn(childProcess, 'spawn');
  vi.spyOn(childProcess, 'spawnSync');
  vi.spyOn(fs, 'existsSync');
  syncBuiltinESMExports();
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
      executable = resolvePiPowerShell(shellEnv);
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
    const probe = vi.mocked(childProcess.spawnSync).mock.calls.at(-1);
    assert.ok(probe);
    expect(Array.isArray(probe[1])).toBe(true);
    expect(probe[2]).toMatchObject({ windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096 });
  });
}

test('prefers SystemRoot over WINDIR and does not search PATH', () => {
  // Given: distinct, available OS roots and a successful native readiness probe.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.mocked(childProcess.spawnSync).mockReturnValue({ pid: 1, output: [], stdout: 'READABLE_PI_POWERSHELL', stderr: '', status: 0, signal: null });
  // When: resolving the interpreter.
  const result = resolvePiPowerShell({ SystemRoot: 'D:\\OS', WINDIR: 'E:\\Windows', PATH: 'X:\\Git\\bin' });
  // Then: the native SystemRoot location wins deterministically.
  expect(result).toBe(path.win32.join('D:\\OS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

test('rejects an existing but unexecutable candidate before trying the next OS root', () => {
  // Given: existence is not proof of interpreter readiness.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.mocked(childProcess.spawnSync)
    .mockReturnValueOnce({ pid: 1, output: [], stdout: '', stderr: 'blocked', status: 1, signal: null })
    .mockReturnValueOnce({ pid: 2, output: [], stdout: 'READABLE_PI_POWERSHELL', stderr: '', status: 0, signal: null });
  // When: resolving from competing OS locations.
  const result = resolvePiPowerShell({ SystemRoot: 'D:\\Blocked', WINDIR: 'E:\\Windows' });
  // Then: the validated candidate, not the first existing file, wins.
  expect(result).toBe('E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('reports failure when no candidate passes the PowerShell readiness probe', () => {
  // Given: a file can exist without being PowerShell.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.mocked(childProcess.spawnSync).mockReturnValue({ pid: 1, output: [], stdout: 'wrong-runtime', stderr: '', status: 0, signal: null });
  // When / Then: resolution cannot silently declare the wrong interpreter usable.
  expect(() => resolvePiPowerShell({})).toThrow();
});
