// Databricks agent model helpers shared by the picker, the Add Models modal and
// the app-level agent list.
//
// Databricks is its own agent whose model catalogue is *registered* by the user
// (scan a workspace, pick endpoints) instead of being detected from a CLI. Two
// invariants live here so every surface agrees on them:
//
// 1. The trailing "Add models" row in the model dropdown is an ACTION. It has an
//    id only so the UI can key and test it; that id is never a model value and
//    `agentModelSelection` refuses it even if it were ever persisted.
// 2. Registration and selection are separate. Registering endpoints publishes
//    the new catalogue through `DATABRICKS_MODELS_CHANGED_EVENT`; the app merges
//    it into the agent's `models` and nothing touches the active choice.

import type {
  AgentInfo,
  AgentModelOption,
  DatabricksRegisteredEndpoint,
} from '@readable-studio/contracts';

export const DATABRICKS_AGENT_ID = 'databricks';

/** UI-only id for the trailing action row. Never a model value. */
export const DATABRICKS_ADD_MODELS_ACTION_ID = 'databricks:add-models';

export const DATABRICKS_MODELS_CHANGED_EVENT =
  'readable-studio:databricks-models-changed';

export function isDatabricksManagedAgent(
  agent: Pick<AgentInfo, 'modelManagement'> | null | undefined,
): boolean {
  return agent?.modelManagement === 'databricks';
}

export function isDatabricksActionId(id: string | null | undefined): boolean {
  return id === DATABRICKS_ADD_MODELS_ACTION_ID;
}

/** A registered endpoint becomes one ordinary dropdown row keyed by its app alias. */
export function registeredEndpointToModelOption(
  endpoint: DatabricksRegisteredEndpoint,
): AgentModelOption {
  return {
    id: endpoint.appModelId,
    label: endpoint.servedModelName ?? endpoint.displayName ?? endpoint.label,
    source: 'databricks',
    connectionId: endpoint.profileId,
    endpointId: endpoint.id,
    availability: endpoint.availability,
    ...(endpoint.reasoningOptions ? { reasoningOptions: endpoint.reasoningOptions } : {}),
    capabilities: endpoint.capabilities,
  };
}

export function notifyDatabricksModelsChanged(models: AgentModelOption[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(DATABRICKS_MODELS_CHANGED_EVENT, { detail: { models } }),
  );
}

export function databricksModelsFromEvent(event: Event): AgentModelOption[] | null {
  if (!(event instanceof CustomEvent)) return null;
  const models = (event.detail as { models?: unknown } | null)?.models;
  return Array.isArray(models) ? (models as AgentModelOption[]) : null;
}

/** Replaces the managed agent's catalogue; every other agent passes through. */
export function applyDatabricksModels(
  agents: AgentInfo[],
  models: AgentModelOption[],
): AgentInfo[] {
  return agents.map((agent) =>
    isDatabricksManagedAgent(agent)
      ? { ...agent, models, modelsSource: 'live' as const }
      : agent,
  );
}
