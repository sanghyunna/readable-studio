import { chmod, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { storedAgentScanSchema } from '@readable-studio/contracts';
import { AGENT_DEFS } from '../../src/runtimes/registry.js';
import type { DetectedAgent, RuntimeAgentDef } from '../../src/runtimes/types.js';

vi.mock('../../src/runtimes/detection-probe.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));
vi.mock('../../src/runtimes/launch.js', async (original) => ({
  ...await original<typeof import('../../src/runtimes/launch.js')>(),
  resolveAgentLaunch: (_def: RuntimeAgentDef, configured: Record<string, string>) => ({
    configuredOverridePath: configured.CODEX_BIN ?? null,
    pathResolvedPath: process.execPath, selectedPath: configured.CODEX_BIN ?? process.execPath,
    launchPath: configured.CODEX_BIN ?? process.execPath, launchKind: 'selected',
    childPathPrepend: [], readExecutePaths: [], diagnostic: null,
  }),
}));
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import * as detection from '../../src/runtimes/detection.js';

let root: string;
const options = { enabledAgentIds: ['codex'] };
const inventoryOptions = { enabledAgentIds: AGENT_DEFS.map(({ id }) => id) };
const env = { codex: { CODEX_BIN: process.execPath } };
const cliIds = AGENT_DEFS.filter((def) => def.modelManagement !== 'databricks').map(({ id }) => id);
const managedIds = AGENT_DEFS.filter((def) => def.modelManagement === 'databricks').map(({ id }) => id);
function result(def: RuntimeAgentDef, executable = process.execPath): DetectedAgent {
  return { ...def, available: true, path: def.id === 'codex' ? executable : process.execPath, modelsSource: 'live',
    authStatus: 'ok', models: [{ id: 'verified', label: 'Verified' }] };
}
function kimiResult(def: RuntimeAgentDef): DetectedAgent {
  const { authStatus: _authStatus, ...agent } = result(def);
  return agent;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function expectWarmCache() {
  // Managed registration is intentionally fresh; no CLI in the entire inventory may probe.
  expect(vi.mocked(safeProbe).mock.calls.filter(([def]) => def.modelManagement !== 'databricks')).toEqual([]);
  expect(vi.mocked(safeProbe).mock.calls.map(([def]) => def.id)).toEqual(managedIds);
}
function expectFullScan() {
  expect(vi.mocked(safeProbe).mock.calls.map(([def]) => def.id).sort()).toEqual([...inventoryOptions.enabledAgentIds].sort());
}
async function restart() {
  detection._resetAgentDetectionCacheForTests();
  detection.configureDetectionStorage(root);
  vi.mocked(safeProbe).mockClear();
}
async function storedScan() {
  return storedAgentScanSchema.parse(JSON.parse(await readFile(path.join(root, 'agent-scan.json'), 'utf8')));
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scan-persistence-'));
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def));
  await restart();
});
afterEach(async () => {
  detection._resetAgentDetectionCacheForTests();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('writes completion and results only when the entire scan finishes', async () => {
  // Given a held final inventory probe, not a shared result for every definition.
  const started = deferred<void>();
  const pending = deferred<void>();
  vi.mocked(safeProbe).mockImplementation(async (def) => {
    if (def.id === inventoryOptions.enabledAgentIds.at(-1)) { started.resolve(); await pending.promise; }
    return result(def);
  });
  const run = detection.detectAgents(env, options);
  await started.promise;
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  // When the final probe finishes.
  pending.resolve();
  await run;
  // Then completion and all durable CLI results share the atomic record.
  const stored = await storedScan();
  expect(stored.agentIds).toEqual(inventoryOptions.enabledAgentIds);
  expect(stored.results.map(({ id }) => id)).toEqual(cliIds);
  expect(stored.results.every((agent) => agent.available && agent.models[0]?.id === 'verified')).toBe(true);
  expect(Number.isFinite(Date.parse(stored.completedAt))).toBe(true);
});
it('reuses persisted results without scanning when a later process starts', async () => {
  // Given a completed exhaustive snapshot and a fresh in-process cache.
  const expected = await detection.detectAgents(env, inventoryOptions);
  const stored = await storedScan();
  await restart();
  // When startup and renderer discovery race after restart.
  const actual = await Promise.all([detection.detectAgents(env, inventoryOptions), detection.detectAgents(env, inventoryOptions)]);
  // Then all models are reused, storage is untouched, and no CLI probes run.
  expect(actual.map((agents) => agents.map((agent) => agent.models))).toEqual([expected.map((agent) => agent.models), expected.map((agent) => agent.models)]);
  expectWarmCache();
  expect(await storedScan()).toEqual(stored);
  expect(detection.getStartupScanProgress()).toBeNull();
});
it('retains verified authenticated-session models when a later discovery fails', async () => {
  // Given Kimi's authenticated-session capability (no separate auth probe), previously verified live.
  const kimi = AGENT_DEFS.find((def) => def.id === 'kimi');
  if (!kimi) throw new Error('Kimi definition missing');
  expect(kimi.modelDiscovery).toBe('authenticated-session');
  expect(kimi.authProbe).toBeUndefined();
  vi.mocked(safeProbe).mockImplementation(async (def) => def.id === 'kimi' ? kimiResult(def) : result(def));
  await detection.detectAgents(env, { enabledAgentIds: ['kimi'] });
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => def.id === 'kimi'
    ? { ...kimiResult(def), available: false, models: [], modelsSource: 'fallback',
        diagnostics: [{ reason: 'discovery-failed', severity: 'error', message: 'Live model discovery failed.', fixActions: [{ kind: 'rescan' }] }] }
    : result(def));
  // When a new scan sees a transient discovery error.
  const [agent] = await detection.detectAgents(env, { enabledAgentIds: ['kimi'], refresh: true });
  // Then the last authenticated session remains usable, including after restart.
  expect(agent).toMatchObject({ available: true, modelsSource: 'live', models: [{ id: 'verified' }],
    diagnostics: [{ severity: 'warning', fixActions: expect.arrayContaining([{ kind: 'rescan' }]) }] });
  await restart();
  const [replayed] = await detection.detectAgents(env, { enabledAgentIds: ['kimi'] });
  expect(replayed).toMatchObject({ available: true, models: [{ id: 'verified' }] });
  // A second failed verification cannot extend the same unverified catalogue indefinitely.
  const [expired] = await detection.detectAgents(env, { enabledAgentIds: ['kimi'], refresh: true });
  expect(expired).toMatchObject({ available: false, models: [] });
  expect((await storedScan()).results.find(({ id }) => id === 'kimi')).toMatchObject({ available: false });
});

it.each([
  { name: 'never verified', previous: false, reason: 'discovery-failed', path: process.execPath, authStatus: undefined },
  { name: 'auth required', previous: true, reason: 'discovery-failed', path: process.execPath, authStatus: 'missing' },
  { name: 'binary missing', previous: true, reason: 'not-on-path', path: undefined, authStatus: undefined },
] as const)('blocks $name after a discovery attempt', async ({ previous, reason, path: executable, authStatus }) => {
  // Given either no authenticated history, a real sign-in failure, or a missing executable.
  if (previous) {
    await detection.detectAgents(env, { enabledAgentIds: ['kimi'] });
    await restart();
  }
  vi.mocked(safeProbe).mockImplementation(async (def) => def.id === 'kimi'
    ? { ...kimiResult(def), ...(executable ? { path: executable } : {}),
        ...(authStatus ? { authStatus } : {}), available: false, models: [], modelsSource: 'fallback',
        diagnostics: [{ reason, severity: 'error', message: 'Discovery failed.', fixActions: [{ kind: 'rescan' }] }] }
    : result(def));
  // When the scan completes.
  const [agent] = await detection.detectAgents(env, { enabledAgentIds: ['kimi'], refresh: true });
  // Then prior availability never overrides a genuine blocker.
  expect(agent).toMatchObject({ available: false, models: [] });
});

it('does not inherit Kimi models after an executable replacement at the same path', async () => {
  // Given a verified Kimi executable whose identity changes without changing its configured path.
  const executable = path.join(root, 'kimi.exe');
  await writeFile(executable, 'original');
  const configured = { kimi: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => def.id === 'kimi'
    ? { ...kimiResult(def), path: executable }
    : result(def));
  await detection.detectAgents(configured, { enabledAgentIds: ['kimi'] });
  const replacement = path.join(root, 'replacement.exe');
  await writeFile(replacement, 'different');
  await rename(replacement, executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => def.id === 'kimi'
    ? { ...kimiResult(def), path: executable, available: false, models: [], modelsSource: 'fallback',
        diagnostics: [{ reason: 'discovery-failed', severity: 'error', message: 'Discovery failed.', fixActions: [{ kind: 'rescan' }] }] }
    : result(def));
  // When the replacement fails discovery at the same launch path.
  const [agent] = await detection.detectAgents(configured, { enabledAgentIds: ['kimi'], refresh: true });
  // Then the old executable's proof cannot authorize the replacement.
  expect(agent).toMatchObject({ available: false, models: [] });
});

it('verifies fresh and replaces storage when explicitly rescanned', async () => {
  // Given an old persisted model.
  await detection.detectAgents(env, options);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), models: [{ id: 'fresh', label: 'Fresh' }] }));
  // When a manual refresh runs.
  await detection.detectAgents(env, { ...options, refresh: true });
  // Then every definition is verified once and every durable row is replaced.
  expectFullScan();
  expect(safeProbe).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), env.codex, 'online');
  expect((await storedScan()).results.map((agent) => agent.models[0]?.id)).toEqual(cliIds.map(() => 'fresh'));
  await restart();
  expect((await detection.detectAgents(env, inventoryOptions)).map((agent) => agent.models[0]?.id)).toEqual(inventoryOptions.enabledAgentIds.map(() => 'fresh'));
  expectWarmCache();
});
it.each([undefined, '', '{', '{}', '{"completedAt":"invalid"}'])('scans as first run when storage is %s', async (contents) => {
  // Given absent or invalid storage.
  if (contents !== undefined) await writeFile(path.join(root, 'agent-scan.json'), contents);
  // When discovery starts.
  await detection.detectAgents(env, options);
  // Then the entire inventory is verified exactly once.
  expectFullScan();
});
it('invalidates stored results when the registered inventory changes', async () => {
  // Given a snapshot predating a newly registered local profile.
  await detection.detectAgents(env, options);
  await restart();
  const base = AGENT_DEFS.find((def) => def.id === 'codex');
  if (!base) throw new Error('Codex fixture definition missing');
  AGENT_DEFS.push({ ...base, id: 'local-cache-profile' });
  try {
    // When discovery sees the new registered inventory.
    await detection.detectAgents(env, options);
    // Then all definitions are reverified and the new profile is persisted.
    expect(vi.mocked(safeProbe).mock.calls.map(([def]) => def.id).sort()).toEqual(AGENT_DEFS.map(({ id }) => id).sort());
    expect((await storedScan()).agentIds).toEqual(AGENT_DEFS.map(({ id }) => id));
  } finally { AGENT_DEFS.pop(); }
});
it('reuses the exhaustive snapshot when only the enabled selection changes', async () => {
  // Given a snapshot created for a narrow output selection.
  await detection.detectAgents(env, options);
  await restart();
  // When another registered agent is enabled.
  const agents = await detection.detectAgents(env, { enabledAgentIds: ['codex', 'kimi'] });
  // Then the output changes without reprobing any CLI.
  expect(agents.map(({ id }) => id)).toEqual(['codex', 'kimi']);
  expectWarmCache();
});
it('drops stale availability when the stored executable vanishes', async () => {
  // Given a stored executable removed between launches.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def, executable));
  await detection.detectAgents(configured, options);
  await rm(executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [], modelsSource: 'fallback' }));
  // When the stored result is loaded.
  const agents = await detection.detectAgents(configured, options);
  // Then verification replaces stale models.
  expect(agents[0]).toMatchObject({ available: false, models: [] });
  expectFullScan();
});
it('verifies fresh when a same-path replacement preserves size and modification time', async () => {
  // Given an executable replaced without changing its size or mtime.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const originalTime = new Date('2020-01-01T00:00:00Z');
  await utimes(executable, originalTime, originalTime);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def, executable));
  await detection.detectAgents(configured, options);
  const replacement = path.join(root, 'replacement.exe');
  await writeFile(replacement, 'replaced');
  await chmod(replacement, 0o755);
  await utimes(replacement, originalTime, originalTime);
  await rename(replacement, executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def, executable), available: false, authStatus: 'missing', models: [] }));
  // When discovery reads the old snapshot.
  const agents = await detection.detectAgents(configured, options);
  // Then the replacement cannot inherit availability or models.
  expect(agents[0]).toMatchObject({ available: false, authStatus: 'missing', models: [] });
  expectFullScan();
});
it('reuses an unchanged executable snapshot without verification', async () => {
  // Given a real unchanged executable backing a completed verification.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def, executable));
  await detection.detectAgents(configured, options);
  await restart();
  // When discovery restarts.
  const agents = await detection.detectAgents(configured, options);
  // Then verified models are reused without any CLI probe.
  expect(agents[0]).toMatchObject({ available: true, models: [{ id: 'verified' }] });
  expectWarmCache();
});
it('requires verification when a vanished executable returns at the same path', async () => {
  // Given a verified file followed by a completed missing-executable scan.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def, executable));
  await detection.detectAgents(configured, options);
  await rm(executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [], modelsSource: 'fallback' }));
  await detection.detectAgents(configured, options);
  await writeFile(executable, 'replacement');
  await chmod(executable, 0o755);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def, executable), models: [{ id: 'renewed', label: 'Renewed' }] }));
  // When the replacement appears at the formerly verified path.
  const agents = await detection.detectAgents(configured, options);
  // Then only freshly verified models are returned.
  expect(agents[0]?.models).toEqual([{ id: 'renewed', label: 'Renewed' }]);
  expectFullScan();
});
it('does not make unverified stored models usable', async () => {
  // Given completed but unavailable results across the inventory.
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [] }));
  await detection.detectAgents(env, options);
  await restart();
  // When a later launch reads them.
  const agents = await detection.detectAgents(env, inventoryOptions);
  // Then no usable model is invented for any definition.
  expect(agents.map((agent) => ({ available: agent.available, models: agent.models }))).toEqual(inventoryOptions.enabledAgentIds.map(() => ({ available: false, models: [] })));
  expectWarmCache();
});
it('leaves completion unset when a probe fails like an interrupted process', async () => {
  // Given a failing scan boundary.
  vi.mocked(safeProbe).mockRejectedValue(new Error('interrupted'));
  // When discovery cannot finish.
  await expect(detection.detectAgents(env, options)).rejects.toThrow('interrupted');
  // Then the next launch remains a first run.
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('leaves completion unset when the scan owner cancels', async () => {
  // Given pending verification and its cancellation signal.
  const controller = new AbortController();
  const started = deferred<void>();
  const pending = deferred<void>();
  vi.mocked(safeProbe).mockImplementation(async (def) => { started.resolve(); await pending.promise; return result(def); });
  const run = detection.detectAgents(env, { ...options, signal: controller.signal });
  await started.promise;
  // When the owner cancels before completion.
  controller.abort();
  pending.resolve();
  // Then cancellation cannot persist completion.
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('finishes the inventory without durably caching a timed-out probe', async () => {
  // Given one probe that never returns while the rest complete normally.
  vi.useFakeTimers();
  const started = deferred<void>();
  vi.mocked(safeProbe).mockImplementation(async (def) => {
    if (def.id === 'pi') { started.resolve(); return new Promise<DetectedAgent>(() => {}); }
    return result(def);
  });
  const run = detection.detectAgents(env, inventoryOptions);
  const settled = Promise.allSettled([run]);
  await started.promise;
  // When the hung agent exceeds its own budget.
  await vi.advanceTimersByTimeAsync(120_000);
  const [outcome] = await settled;
  expect(outcome?.status).toBe('fulfilled');
  if (outcome?.status !== 'fulfilled') return;
  // Then every agent reports, fast agents survive, and progress reaches the full inventory.
  expect(outcome.value).toHaveLength(AGENT_DEFS.length);
  expect(outcome.value.find(({ id }) => id === 'codex')).toMatchObject({ available: true });
  expect(outcome.value.find(({ id }) => id === 'cursor-agent')).toMatchObject({ available: true });
  expect(outcome.value.find(({ id }) => id === 'pi')).toMatchObject({ available: false,
    diagnostics: [expect.objectContaining({ reason: 'probe-timeout' })] });
  expect(detection.getStartupScanProgress()).toMatchObject({ phase: 'done', completed: AGENT_DEFS.length, total: AGENT_DEFS.length });
  const stored = await storedScan();
  expect(stored.agentIds).toEqual(inventoryOptions.enabledAgentIds);
  expect(stored.results.some(({ id }) => id === 'pi')).toBe(false);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => result(def));
  const next = await detection.detectAgents(env, inventoryOptions);
  expect(next.find(({ id }) => id === 'pi')).toMatchObject({ available: true });
  expect(vi.mocked(safeProbe).mock.calls.map(([def]) => def.id).sort()).toEqual(['databricks', 'pi'].sort());
});
