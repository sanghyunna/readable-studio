import express from 'express';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../src/runtimes/detection-probe.js', async (original) => ({
  ...await original<typeof import('../../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));
vi.mock('../../src/agents.js', async (original) => {
  const actual = await original<typeof import('../../src/agents.js')>();
  return { ...actual, detectAgents: vi.fn(actual.detectAgents), detectAgentsStream: vi.fn(actual.detectAgentsStream) };
});

let root: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
    server?.closeAllConnections();
  });
  const detection = await import('../../src/runtimes/detection.js');
  detection._resetAgentDetectionCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([false, true])('starts one exhaustive scan before web discovery with local profile=%s', async (localProfile) => {
  // Given an empty scan store, a restrictive selection, and controlled real detection probes.
  root = await mkdtemp(path.join(tmpdir(), 'early-agent-route-'));
  const profilesFile = path.join(root, 'agents.local.json');
  await writeFile(profilesFile, JSON.stringify({ agents: localProfile ? [{ id: 'local-startup-agent', baseAgent: 'claude' }] : [] }));
  await writeFile(path.join(root, 'app-config.json'), JSON.stringify({ enabledAgentIds: ['codex', 'cursor-agent'] }));
  vi.stubEnv('READABLE_AGENT_PROFILES_CONFIG', profilesFile);
  vi.stubEnv('READABLE_SANDBOX_MODE', '0');
  const detection = await import('../../src/runtimes/detection.js');
  const agentsModule = await import('../../src/agents.js');
  const { safeProbe } = await import('../../src/runtimes/detection-probe.js');
  const { AGENT_DEFS } = await import('../../src/runtimes/registry.js');
  const { registerStaticResourceRoutes } = await import('../../src/routes/static-resource.js');
  const events = new EventEmitter();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const visits: string[] = [];
  vi.mocked(safeProbe).mockImplementation(async (def) => {
    visits.push(def.id);
    events.emit('probe');
    await pending;
    return { ...def, available: false, models: [], modelsSource: 'live' };
  });
  detection.configureDetectionStorage(root);
  const runs: Promise<unknown>[] = [];
  const detectStartup = detection.detectAgents;
  vi.spyOn(detection, 'detectAgents').mockImplementation((env, options) => {
    const run = detectStartup(env, options);
    runs.push(run);
    return run;
  });
  const app = express();
  registerStaticResourceRoutes(app, {
    http: {
      createSseResponse: () => undefined,
      isLocalSameOrigin: () => true,
      requireLocalDaemonRequest: (_req, _res, next) => next(),
      resolvedPortRef: { current: 0 },
      sendApiError: (res, status, code, message) => res.status(status).json({ error: message, code }),
      sendMulterError: () => undefined,
    },
    paths: {
      ARTIFACTS_DIR: root, BUNDLED_PETS_DIR: root, DESIGN_SYSTEMS_DIR: root,
      DESIGN_TEMPLATES_DIR: root, READABLE_BIN: root, PROJECT_ROOT: root,
      PROJECTS_DIR: root, RUNTIME_DATA_DIR: root, RUNTIME_DATA_DIR_CANONICAL: root,
      SKILLS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root, USER_DESIGN_TEMPLATES_DIR: root, USER_SKILLS_DIR: root,
    },
    resources: {
      listAllDesignSystems: async () => [], listAllSkills: async () => [],
      listAllDesignTemplates: async () => [], listAllSkillLikeEntries: async () => [],
      mimeFor: () => 'application/octet-stream',
    },
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  const ids = AGENT_DEFS.map(({ id }) => id);
  expect(ids).toHaveLength(localProfile ? 24 : 23);
  expect(detection.getStartupScanProgress()).toBeNull();
  const probeStarted = once(events, 'probe', { signal: AbortSignal.timeout(10_000) });
  void probeStarted.catch(() => undefined); // Assertion failures may precede this signal.

  // When desktop explicitly starts discovery before any web request exists.
  try {
    const first = await fetch(`${base}/api/agents/scan`, { method: 'POST' });
    expect(first.status).toBe(200);
    await first.json();
    await probeStarted;
    const running = detection.getStartupScanProgress();
    expect(running).toMatchObject({ phase: 'running', completed: 0, total: ids.length });
    const polls = await Promise.all(['GET', 'POST', 'POST'].map((method) => fetch(`${base}/api/agents/scan`, { method })));
    for (const poll of polls) {
      expect(poll.headers.get('cache-control')).toBe('no-store');
      expect(await poll.json()).toEqual({ scan: running });
    }
    vi.mocked(agentsModule.detectAgents).mockImplementation((env, options) => {
      const result = detection.detectAgents(env, options);
      events.emit('web-batch');
      return result;
    });
    vi.mocked(agentsModule.detectAgentsStream).mockImplementation(async function* (env, options) {
      events.emit('web-stream');
      yield* detection.detectAgentsStream(env, options);
    });
    const batchJoined = once(events, 'web-batch', { signal: AbortSignal.timeout(2000) });
    const streamJoined = once(events, 'web-stream', { signal: AbortSignal.timeout(2000) });
    const web = fetch(`${base}/api/agents`);
    const webStream = fetch(`${base}/api/agents?stream=1`);
    await Promise.all([batchJoined, streamJoined]);
    expect(detection.getStartupScanProgress()).toBe(running);
    finish();
    const webResponse = await web;
    expect(await webResponse.json()).toMatchObject({ agents: [{ id: 'codex' }, { id: 'cursor-agent' }] });
    const streamed = await (await webStream).text();
    expect(streamed.match(/event: agent/g)).toHaveLength(2);
    expect(streamed).toContain('event: done');

    // Then every registered ID is probed once and persisted; later polls never restart it.
    expect([...visits].sort()).toEqual([...ids].sort());
    expect(safeProbe).toHaveBeenCalledTimes(ids.length);
    const terminal = detection.getStartupScanProgress();
    expect(terminal).toMatchObject({ phase: 'done', completed: ids.length, total: ids.length });
    const last = await fetch(`${base}/api/agents/scan`);
    expect(await last.json()).toEqual({ scan: terminal });
    expect(detection.getStartupScanProgress()).toBe(terminal);
    expect(safeProbe).toHaveBeenCalledTimes(ids.length);
    const stored = JSON.parse(await readFile(path.join(root, 'agent-scan.json'), 'utf8'));
    expect(stored.agentIds).toEqual(ids);
    expect(stored.results.map((agent: { readonly id: string }) => agent.id)).toEqual(
      AGENT_DEFS.filter((def) => def.modelManagement !== 'databricks').map(({ id }) => id),
    );
    process.stdout.write(`${JSON.stringify({ localProfile, ids, visits, terminal })}\n`);
  } finally {
    finish();
    await Promise.allSettled(runs);
  }
});

it('keeps progress reads observational before an explicit startup request', async () => {
  // Given a daemon with no scan session.
  const detection = await import('../../src/runtimes/detection.js');
  const { registerAgentScanRoute } = await import('../../src/routes/agent-scan.js');
  root = await mkdtemp(path.join(tmpdir(), 'scan-observer-'));
  const app = express();
  registerAgentScanRoute(app, root, (_req, _res, next) => next());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected TCP listener');
  const detect = vi.spyOn(detection, 'detectAgents').mockResolvedValue([]);
  // When an observer requests progress.
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/scan`);
  // Then reading status neither starts detection nor probes agents.
  expect(await response.json()).toEqual({ scan: null });
  expect(detection.getStartupScanProgress()).toBeNull();
  expect(detect).not.toHaveBeenCalled();
});
