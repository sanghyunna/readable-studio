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

import { splitDatabricksModelName } from '@readable-studio/contracts';
import type {
  AgentInfo,
  AgentModelOption,
  DatabricksRegisteredEndpoint,
  DatabricksEndpoint,
} from '@readable-studio/contracts';
import { fetchDatabricksModels } from '../providers/databricks';

/**
 * Model-management lists retain the full title and show the UC path separately.
 * Only UC services have a path; periods in serving endpoint names are literal.
 * A differing served model remains secondary information.
 */
export function displayDatabricksModelName(endpoint: Pick<DatabricksEndpoint, 'kind' | 'label' | 'displayName' | 'servedModelName'>) {
  const title = endpoint.displayName ?? endpoint.label;
  const split = endpoint.kind === 'serving-endpoint' ? { model: title, path: null }
    : endpoint.label !== title && title.endsWith(`.${endpoint.label}`)
      ? { model: endpoint.label, path: title.slice(0, -(endpoint.label.length + 1)) }
    : splitDatabricksModelName(title);
  const secondary = endpoint.servedModelName && endpoint.servedModelName !== split.model ? endpoint.servedModelName : null;
  return { model: split.model, path: split.path, title, secondary };
}

export function databricksProtocolDescription(endpoint: DatabricksEndpoint): string {
  const transport = endpoint.api === 'anthropic-messages' ? 'Anthropic Messages'
    : endpoint.api === 'openai-completions' ? 'OpenAI-compatible Chat Completions' : 'Protocol unverified';
  const evidence = endpoint.protocolEvidence;
  if (!evidence) return `${transport}. Protocol evidence unavailable; rescan to refresh.`;
  if (evidence.reason === 'runtime-accepted') return `${transport}. Accepted during endpoint protocol negotiation.`;
  if (evidence.reason === 'chat-task') return `${transport}. Endpoint reports task llm/v1/chat, without API types; this is a transport, not the model family.`;
  return `${transport}. Advertised: ${evidence.advertised.join(', ') || 'none'}. Native: ${evidence.native.join(', ') || 'not reported'}.${evidence.reason === 'prefer-messages' ? ' Messages preferred to preserve native thinking and tools.' : ''}`;
}

export function databricksLimitDescription(endpoint: DatabricksEndpoint): string {
  const { capabilities } = endpoint;
  return `Context: ${capabilities.contextWindow === null ? 'unknown - not reported or recognized; local planning estimate only' : capabilities.limitSources?.contextWindow ?? 'source unavailable'}. Output: ${capabilities.maxTokens === null ? 'unknown - endpoint default; a required budget is negotiated within the run' : capabilities.limitSources?.maxTokens ?? 'source unavailable'}. Explicit output-ceiling rejections are adapted within the run.`;
}

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

/** The daemon owns display labels, including collision suffixes; ids stay opaque. */
export function registeredEndpointToModelOption(
  endpoint: DatabricksRegisteredEndpoint,
): AgentModelOption {
  return {
    id: endpoint.appModelId,
    label: endpoint.label,
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

let refreshInFlight: Promise<AgentModelOption[] | null> | null = null;

/**
 * Refetches the registered catalogue and publishes it through
 * `DATABRICKS_MODELS_CHANGED_EVENT`. The daemon learns Claude thinking levels
 * in the background, so the browser's list can be stale. Concurrent callers
 * share one request; a failure keeps the cached list and resolves `null`.
 */
export function refreshDatabricksModels(): Promise<AgentModelOption[] | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchDatabricksModels()
    .then((response) => {
      const models = response.models.map(registeredEndpointToModelOption);
      notifyDatabricksModelsChanged(models);
      return models;
    })
    .catch((error: unknown) => {
      console.warn('Databricks model catalogue refresh failed; keeping the cached list.', error);
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Follow-up refetch delays after selecting a model whose levels are not known yet. */
export const DATABRICKS_REASONING_FOLLOW_UP_DELAYS_MS = [3_000, 15_000] as const;

/**
 * Bounded follow-up for a selected model without thinking levels: refetch at
 * each delay, stop as soon as the model advertises levels, never loop.
 * Returns the cancel function.
 */
export function scheduleDatabricksReasoningFollowUp(modelId: string): () => void {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    timers.forEach(clearTimeout);
  };
  const timers = DATABRICKS_REASONING_FOLLOW_UP_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      if (cancelled) return;
      void refreshDatabricksModels().then((models) => {
        if (models?.find((model) => model.id === modelId)?.reasoningOptions?.length) cancel();
      });
    }, delay),
  );
  return cancel;
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
