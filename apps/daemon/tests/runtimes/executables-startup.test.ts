import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectAgentExecutableResolution } from '../../src/runtimes/executables.js';
import { minimalAgentDef } from './helpers/test-helpers.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

let root: string;
const suffix = process.platform === 'win32' ? '.EXE' : '';
const def = minimalAgentDef({ id: 'claude', bin: 'startup-cli', fallbackBins: ['startup-fallback'] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-startup-'));
  vi.stubEnv('READABLE_AGENT_HOME', root);
  vi.stubEnv('READABLE_RESOURCE_ROOT', '');
  vi.stubEnv('READABLE_SANDBOX_MODE', '0');
  vi.stubEnv('PATHEXT', '.EXE;.CMD;.BAT');
  vi.stubEnv('PATH', Array.from({ length: 200 }, (_, i) => path.join(root, `bin-${i}`)).join(path.delimiter));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it('reduces existence checks by at least 90 percent when an authoritative executable is configured', () => {
  // Given a real executable and a long PATH with no alternative.
  const executable = path.join(root, `configured${suffix}`);
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  const exists = vi.mocked(fs.existsSync);
  exists.mockClear();
  // When 22 callers resolve the same authoritative executable.
  const results = Array.from({ length: 22 }, () => inspectAgentExecutableResolution(def, { CLAUDE_BIN: executable }));
  const checks = exists.mock.calls.length;
  console.error(`authoritative resolution: 22 calls, ${checks} existence checks`);
  // Then selection stays correct without 22 full PATH walks (baseline >= 26,400).
  expect(results.every((result) => result.selectedPath === executable)).toBe(true);
  expect(checks).toBeLessThan(2640);
});

it('avoids repeated PATH scans when the packaged executable is authoritative', () => {
  // Given a real bundled Vela and its required OpenCode companion.
  const resourceRoot = path.join(root, 'resources');
  const companion = path.join(resourceRoot, 'bin', 'libexec', 'opencode');
  fs.mkdirSync(companion, { recursive: true });
  const vela = path.join(resourceRoot, 'bin', process.platform === 'win32' ? 'vela.exe' : 'vela');
  const opencode = path.join(companion, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  for (const executable of [vela, opencode]) {
    fs.writeFileSync(executable, '');
    fs.chmodSync(executable, 0o755);
  }
  vi.stubEnv('READABLE_RESOURCE_ROOT', resourceRoot);
  vi.stubEnv('VELA_OPENCODE_BIN', '');
  const exists = vi.mocked(fs.existsSync);
  exists.mockClear();
  const bundledDef = minimalAgentDef({ id: 'amr', bin: 'vela' });
  // When 22 callers resolve the bundled executable.
  const results = Array.from({ length: 22 }, () => inspectAgentExecutableResolution(bundledDef));
  // Then the packaged selection is preserved without repeated PATH scans.
  expect(results.every((result) => result.selectedPath === vela)).toBe(true);
  expect(exists.mock.calls.length).toBeLessThan(1320);
});

it('uses the changed PATH when authoritative configuration changes or disappears', () => {
  // Given a previous authoritative resolution.
  const executable = path.join(root, `configured${suffix}`);
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  inspectAgentExecutableResolution(def, { CLAUDE_BIN: executable });
  const fallback = path.join(root, `startup-fallback${suffix}`);
  fs.writeFileSync(fallback, '');
  fs.chmodSync(fallback, 0o755);
  vi.stubEnv('PATH', root);
  // When the override is removed and PATH changes.
  const result = inspectAgentExecutableResolution(def);
  // Then fallback discovery is fresh.
  expect(result.selectedPath).toBe(fallback);
});

it('refreshes diagnostic PATH resolution when PATH changes with the override retained', () => {
  // Given a cached authoritative resolution.
  const executable = path.join(root, `configured${suffix}`);
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  inspectAgentExecutableResolution(def, { CLAUDE_BIN: executable });
  const alternative = path.join(root, `startup-cli${suffix}`);
  fs.writeFileSync(alternative, '');
  fs.chmodSync(alternative, 0o755);
  vi.stubEnv('PATH', root);
  // When the PATH fingerprint changes.
  const result = inspectAgentExecutableResolution(def, { CLAUDE_BIN: executable });
  // Then both diagnostic and authoritative selections are accurate.
  expect(result).toMatchObject({ selectedPath: executable, pathResolvedPath: alternative });
});
