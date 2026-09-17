import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DatabricksServiceError, issueFor, resolveDatabricksCli } from '../../src/databricks/client.js';
import { createDatabricksAgentDef } from '../../src/runtimes/defs/databricks.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { runtimeServiceFixture } from './runtime-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each(['missing', 'valid', 'invalid', 'native-spawn-failure', 'unsupported'] as const)('selects a usable CLI when the local executable is %s', async (local) => {
  // Given a relocated bundle and an isolated local toolchain.
  const root = await mkdtemp(join(tmpdir(), 'databricks-detection-')); roots.push(root);
  const bundled = join(root, 'resources', 'app', 'vendor', 'databricks', 'databricks.exe');
  const installed = join(root, 'local', 'databricks.exe');
  await mkdir(dirname(bundled), { recursive: true }); await writeFile(bundled, 'fixture');
  if (local !== 'missing') { await mkdir(dirname(installed)); await writeFile(installed, 'fixture'); }
  const invoked: string[] = [];
  // When candidate verification runs without authentication.
  const selected = await resolveDatabricksCli(null, {
    env: { PATH: dirname(installed), READABLE_RESOURCE_ROOT: join(root, 'resources', 'readable-studio') }, userToolchainBins: [],
    runner: async (executable, args) => {
      invoked.push(executable); expect(args).toEqual(['--version']);
      if (executable === installed && local === 'invalid') throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE');
      if (executable === installed && local === 'native-spawn-failure') throw Object.assign(new Error('spawn UNKNOWN'), { syscall: 'spawn', code: 'UNKNOWN' });
      return { stdout: executable === installed && local === 'unsupported' ? 'Databricks CLI v0.100.0' : 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    },
  });
  // Then only the valid local CLI can shadow the bundle.
  expect(selected).toEqual({ path: local === 'valid' ? installed : bundled, source: local === 'valid' ? 'path' : 'bundled' });
  expect(invoked).toContain(local === 'valid' ? installed : bundled);
});

it('resolves the staged bundle when source mode has no resource-root environment', async () => {
  // Given a relocated source acquisition tree and no installed executable.
  const root = await mkdtemp(join(tmpdir(), 'databricks-detection-')); roots.push(root);
  const bundled = join(root, '.tmp', 'databricks-cli-acquisition', 'app', 'vendor', 'databricks', 'databricks.exe');
  await mkdir(dirname(bundled), { recursive: true }); await writeFile(bundled, 'fixture');
  // When source mode resolves its packaged equivalent.
  const selected = await resolveDatabricksCli(null, { env: { PATH: '' }, userToolchainBins: [], sourceRoot: root,
    runner: async () => ({ stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 }) });
  // Then the staged bundle is authoritative fallback.
  expect(selected).toEqual({ path: bundled, source: 'bundled' });
});

it.each(['ready', 'missing', 'uninvocable', 'unsupported'] as const)('exposes diagnostics without installation actions when CLI state is %s and registration is empty', async (cli) => {
  // Given no registered Readable models.
  const fixture = runtimeServiceFixture(); fixture.catalogue.models = []; fixture.status.cli = cli;
  // When the managed runtime is detected.
  const detected = await safeProbe(createDatabricksAgentDef(() => fixture.service));
  // Then bundle presence is independent of model registration and failures are actionable.
  expect(detected.available).toBe(cli === 'ready');
  expect(detected.models).toEqual([]);
  expect(detected.diagnostics?.length).toBeGreaterThan(0);
  expect(detected.diagnostics?.[0]?.reason).toBe(cli === 'ready' ? 'auth-unknown' : 'not-executable');
  expect(detected.installUrl).toBeUndefined();
  expect(detected.diagnostics?.flatMap((diagnostic) => diagnostic.fixActions ?? []).some((action) => action.kind === 'openInstall')).toBe(false);
});

it('offers repair/rescan rather than CLI installation when the bundle is missing', () => {
  // Given packaging corruption, when its public issue is classified, then installation is not offered.
  expect(issueFor(new DatabricksServiceError('DATABRICKS_CLI_MISSING')).action).toBe('rescan');
});
