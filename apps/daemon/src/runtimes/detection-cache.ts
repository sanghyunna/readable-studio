import { createHash } from 'node:crypto';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

const DETECTION_CACHE_TTL_MS = 10_000;
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
) => Promise<DetectedAgent>;

export type DetectionOptions = {
  readonly enabledAgentIds?: readonly string[];
  readonly refresh?: boolean;
};

const detectionCache = new Map<string, DetectionCacheEntry>();

function detectionEnvFingerprint(
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
}

export function cachedSafeProbe(
  probe: DetectionProbe,
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
  options: Pick<DetectionOptions, 'refresh'> = {},
): Promise<DetectedAgent> {
  const now = Date.now();
  const key = `${def.id}:${detectionEnvFingerprint(def, configuredEnv)}`;
  const cached = detectionCache.get(key);
  if (cached?.promise && !options.refresh) return cached.promise;
  if (cached && cached.expiresAtMs > now) {
    if (!options.refresh && cached.value) return Promise.resolve(cached.value);
  }
  if (cached) detectionCache.delete(key);

  const promise = probe(def, configuredEnv).then((agent) => {
    if (detectionCache.get(key)?.promise === promise) {
      detectionCache.set(key, {
        expiresAtMs: Date.now() + DETECTION_CACHE_TTL_MS,
        value: agent,
      });
    }
    return agent;
  }, (error) => {
    if (detectionCache.get(key)?.promise === promise) detectionCache.delete(key);
    throw error;
  });
  detectionCache.set(key, {
    expiresAtMs: now + DETECTION_CACHE_TTL_MS,
    promise,
  });
  return promise;
}
