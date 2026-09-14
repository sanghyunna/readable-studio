import type { AgentInfo, AgentModelChoice, AgentModelOption, AppConfig } from '../types';
import { isDatabricksActionId } from './databricksModels';

type AgentModelSource =
  | Pick<
      AgentInfo,
      'id' | 'models' | 'supportsCustomModel' | 'modelSelectionRequired' | 'modelManagement'
    >
  | null
  | undefined;

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
  // The "Add models" row is an action, never a model: it is neither a selectable
  // catalogue entry nor an acceptable persisted choice.
  if (isDatabricksActionId(configuredModel)) return undefined;
  const modelIds = (agent.models ?? [])
    .map((model) => model.id)
    .filter((modelId) => !isDatabricksActionId(modelId));
  const selectableModelIds = modelIds.filter((modelId) => modelId !== 'default');

  // A CLI with no concrete model choices owns model resolution itself. This is
  // a usable capability, not an unmade user choice, so preserve the sentinel
  // the daemon already understands instead of making the agent unsendable.
  // An agent that requires an explicit registered model gets no such fallback:
  // an empty catalogue means nothing can be sent until a model is registered.
  if (selectableModelIds.length === 0 && (!configuredModel || configuredModel === 'default')) {
    if (agent.modelSelectionRequired) return undefined;
    return { ...choice, model: 'default' };
  }
  if (!configuredModel || configuredModel === 'default') return undefined;
  // Agents that own model registration only run registered ids; a free-form
  // id has nothing to resolve against.
  const allowsCustomModel =
    agent.supportsCustomModel !== false && agent.modelManagement === undefined;
  if (modelIds.includes(configuredModel) || allowsCustomModel) {
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

type ReasoningSource = Pick<AgentInfo, 'id' | 'models' | 'reasoningOptions'> | null | undefined;

/**
 * Reasoning-effort levels for the model an agent will actually run; `[]` when
 * the pairing supports none.
 *
 * A registered model may advertise its own `reasoningOptions` (Databricks does
 * so per endpoint); when present, that list replaces the agent-wide one. Grok
 * Build lists efforts agent-wide but its CLI applies `--effort` only to
 * reasoning models, so its non-reasoning models resolve to none. Every effort
 * control reads its list from here and hides itself when the list is empty,
 * so the trigger, the option list and the mount gate can never disagree.
 */
export function effectiveReasoningOptions(
  agent: ReasoningSource,
  modelId: string | null | undefined,
): AgentModelOption[] {
  if (!agent) return [];
  if (agent.id === 'grok-build') {
    const id = modelId ?? '';
    if (!/reasoning/i.test(id) || /non-reasoning/i.test(id)) return [];
  }
  const model = modelId
    ? agent.models?.find((candidate) => candidate.id === modelId)
    : undefined;
  return model?.reasoningOptions ?? agent.reasoningOptions ?? [];
}

/** Effort levels for the composer's current agent + model pick (CLI mode only). */
export function composerReasoningOptions(
  config: Pick<AppConfig, 'mode' | 'agentId' | 'agentModels'>,
  agents: readonly AgentInfo[],
): AgentModelOption[] {
  if (config.mode !== 'daemon' || !config.agentId) return [];
  const agent = agents.find((candidate) => candidate.id === config.agentId);
  const choice = effectiveAgentModelChoice(agent, config.agentModels?.[config.agentId]);
  return effectiveReasoningOptions(agent, choice?.model);
}
