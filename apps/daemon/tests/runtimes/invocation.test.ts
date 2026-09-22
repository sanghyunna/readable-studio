import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execAgentFile } from '../../src/runtimes/invocation.js';

test.runIf(process.platform === 'win32')('executes a Windows shim with uppercase COMSPEC and an isolated PATH', async () => {
  // Given a valid shim and the uppercase environment used by worker processes.
  const home = mkdtempSync(join(tmpdir(), 'runtime-invocation-'));
  const bin = join(home, 'probe.cmd');
  writeFileSync(bin, '@echo off\r\necho %PROBE_VERSION%\r\n');
  const shell = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'COMSPEC')?.[1];
  expect(shell).toBeTruthy();
  try {
    // When the real subprocess runs without cmd.exe on PATH.
    const result = await execAgentFile(bin, [], { env: { COMSPEC: shell, PATH: home, PROBE_VERSION: 'version-from-env' } });
    // Then its output proves both execution and configured-env propagation.
    expect(String(result.stdout).trim()).toBe('version-from-env');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
