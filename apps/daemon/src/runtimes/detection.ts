import { DEFAULT_ENABLED_AGENT_IDS } from '../app-config.js';
import { resolveAmrProfile } from '../integrations/vela.js';
import { AGENT_DEFS } from './registry.js';
import { rememberLiveModels } from './models.js';
import {
  cachedSafeProbe,
  type DetectionOptions,
} from './detection-cache.js';
import { safeProbe } from './detection-probe.js';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

export { _resetAgentDetectionCacheForTests } from './detection-cache.js';

function amrModelScopeFromEnv(env: NodeJS.ProcessEnv): string {
  return resolveAmrProfile(env);
}

function rememberDetectedLiveModels(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
  agent: DetectedAgent,
): void {
  if (def.id === 'amr' && agent.models.length === 0) return;
  const scope = def.id === 'amr'
    ? amrModelScopeFromEnv({
        ...process.env,
        ...(def.env || {}),
        ...configuredEnv,
      })
    : null;
  rememberLiveModels(agent.id, agent.models, scope);
}

export async function detectAgents(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectionOptions = {},
): Promise<DetectedAgent[]> {
  const enabledAgentIds = options.enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS;
  const defs = AGENT_DEFS.filter((def) => enabledAgentIds.includes(def.id));
  const results = await Promise.all(
    defs.map((def) => cachedSafeProbe(
      safeProbe,
      def,
      configuredEnvByAgent?.[def.id] ?? {},
      options,
    )),
  );
  for (const [index, agent] of results.entries()) {
    const def = defs[index];
    if (!def) continue;
    rememberDetectedLiveModels(def, configuredEnvByAgent?.[def.id] ?? {}, agent);
  }
  return results;
}

export async function* detectAgentsStream(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: DetectionOptions = {},
): AsyncGenerator<DetectedAgent> {
  const enabledAgentIds = options.enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS;
  const defs = AGENT_DEFS.filter((def) => enabledAgentIds.includes(def.id));
  const tagged = defs.map((def, index) =>
    cachedSafeProbe(
      safeProbe,
      def,
      configuredEnvByAgent?.[def.id] ?? {},
      options,
    ).then((agent) => {
      rememberDetectedLiveModels(def, configuredEnvByAgent?.[def.id] ?? {}, agent);
      return { index, agent };
    }),
  );
  const pending = new Set(tagged.keys());
  while (pending.size > 0) {
    const { index, agent } = await Promise.race(
      tagged.filter((_, i) => pending.has(i)),
    );
    pending.delete(index);
    yield agent;
  }
}
