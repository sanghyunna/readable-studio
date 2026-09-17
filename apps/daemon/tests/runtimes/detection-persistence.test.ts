import { chmod, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DetectedAgent, RuntimeAgentDef } from '../../src/runtimes/types.js';

vi.mock('../../src/runtimes/detection-probe.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import * as detection from '../../src/runtimes/detection.js';

let root: string;
const options = { enabledAgentIds: ['codex'] };
const env = { codex: { CODEX_BIN: process.execPath } };
function result(def: RuntimeAgentDef): DetectedAgent {
  return { ...def, available: true, path: process.execPath, modelsSource: 'live',
    authStatus: 'ok', models: [{ id: 'verified', label: 'Verified' }] };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function restart() {
  detection._resetAgentDetectionCacheForTests();
  detection.configureDetectionStorage(root);
  vi.mocked(safeProbe).mockClear();
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
  // Given a held final probe.
  const started = deferred<RuntimeAgentDef>();
  const pending = deferred<DetectedAgent>();
  vi.mocked(safeProbe).mockImplementation((def) => { started.resolve(def); return pending.promise; });
  const run = detection.detectAgents(env, options);
  const def = await started.promise;
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  // When the last probe finishes.
  pending.resolve(result(def));
  await run;
  // Then completion and verified results share the atomic record.
  const stored = JSON.parse(await readFile(path.join(root, 'agent-scan.json'), 'utf8'));
  expect(stored).toMatchObject({ agentIds: ['codex'], results: [{ id: 'codex', available: true }] });
  expect(Number.isFinite(Date.parse(stored.completedAt))).toBe(true);
});

it('reuses persisted results without scanning when a later process starts', async () => {
  // Given a completed scan and a fresh in-process cache.
  const expected = await detection.detectAgents(env, options);
  await restart();
  // When startup and renderer discovery race after restart.
  const actual = await Promise.all([detection.detectAgents(env, options), detection.detectAgents(env, options)]);
  // Then both reuse the stored result and the splash has no first-run scan.
  expect(actual.map((agents) => agents.map((agent) => agent.models))).toEqual([expected.map((agent) => agent.models), expected.map((agent) => agent.models)]);
  expect(safeProbe).not.toHaveBeenCalled();
  expect(detection.getStartupScanProgress()).toBeNull();
});

it('verifies fresh and replaces storage when explicitly rescanned', async () => {
  // Given a previously verified persisted model.
  await detection.detectAgents(env, options);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), models: [{ id: 'fresh', label: 'Fresh' }] }));
  // When a manual refresh runs.
  await detection.detectAgents(env, { ...options, refresh: true });
  expect(safeProbe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'codex' }), env.codex, 'online');
  await restart();
  // Then the next process reuses the new model.
  expect((await detection.detectAgents(env, options))[0]?.models[0]?.id).toBe('fresh');
  expect(safeProbe).not.toHaveBeenCalled();
});

it.each([undefined, '', '{', '{}', '{"completedAt":"invalid"}'])('scans as first run when storage is %s', async (contents) => {
  // Given absent or invalid durable storage.
  if (contents !== undefined) await writeFile(path.join(root, 'agent-scan.json'), contents);
  // When discovery starts.
  await detection.detectAgents(env, options);
  // Then a real verification runs.
  expect(safeProbe).toHaveBeenCalledTimes(1);
});

it('invalidates stored results when the enabled inventory changes', async () => {
  // Given a snapshot with only Codex.
  await detection.detectAgents(env, options);
  await restart();
  // When another agent is enabled.
  await detection.detectAgents(env, { enabledAgentIds: ['codex', 'kimi'] });
  // Then both definitions are verified afresh.
  expect(safeProbe).toHaveBeenCalledTimes(2);
});

it('drops stale availability when the stored executable vanishes', async () => {
  // Given a stored executable removed between launches.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable }));
  await detection.detectAgents(configured, options);
  await rm(executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [], modelsSource: 'fallback' }));
  // When the stored result is loaded.
  const agents = await detection.detectAgents(configured, options);
  // Then fresh verification replaces the vanished executable's stale models.
  expect(agents[0]).toMatchObject({ available: false, models: [] });
  expect(safeProbe).toHaveBeenCalledTimes(1);
});

it('verifies fresh when a same-path replacement preserves size and modification time', async () => {
  // Given a verified executable, replaced in place without changing size or mtime.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const originalTime = new Date('2020-01-01T00:00:00Z');
  await utimes(executable, originalTime, originalTime);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable }));
  await detection.detectAgents(configured, options);
  const replacement = path.join(root, 'replacement.exe');
  await writeFile(replacement, 'replaced');
  await chmod(replacement, 0o755);
  await utimes(replacement, originalTime, originalTime);
  await rename(replacement, executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable, available: false, authStatus: 'missing', models: [] }));
  // When discovery reads the previous snapshot.
  const agents = await detection.detectAgents(configured, options);
  // Then the replacement cannot inherit verified availability or models.
  expect(agents[0]).toMatchObject({ available: false, authStatus: 'missing', models: [] });
  expect(safeProbe).toHaveBeenCalledTimes(1);
});

it('reuses an unchanged executable snapshot without verification', async () => {
  // Given a real unchanged file backing a completed verification.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable }));
  await detection.detectAgents(configured, options);
  await restart();
  // When discovery restarts.
  const agents = await detection.detectAgents(configured, options);
  // Then verified models are reused without a CLI probe.
  expect(agents[0]).toMatchObject({ available: true, models: [{ id: 'verified' }] });
  expect(safeProbe).not.toHaveBeenCalled();
});

it('requires verification when a vanished executable returns at the same path', async () => {
  // Given a verified file followed by a completed missing-executable scan.
  const executable = path.join(root, 'fixture.exe');
  await writeFile(executable, 'original');
  await chmod(executable, 0o755);
  const configured = { codex: { CODEX_BIN: executable } };
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable }));
  await detection.detectAgents(configured, options);
  await rm(executable);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [], modelsSource: 'fallback' }));
  await detection.detectAgents(configured, options);
  await writeFile(executable, 'replacement');
  await chmod(executable, 0o755);
  await restart();
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), path: executable, models: [{ id: 'renewed', label: 'Renewed' }] }));
  // When a replacement appears at the formerly verified path.
  const agents = await detection.detectAgents(configured, options);
  // Then only freshly verified models are returned, not the original snapshot.
  expect(agents[0]?.models).toEqual([{ id: 'renewed', label: 'Renewed' }]);
  expect(safeProbe).toHaveBeenCalledTimes(1);
});

it('does not make unverified stored models usable', async () => {
  // Given a completed but unavailable result.
  vi.mocked(safeProbe).mockImplementation(async (def) => ({ ...result(def), available: false, models: [] }));
  await detection.detectAgents(env, options);
  await restart();
  // When a later launch reads it.
  const agents = await detection.detectAgents(env, options);
  // Then no usable model is invented.
  expect(agents[0]).toMatchObject({ available: false, models: [] });
  expect(safeProbe).not.toHaveBeenCalled();
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
  // Given a pending verification and its owning cancellation signal.
  const controller = new AbortController();
  const started = deferred<RuntimeAgentDef>();
  const pending = deferred<DetectedAgent>();
  vi.mocked(safeProbe).mockImplementation((def) => { started.resolve(def); return pending.promise; });
  const run = detection.detectAgents(env, { ...options, signal: controller.signal });
  const def = await started.promise;
  // When the owner cancels before the probe completes.
  controller.abort();
  pending.resolve(result(def));
  // Then cancellation cannot persist completion.
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves completion unset even when a timed-out probe resolves late', async () => {
  // Given a probe held beyond the startup budget.
  vi.useFakeTimers();
  const started = deferred<RuntimeAgentDef>();
  const pending = deferred<DetectedAgent>();
  vi.mocked(safeProbe).mockImplementation((def) => { started.resolve(def); return pending.promise; });
  const run = detection.detectAgents(env, options);
  const rejected = expect(run).rejects.toMatchObject({ name: 'TimeoutError' });
  const def = await started.promise;
  // When the scan deadline expires before completion.
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  pending.resolve(result(def));
  // Then late completion cannot commit a snapshot.
  await expect(readFile(path.join(root, 'agent-scan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
