import type { DatabricksCapabilities, DatabricksEndpoint, DatabricksEndpointApi } from '@readable-studio/contracts';

/**
 * Streaming/chat fallback maxima from provider specifications (2026-09-11),
 * except where live endpoint measurements are noted. Workspace learning wins.
 * Decimal K/M for prose; GPT-OSS's 131,072 table context was also reported by
 * both live serving endpoints' exceeded-context errors (2026-09-29). A generic
 * recipe is still subordinate to this workspace's advertised budget.
 * This is the only identity fallback table; never infer limits from a service
 * alias, provider name, or an unrecognized future model/version.
 */
const MODEL_LIMITS = [
  // https://platform.claude.com/docs/en/models/sonnet-5/overview
  // Batch-only 300K output is NOT available to our streaming Messages runtime.
  { names: ['claude-sonnet-5'], contextWindow: 1_000_000, maxTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/sonnet-4-5/overview
  { names: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4.5'], contextWindow: 200_000, maxTokens: 64_000 },
  // https://platform.claude.com/docs/en/models/opus-4-5/overview
  { names: ['claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4.5'], contextWindow: 200_000, maxTokens: 64_000 },
  // https://platform.claude.com/docs/en/models/haiku-4-5/overview
  { names: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5'], contextWindow: 200_000, maxTokens: 64_000 },
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol (also documents gpt-5.6 alias)
  { names: ['gpt-5.6', 'gpt-5.6-sol'], contextWindow: 1_050_000, maxTokens: 128_000 },
  // https://developers.openai.com/api/docs/models/gpt-5.6-terra
  { names: ['gpt-5.6-terra'], contextWindow: 1_050_000, maxTokens: 128_000 },
  // https://developers.openai.com/api/docs/models/gpt-5.6-luna
  { names: ['gpt-5.6-luna'], contextWindow: 1_050_000, maxTokens: 128_000 },
  // https://developers.openai.com/api/docs/models/gpt-oss-120b
  // Output measured on the live databricks-gpt-oss-120b serving endpoint,
  // 2026-09-15: budgets above 25,000 return 400; vendor 131,072 is not its output ceiling.
  { names: ['gpt-oss-120b'], contextWindow: 131_072, maxTokens: 25_000 },
  // https://developers.openai.com/api/docs/models/gpt-oss-20b
  { names: ['gpt-oss-20b'], contextWindow: 131_072, maxTokens: 131_072 },
] as const;

/**
 * Pi requires numeric planning budgets. These are NOT wire budgets or claimed
 * maxima: the relay removes unknown output budgets and negotiates if required.
 * Null + unknown provenance remains in the catalogue.
 */
const UNKNOWN_LIMITS = { contextWindow: 1_000_000, maxTokens: 128_000 };

// Live gateway acceptance, 2026-09-13: .omo/evidence/databricks-effort/probe.md.
// These exact recipes retain their measured levels; other reasoning-family
// members start with only the common low/medium/high levels.
const MODEL_EFFORTS: Array<{ name: string; api: DatabricksEndpointApi; levels: string[] }> = [
  { name: 'claude-sonnet-5', api: 'anthropic-messages', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { name: 'gpt-5.6-luna', api: 'openai-completions', levels: ['low', 'medium', 'high', 'xhigh'] },
  // Live serving endpoint acceptance, 2026-09-15; not verified for gpt-oss-20b.
  { name: 'gpt-oss-120b', api: 'openai-completions', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** Advertise only levels proven for every live served model on this protocol. */
export function resolveDatabricksReasoningOptions(
  api: DatabricksEndpointApi,
  models: Array<{ name?: string }>,
): NonNullable<DatabricksEndpoint['reasoningOptions']> {
  const recipes = models.map((model) => {
    // Preserve measured recipes before normalizing vendor-qualified identities.
    const exactName = model.name?.trim().toLowerCase().replace(/^system\.ai\./, '');
    const exact = MODEL_EFFORTS.find((entry) => entry.api === api && entry.name === exactName);
    if (exact) return exact;
    const name = model.name ? normalizeDatabricksModelIdentity(model.name) : '';
    const family = api === 'anthropic-messages'
      ? /^claude-(?:sonnet|opus|haiku)-(?:[4-9]|[1-9]\d)(?:[-.][0-9]+)?$/.test(name)
      : api === 'openai-completions' && (/^o[1-9](?:-mini|-preview)?$/.test(name)
        || /^gpt-5(?:\.[0-9]+)?(?:-(?:mini|nano|sol|terra|luna))?$/.test(name)
        || /^gpt-oss-[0-9]+b$/.test(name));
    return family ? { levels: ['low', 'medium', 'high'] } : undefined;
  });
  const levels = recipes[0]?.levels ?? [];
  return levels.filter((level) => recipes.every((recipe) => recipe?.levels.includes(level)))
    .map((id) => ({ id, label: EFFORT_LABELS[id]! }));
}

/** Strip only known registries/vendors and dated releases, never arbitrary aliases or model versions. */
export function normalizeDatabricksModelIdentity(name: string): string {
  return name.trim().toLowerCase().replace(/^system\.ai\./, '')
    .replace(/^(?:anthropic|openai)\//, '').replace(/^databricks-/, '')
    .replace(/-(?:20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/, '');
}

type Limits = Pick<DatabricksCapabilities, 'contextWindow' | 'maxTokens'>;
type Sources = NonNullable<DatabricksCapabilities['limitSources']>;
type ContextSource = Sources['contextWindow'];
type OutputSource = Sources['maxTokens'];

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function advertisedFoundationContext(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  // Both forms occur in captured Foundation GETs (2026-09-29). K is a safe
  // decimal budget, not a claim that rounded prose specifies an exact ceiling.
  const match = /\bsupports a context length of ([1-9]\d{0,6})(K)? tokens\b/i.exec(value)
    ?? /\ba ([1-9]\d{0,6})(K)? token context window\b/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]) * (match[2] ? 1_000 : 1);
  // Never expand Pi's existing unknown-context planning budget from unverified prose.
  return Number.isSafeInteger(amount) && amount >= 1_024 && amount <= UNKNOWN_LIMITS.contextWindow ? amount : null;
}
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Only explicit capability containers, never rate limits or generation defaults. */
function metadataLimits(metadata: Record<string, unknown>): Limits {
  const containers = [metadata, record(metadata.capabilities), record(metadata.model_info), record(metadata.limits)];
  const get = (keys: string[]) => {
    for (const container of containers) for (const key of keys) {
      const value = positive(container[key]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    contextWindow: get(['context_window', 'contextWindow', 'max_context_window', 'max_context_length']),
    maxTokens: get(['max_output_tokens', 'maxTokens', 'max_output_token_count']),
  };
}

export function resolveDatabricksCapabilities(
  metadata: Record<string, unknown>,
  models: Array<{ name?: string; metadata: Record<string, unknown> }>,
): DatabricksCapabilities {
  const reported = metadataLimits(metadata);
  const config = record(metadata.config);
  const entities = config.served_entities ?? config.served_models;
  const foundation = Array.isArray(entities) && entities.length > 0 && entities.every(entity => Object.hasOwn(record(entity), 'foundation_model'));
  const contexts = foundation && Array.isArray(entities)
    ? entities.map(entity => advertisedFoundationContext(record(record(entity).foundation_model).description)) : [];
  const advertisedContext = contexts.length > 0 && contexts.every(value => value !== null) ? Math.min(...contexts.filter(value => value !== null)) : null;
  const resolved = models.map((model) => {
    const limits = metadataLimits(model.metadata);
    const known = MODEL_LIMITS.find((entry) => entry.names.some((name) => name === (model.name ? normalizeDatabricksModelIdentity(model.name) : undefined)));
    return { limits, known };
  });
  function field(key: 'contextWindow'): { value: number | null; source: ContextSource };
  function field(key: 'maxTokens'): { value: number | null; source: OutputSource };
  function field(key: keyof Limits): { value: number | null; source: ContextSource | OutputSource } {
    if (reported[key] !== null) return { value: reported[key], source: 'metadata' };
    if (key === 'contextWindow' && advertisedContext !== null) return { value: advertisedContext, source: 'advertised' };
    const values = resolved.map(({ limits, known }) => ({ value: limits[key] ?? known?.[key] ?? null,
      source: limits[key] !== null ? 'metadata' as const : known ? 'model-table' as const : 'unknown' as const }));
    // A routed endpoint must accept the budget on EVERY live destination.
    if (!values.length || values.some((entry) => entry.value === null)) return { value: null, source: foundation ? 'default' : 'unknown' };
    return { value: Math.min(...values.map((entry) => entry.value!)),
      source: values.some((entry) => entry.source === 'model-table') ? 'model-table' : 'metadata' };
  }
  const contextWindow = field('contextWindow');
  const maxTokens = field('maxTokens');
  // Explicit workspace numbers win, then advertised prose, then the generic
  // identity recipe. Never silently substitute a larger table context for prose.
  const tableContexts = resolved.flatMap(({ known }) => known ? [known.contextWindow] : []);
  const modelTable = tableContexts.length === resolved.length && tableContexts.length ? Math.min(...tableContexts) : null;
  if (modelTable !== null && contextWindow.value !== null && contextWindow.source !== 'model-table' && contextWindow.value !== modelTable) {
    console.warn('Databricks context limit disagreement', { field: 'contextWindow', selected: contextWindow.value,
      selectedSource: contextWindow.source, modelTable });
  }
  return { tools: 'unknown', images: 'unknown', contextWindow: contextWindow.value, maxTokens: maxTokens.value,
    limitSources: { contextWindow: contextWindow.source, maxTokens: maxTokens.source } };
}

export function effectiveDatabricksLimits(capabilities: Limits): { contextWindow: number; maxTokens: number } {
  const contextWindow = capabilities.contextWindow ?? UNKNOWN_LIMITS.contextWindow;
  return { contextWindow, maxTokens: capabilities.maxTokens ?? Math.min(UNKNOWN_LIMITS.maxTokens, contextWindow) };
}

/** Display identity only; limits and their provenance belong in capabilities. */
export function databricksEndpointLabel(name: string): string {
  return name;
}
