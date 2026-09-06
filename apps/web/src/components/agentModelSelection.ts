import type { AgentInfo, AgentModelChoice, AppConfig } from '../types';

type AgentModelSource = Pick<AgentInfo, 'id' | 'models' | 'supportsCustomModel'> | null | undefined;

export const MODEL_SELECTION_REQUIRED_EVENT = 'readable:model-selection-required';

export function notifyModelSelectionRequired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MODEL_SELECTION_REQUIRED_EVENT));
  }
}

function resolveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  if (!agent) return undefined;

  const configuredModel =
    typeof choice?.model === 'string' ? choice.model.trim() : '';
  const modelIds = agent.models?.map((model) => model.id) ?? [];
  const selectableModelIds = modelIds.filter((modelId) => modelId !== 'default');

  // A CLI with no concrete model choices owns model resolution itself. This is
  // a usable capability, not an unmade user choice, so preserve the sentinel
  // the daemon already understands instead of making the agent unsendable.
  if (selectableModelIds.length === 0 && (!configuredModel || configuredModel === 'default')) {
    return { ...choice, model: 'default' };
  }
  if (!configuredModel || configuredModel === 'default') return undefined;
  if (modelIds.includes(configuredModel) || agent.supportsCustomModel !== false) {
    return { ...choice, model: configuredModel };
  }
  return undefined;
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return resolveAgentModelChoice(agent, choice);
}

export function hasRequiredModelSelection(
  config: Pick<AppConfig, 'mode' | 'model' | 'agentId' | 'agentModels'>,
  agents: readonly AgentInfo[],
): boolean {
  if (config.mode === 'api') {
    const model = config.model.trim();
    return Boolean(model && model !== 'default');
  }
  if (!config.agentId) return false;
  const agent = agents.find((candidate) => candidate.id === config.agentId);
  return Boolean(resolveAgentModelChoice(agent, config.agentModels?.[config.agentId]));
}

/** Shared submission gate for both Hub and workspace composers. */
export function requireModelSelection(
  config: Pick<AppConfig, 'mode' | 'model' | 'agentId' | 'agentModels'>,
  agents: readonly AgentInfo[],
): boolean {
  const selected = hasRequiredModelSelection(config, agents);
  if (!selected) notifyModelSelectionRequired();
  return selected;
}
