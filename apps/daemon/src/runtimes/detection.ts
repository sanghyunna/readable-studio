import { resolveAmrProfile } from '../integrations/vela.js';
import {
  AGENT_DEFS,
  DEFAULT_ENABLED_AGENT_IDS,
} from './registry.js';
import { rememberLiveModels } from './models.js';
import {
  cachedSafeProbe,
  discoveryPolicy,
  detectionEnvFingerprint,
  _resetAgentDetectionCacheForTests as resetCache,
  type DetectionOptions,
} from './detection-cache.js';
import { safeProbe, stripFns } from './detection-probe.js';
import { createHash } from 'node:crypto';
import { resolveAgentLaunch } from './launch.js';
import { clearStoredAgentScan, executableSnapshotIdentity, readStoredAgentScan, writeStoredAgentScan } from './detection-store.js';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

import { resetStartupScanProgress, startStartupScan, type StartupScanSession } from './detection-scan.js';
export { startStartupScan, getStartupScanProgress } from './detection-scan.js';

const startupSessions = new Map<string, StartupScanSession>();
const durableRuns = new Map<string, Promise<DetectedAgent>[]>();
let storageDir: string | undefined;
export function configureDetectionStorage(dataDir: string): void { storageDir = dataDir; }
export function _resetAgentDetectionCacheForTests(): void {
  resetCache();
  startupSessions.clear();
  durableRuns.clear();
  storageDir = undefined;
  resetStartupScanProgress();
}

function durableDetection(
  defs: readonly RuntimeAgentDef[],
  configuredEnvByAgent: Record<string, Record<string, string>>,
  options: DetectionOptions,
): Promise<DetectedAgent>[] {
  options.signal?.throwIfAborted();
  const dataDir = storageDir;
  if (!dataDir || discoveryPolicy(options) === 'offline') return detectionPromises(defs, configuredEnvByAgent, options);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    inventory: AGENT_DEFS.map((def) => ({ id: def.id, bin: def.bin, versionArgs: def.versionArgs })),
    enabled: defs.map((def) => detectionEnvFingerprint(def, configuredEnvByAgent[def.id] ?? {})),
  })).digest('hex');
  const key = `${dataDir}:${fingerprint}`;
  let run = options.signal ? undefined : durableRuns.get(key);
  if (!run) {
    const consumers = defs.map(() => {
      let resolve: (agent: DetectedAgent) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const promise = new Promise<DetectedAgent>((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    });
    run = consumers.map(({ promise }) => promise);
    void Promise.allSettled(run);
    const completion = (async () => {
      const executables = await Promise.all(defs.filter((def) => def.modelManagement !== 'databricks').map(async (def) => {
        const launch = resolveAgentLaunch(def, configuredEnvByAgent[def.id] ?? {});
        return { def, launch, identity: await executableSnapshotIdentity(launch) };
      }));
      // Including executable identity also invalidates legacy path-only snapshots.
      const snapshotFingerprint = createHash('sha256').update(JSON.stringify({
        fingerprint, executables: executables.map(({ def, identity }) => [def.id, identity]),
      })).digest('hex');
      const stored = options.refresh ? null : await readStoredAgentScan(dataDir);
      if (stored?.fingerprint === snapshotFingerprint &&
          JSON.stringify(stored.agentIds) === JSON.stringify(defs.map((def) => def.id)) &&
          executables.every(({ def, launch, identity }) => stored.results.some((agent) => agent.id === def.id &&
            (!agent.available || (identity !== null && launch.selectedPath === agent.path))))) {
        return Promise.all(defs.map(async (def) => {
          if (def.modelManagement === 'databricks') return cachedSafeProbe(safeProbe, def, configuredEnvByAgent[def.id] ?? {}, options);
          const agent = stored.results.find((entry) => entry.id === def.id);
          if (!agent) throw new Error(`Incomplete stored agent scan: ${def.id}`);
          const available = agent.available && agent.models.length > 0 &&
            (agent.modelsSource === 'fallback'
              ? !def.modelSelectionRequired && def.fallbackModels.some((model) => model.id !== 'default') &&
                (!agent.authStatus || agent.authStatus === 'ok')
              : def.modelDiscovery === 'authenticated-session' || agent.authStatus === 'ok');
          return { ...stripFns(def), ...agent, available, models: available ? agent.models : [] };
        }));
      }
      await clearStoredAgentScan(dataDir);
      const controller = new AbortController();
      const cancel = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new DOMException('Agent scan budget expired', 'TimeoutError')), 60_000);
      try {
        const probe = (def: RuntimeAgentDef) => cachedSafeProbe(safeProbe, def, configuredEnvByAgent[def.id] ?? {}, { ...options, refresh: true, signal: controller.signal });
        const session = startStartupScan(defs, probe, controller.signal);
        let completed = 0;
        const results = await Promise.all([...session.promises.values()].map(async (promise, index) => {
          const agent = await promise;
          // Stream immediately; retain only the last completion until the atomic
          // snapshot is written so awaiting the full scan still includes storage.
          if (++completed < defs.length) consumers[index]?.resolve(agent);
          return agent;
        }));
        controller.signal.throwIfAborted();
        await writeStoredAgentScan(dataDir, {
          version: 1, completedAt: new Date().toISOString(), fingerprint: snapshotFingerprint,
          agentIds: defs.map((def) => def.id),
          results: results.filter((agent) => defs.find((def) => def.id === agent.id)?.modelManagement !== 'databricks'),
        }, controller.signal);
        return results;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
      }
    })();
    if (!options.signal) durableRuns.set(key, run);
    const release = () => { if (durableRuns.get(key) === run) durableRuns.delete(key); };
    void completion.then((agents) => {
      agents.forEach((agent, index) => consumers[index]?.resolve(agent));
      release();
    }, (error: unknown) => {
      consumers.forEach((consumer) => consumer.reject(error));
      release();
    });
  }
  return run;
}

function detectionPromises(
  defs: readonly RuntimeAgentDef[],
  configuredEnvByAgent: Record<string, Record<string, string>>,
  options: DetectionOptions,
): Promise<DetectedAgent>[] {
  options.signal?.throwIfAborted();
  const probe = (def: RuntimeAgentDef) => cachedSafeProbe(safeProbe, def, configuredEnvByAgent[def.id] ?? {}, options);
  if (discoveryPolicy(options) === 'offline') return defs.map(probe);
  const key = defs.map((def) => detectionEnvFingerprint(def, configuredEnvByAgent[def.id] ?? {})).join(':');
  let session = options.signal ? undefined : startupSessions.get(key);
  if (!session || session.progress.phase !== 'running') {
    session = startStartupScan(defs, probe, options.signal);
    if (!options.signal) startupSessions.set(key, session);
  }
  switch (session.progress.phase) {
    case 'running': return [...session.promises.values()];
    case 'done': return defs.map(probe);
    case 'cancelled':
    case 'failed':
      startupSessions.delete(key);
      return defs.map(probe);
  }
}

function amrModelScopeFromEnv(env: NodeJS.ProcessEnv): string {
  return resolveAmrProfile(env);
}

function rememberDetectedLiveModels(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
  agent: DetectedAgent,
): void {
  const scope = def.id === 'amr'
    ? amrModelScopeFromEnv({
        ...process.env,
        ...(def.env || {}),
        ...configuredEnv,
      })
    : null;
  rememberLiveModels(agent.id, agent.available && agent.modelsSource === 'live' ? agent.models : [], scope);
}

export async function detectAgents(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectionOptions = {},
): Promise<DetectedAgent[]> {
  const enabledAgentIds = options.enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS;
  // Enabled ids select capabilities, never the inventory whose availability we verify.
  const defs = AGENT_DEFS;
  const results = await Promise.all(durableDetection(defs, configuredEnvByAgent, options));
  for (const [index, agent] of results.entries()) {
    const def = defs[index];
    if (!def) continue;
    rememberDetectedLiveModels(def, configuredEnvByAgent?.[def.id] ?? {}, agent);
  }
  return results.filter((agent) => enabledAgentIds.includes(agent.id));
}

export async function* detectAgentsStream(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectionOptions = {},
): AsyncGenerator<DetectedAgent> {
  const enabledAgentIds = options.enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS;
  const defs = AGENT_DEFS;
  const tagged = durableDetection(defs, configuredEnvByAgent, options).map((promise, index) =>
    promise.then((agent) => {
      const def = defs[index];
      if (def) rememberDetectedLiveModels(def, configuredEnvByAgent?.[def.id] ?? {}, agent);
      return { index, agent };
    }),
  );
  const pending = new Set(tagged.keys());
  while (pending.size > 0) {
    const { index, agent } = await Promise.race(
      tagged.filter((_, i) => pending.has(i)),
    );
    pending.delete(index);
    if (enabledAgentIds.includes(agent.id)) yield agent;
  }
}
