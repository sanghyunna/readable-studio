import type { RuntimeAgentDef, RuntimeModelOption } from './types.js';

export const DEFAULT_MODEL_OPTION: RuntimeModelOption = {
  id: 'default',
  label: 'Default (CLI config)',
};

// Discovery owns verified availability, including an empty/unusable result.
// Submission admission is separate: an empty scan must not veto an explicit
// static or safe custom selection, nor imply that no selection is required.
const liveModelCache = new Map<string, Set<string>>();
const liveModelOrder = new Map<string, string[]>();

function liveModelCacheKey(agentId: string, scope?: string | null): string {
  const trimmedScope = typeof scope === 'string' ? scope.trim() : '';
  return trimmedScope ? `${agentId}\0${trimmedScope}` : agentId;
}

export function rememberLiveModels(agentId: string, models: RuntimeModelOption[], scope?: string | null) {
  if (!Array.isArray(models)) return;
  const ids = models
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string');
  const key = liveModelCacheKey(agentId, scope);
  liveModelCache.set(
    key,
    new Set(ids),
  );
  liveModelOrder.set(key, ids);
}

export function getRememberedLiveModels(agentId: string, scope?: string | null): RuntimeModelOption[] {
  const ids = liveModelOrder.get(liveModelCacheKey(agentId, scope)) ?? [];
  return ids.map((id) => ({ id, label: id }));
}

export function preferFreshLiveModels(
  freshModels: RuntimeModelOption[],
  rememberedModels: RuntimeModelOption[],
): RuntimeModelOption[] {
  return freshModels.length > 0 ? freshModels : rememberedModels;
}

export function isKnownModel(
  def: RuntimeAgentDef,
  modelId: string | null | undefined,
  scope?: string | null,
) {
  if (!modelId) return false;
  const live = liveModelCache.get(liveModelCacheKey(def.id, scope));
  if (live) return live.has(modelId);
  if (Array.isArray(def.fallbackModels)) {
    return def.fallbackModels.some((m) => m.id === modelId);
  }
  return false;
}

export function agentHasModelChoice(
  def: RuntimeAgentDef,
  liveModelScope?: string | null,
): boolean {
  if (def.modelSelectionRequired) return true;
  const remembered = liveModelOrder.get(liveModelCacheKey(def.id, liveModelScope));
  if (remembered?.length) return remembered.some((id) => id !== DEFAULT_MODEL_OPTION.id);
  // Only an explicit no-choice sentinel permits a CLI-owned default. An
  // undiscovered catalogue is not evidence that the agent has no choices.
  return def.fallbackModels.length === 0 || def.fallbackModels.some(
    (model) => model.id !== DEFAULT_MODEL_OPTION.id,
  );
}

// Admit only a model the caller explicitly supplied. Catalog-only adapters
// reject ids that were not surfaced by their live/static model list, while
// custom-capable adapters may accept a safe free-form id. The synthetic
// `default` is not a universal fallback: it is valid only when the adapter
// has no concrete model choice to make.
export function resolveModelForAgent(
  def: RuntimeAgentDef,
  requested: string | null | undefined,
  _env: Record<string, string | undefined> = process.env,
  liveModelScope?: string | null,
): string | null {
  if (typeof requested !== 'string') return null;
  const trimmed = requested.trim();
  if (!trimmed) return null;
  if (trimmed === DEFAULT_MODEL_OPTION.id) {
    if (def.modelSelectionRequired) return null;
    return isKnownModel(def, trimmed, liveModelScope) && !agentHasModelChoice(def, liveModelScope)
      ? trimmed
      : null;
  }
  if (isKnownModel(def, trimmed, liveModelScope) || def.fallbackModels.some((model) => model.id === trimmed)) return trimmed;
  if (def.supportsCustomModel === false) return null;
  return sanitizeCustomModel(trimmed);
}

// Permit user-typed model ids that didn't appear in either the live
// listing or the static fallback (e.g. the user is on a brand-new model
// the CLI's `models` command hasn't surfaced yet). The CLI gets the value
// as a child-process arg — not a shell string — so injection isn't a
// concern, but we still reject anything that could be misread as a flag
// by a downstream CLI or that contains whitespace / control chars.
export function sanitizeCustomModel(id: string | null | undefined) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(trimmed)) return null;
  return trimmed;
}
