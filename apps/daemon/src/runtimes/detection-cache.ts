import { createHash } from 'node:crypto';
import { withProbeLifetime } from './probe-lifetime.js';
import { stripFns } from './detection-probe.js';
import { installMetaForAgent } from './metadata.js';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

const DETECTION_CACHE_TTL_MS = 10_000;
// Cold Pi has taken 20s; Cursor allows a 90s model command. Leave room for
// additional auth/version work without letting one agent block its peers.
const PROBE_BUDGET_MS = 120_000;
const DETECTION_PROCESS_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'READABLE_AGENT_HOME',
  'READABLE_DATA_DIR',
  'READABLE_RESOURCE_ROOT',
  'READABLE_SANDBOX_MODE',
  'NPM_CONFIG_PREFIX',
  'npm_config_prefix',
] as const;

type DetectionCacheEntry = {
  readonly expiresAtMs: number;
  readonly promise?: Promise<DetectedAgent>;
  readonly value?: DetectedAgent;
};

type DetectionProbe = (
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
  policy: DiscoveryPolicy,
) => Promise<DetectedAgent>;

export type DiscoveryPolicy = 'online' | 'offline';

export function discoveryPolicy(options: DetectionOptions): DiscoveryPolicy {
  return options.refresh ? 'online' : options.policy ?? 'online';
}

export type DetectionOptions = {
  readonly enabledAgentIds?: readonly string[];
  readonly refresh?: boolean;
  readonly policy?: DiscoveryPolicy;
  readonly signal?: AbortSignal;
};

const detectionCache = new Map<string, DetectionCacheEntry>();
let ownedCaches = new WeakMap<AbortSignal, Map<string, DetectionCacheEntry>>();

export function detectionEnvFingerprint(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
): string {
  const processEnv = Object.fromEntries(
    DETECTION_PROCESS_ENV_KEYS.map((key) => [key, process.env[key] ?? '']),
  );
  return createHash('sha256')
    .update(JSON.stringify({ agentId: def.id, configuredEnv, processEnv }))
    .digest('hex');
}

export function _resetAgentDetectionCacheForTests(): void {
  detectionCache.clear();
  ownedCaches = new WeakMap();
}

export function cachedSafeProbe(
  probe: DetectionProbe,
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
  options: DetectionOptions = {},
): Promise<DetectedAgent> {
  options.signal?.throwIfAborted();
  // Different cancellation owners never share cancellable in-flight work.
  // Settled results remain shared; an aborted attempt never publishes a value.
  let cache = detectionCache;
  if (options.signal) {
    cache = ownedCaches.get(options.signal) ?? new Map();
    ownedCaches.set(options.signal, cache);
  }
  const now = Date.now();
  const policy = discoveryPolicy(options);
  const key = `${def.id}:${policy}:${detectionEnvFingerprint(def, configuredEnv)}`;
  const cached = cache.get(key) ?? (detectionCache.get(key)?.value ? detectionCache.get(key) : undefined);
  // Refresh bypasses settled results, never a probe already doing fresh work.
  if (cached?.promise) return cached.promise;
  if (cached && cached.expiresAtMs > now) {
    if (!options.refresh && cached.value) return Promise.resolve(cached.value);
  }
  if (cached) cache.delete(key);

  const run = () => probe(def, configuredEnv, policy);
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new DOMException('Agent probe budget expired', 'TimeoutError')), PROBE_BUDGET_MS);
  const pending = withProbeLifetime(signal, run).finally(() => clearTimeout(timer));
  const promise = pending.then((agent) => {
    options.signal?.throwIfAborted();
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
      // Managed registrations are only single-flight, never cached after settling.
      if (def.modelManagement === 'databricks') detectionCache.delete(key);
      else if (cache === detectionCache || !detectionCache.get(key)?.promise) detectionCache.set(key, {
        expiresAtMs: Date.now() + DETECTION_CACHE_TTL_MS,
        value: agent,
      });
    }
    return agent;
  }).catch((error: unknown) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    if (deadline.signal.aborted && !options.signal?.aborted && error instanceof DOMException && error.name === 'TimeoutError') {
      return { ...stripFns(def), ...installMetaForAgent(def.id), available: false, models: [], modelsSource: 'fallback' as const,
        diagnostics: [{ reason: 'probe-timeout' as const, severity: 'error' as const,
          message: `Agent verification timed out after ${PROBE_BUDGET_MS / 1000} seconds. Rescan to retry.`,
          fixActions: [{ kind: 'rescan' as const }] }] };
    }
    throw error;
  });
  cache.set(key, {
    expiresAtMs: now + DETECTION_CACHE_TTL_MS,
    promise,
  });
  return promise;
}
