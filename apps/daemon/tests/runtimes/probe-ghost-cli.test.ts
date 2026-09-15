/** Issue #658: detection must probe the same selected executable as chat.
 * Missing targets are distinct from installed CLIs whose usability is unverified.
 * Neither version output nor a working alternative PATH binary proves readiness.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execAgentFileMock = vi.fn();
const resolveAgentLaunchMock = vi.fn();
const discoverCodexCatalogMock = vi.fn();

vi.mock('../../src/runtimes/invocation.js', () => ({
  // promisified execFile exposes its child; compatibility probing closes stdin.
  execAgentFile: (...args: unknown[]) => Object.assign(execAgentFileMock(...args), {
    child: { stdin: { end: vi.fn() } },
  }),
}));
vi.mock('../../src/runtimes/codex-model-discovery.js', () => ({
  discoverCodexCatalog: (...args: unknown[]) => discoverCodexCatalogMock(...args),
}));
vi.mock('../../src/runtimes/launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtimes/launch.js')>();
  return { ...actual, resolveAgentLaunch: (...args: unknown[]) => resolveAgentLaunchMock(...args) };
});

function fakeLaunch(def: { id: string }) {
  const path = `/fake/bin/${def.id}`;
  return {
    configuredOverridePath: null, pathResolvedPath: path, selectedPath: path,
    launchPath: path, launchKind: 'selected' as const,
    childPathPrepend: ['/fake/bin'], diagnostic: null,
  };
}

function probeError(code: string | number) {
  return Object.assign(new Error('Fixture probe failed'), { code });
}

const liveCatalogue = JSON.stringify({ data: [{ id: 'fixture-model', displayName: 'Fixture' }] });

describe('probe (issue #658) - ghost CLI after the binary is uninstalled', () => {
  beforeEach(async () => {
    execAgentFileMock.mockReset();
    resolveAgentLaunchMock.mockReset().mockImplementation(fakeLaunch);
    discoverCodexCatalogMock.mockReset().mockRejectedValue(new Error('Discovery failed'));
    vi.stubEnv('READABLE_AGENT_DISCOVERY_OFFLINE', '0');
    const { _resetAgentDetectionCacheForTests } = await import('../../src/runtimes/detection.js');
    _resetAgentDetectionCacheForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const [code, reason] of [
    ['ENOENT', 'shim-broken'], ['EACCES', 'not-executable'], ['ENOTDIR', 'shim-broken'],
    [126, 'not-executable'], [127, 'shim-broken'],
  ] as const) {
    it(`marks the agent unavailable when the version probe rejects with ${code}`, async () => {
      execAgentFileMock.mockRejectedValue(probeError(code));
      const { detectAgents } = await import('../../src/runtimes/detection.js');
      const [codex] = await detectAgents({}, { enabledAgentIds: ['codex'] });
      expect(codex).toMatchObject({ available: false, path: '/fake/bin/codex', models: [], diagnostics: [{ reason }] });
      expect(discoverCodexCatalogMock).not.toHaveBeenCalled();
    });
  }

  for (const code of ['ETIMEDOUT', 1]) {
    it(`retains installed state, not usability, after version failure ${code}`, async () => {
      execAgentFileMock.mockRejectedValue(probeError(code));
      const { detectAgents } = await import('../../src/runtimes/detection.js');
      const [codex] = await detectAgents({}, { enabledAgentIds: ['codex'] });
      expect(codex).toMatchObject({ available: false, path: '/fake/bin/codex', version: null, models: [], diagnostics: [{ reason: 'auth-unknown' }] });
    });
  }

  it('returns the parsed version without treating it as authenticated discovery', async () => {
    execAgentFileMock.mockResolvedValue({ stdout: 'codex 1.2.3\n', stderr: '' });
    const { detectAgents } = await import('../../src/runtimes/detection.js');
    const [codex] = await detectAgents({}, { enabledAgentIds: ['codex'] });
    expect(codex).toMatchObject({ available: false, path: '/fake/bin/codex', version: 'codex 1.2.3', models: [], diagnostics: [{ reason: 'auth-unknown' }] });
    expect(discoverCodexCatalogMock).toHaveBeenCalledWith('/fake/bin/codex', expect.any(Object));
  });

  it('allows a failed version flag when compatibility and authenticated discovery succeed', async () => {
    execAgentFileMock.mockImplementation((_bin, args: string[]) => args[0] === '--version'
      ? Promise.reject(probeError(1))
      : Promise.resolve({ stdout: '', stderr: '' }));
    discoverCodexCatalogMock.mockResolvedValue(liveCatalogue);
    const { detectAgents } = await import('../../src/runtimes/detection.js');
    const [codex] = await detectAgents({}, { enabledAgentIds: ['codex'] });
    expect(codex).toMatchObject({ available: true, version: null, modelsSource: 'live', models: [{ id: 'fixture-model' }] });
    expect(codex?.diagnostics).toBeUndefined();
  });

  for (const [id, timeout] of [['trae-cli', 10_000], ['codex', 3000]] as const) {
    it(`honors the ${id} version probe timeout`, async () => {
      execAgentFileMock.mockResolvedValue({ stdout: 'agent 1.2.3\n', stderr: '' });
      const { detectAgents } = await import('../../src/runtimes/detection.js');
      await detectAgents({}, { enabledAgentIds: [id] });
      expect(execAgentFileMock).toHaveBeenCalledWith(`/fake/bin/${id}`, ['--version'], expect.objectContaining({ timeout }));
    });
  }

  it('reports missing Trae CLI as unavailable without breaking working Codex detection', async () => {
    resolveAgentLaunchMock.mockImplementation((def: { id: string }) => def.id === 'trae-cli'
      ? { ...fakeLaunch(def), pathResolvedPath: null, selectedPath: null, launchPath: null }
      : fakeLaunch(def));
    execAgentFileMock.mockResolvedValue({ stdout: 'agent 1.2.3\n', stderr: '' });
    discoverCodexCatalogMock.mockResolvedValue(liveCatalogue);
    const { detectAgents } = await import('../../src/runtimes/detection.js');
    const agents = await detectAgents({}, { enabledAgentIds: ['codex', 'trae-cli'] });
    expect(agents.find(a => a.id === 'trae-cli')).toMatchObject({ available: false, models: [], diagnostics: [{ reason: 'not-on-path' }] });
    expect(agents.find(a => a.id === 'trae-cli')?.path).toBeUndefined();
    expect(agents.find(a => a.id === 'codex')).toMatchObject({ available: true, modelsSource: 'live', models: [{ id: 'fixture-model' }] });
  });

  it('reports unavailable for a stale configured override even when a different PATH binary exists', async () => {
    const { resolveAgentLaunch: realResolveAgentLaunch } = await vi.importActual<typeof import('../../src/runtimes/launch.js')>('../../src/runtimes/launch.js');
    const { inspectAgentExecutableResolution } = await import('../../src/runtimes/executables.js');
    const { codexAgentDef } = await import('../../src/runtimes/defs/codex.js');
    const dir = mkdtempSync(join(tmpdir(), 'ghost-cli-'));
    const stale = join(dir, process.platform === 'win32' ? 'stale.cmd' : 'stale');
    const working = join(dir, process.platform === 'win32' ? 'codex.CMD' : 'codex');
    try {
      for (const bin of [stale, working]) {
        writeFileSync(bin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
        if (process.platform !== 'win32') chmodSync(bin, 0o755);
      }
      vi.stubEnv('PATH', dir);
      vi.stubEnv('READABLE_AGENT_HOME', dir);
      resolveAgentLaunchMock.mockImplementation(realResolveAgentLaunch);
      execAgentFileMock.mockImplementation((bin: string) => bin === stale
        ? Promise.reject(probeError(127))
        : Promise.resolve({ stdout: 'codex 1.4.2\n', stderr: '' }));
      discoverCodexCatalogMock.mockResolvedValue(liveCatalogue);
      const env = { CODEX_BIN: stale };
      expect(inspectAgentExecutableResolution(codexAgentDef, env)).toEqual({ configuredOverridePath: stale, pathResolvedPath: working, selectedPath: stale });
      expect(realResolveAgentLaunch(codexAgentDef, env).launchPath).toBe(stale);
      const { detectAgents } = await import('../../src/runtimes/detection.js');
      const [codex] = await detectAgents({ codex: env }, { enabledAgentIds: ['codex'] });
      expect(codex).toMatchObject({ available: false, path: stale, models: [], diagnostics: [{ reason: 'shim-broken', detail: stale }] });
      expect(execAgentFileMock).toHaveBeenCalledWith(stale, ['--version'], expect.any(Object));
      expect(discoverCodexCatalogMock).not.toHaveBeenCalled();
      // Prove the alternative is working, but only selected after clearing the override.
      const [repaired] = await detectAgents({}, { enabledAgentIds: ['codex'], refresh: true });
      expect(repaired).toMatchObject({ available: true, path: working, modelsSource: 'live', models: [{ id: 'fixture-model' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
