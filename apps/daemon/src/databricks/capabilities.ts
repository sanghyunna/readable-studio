import type { DatabricksCapabilities, DatabricksEndpoint, DatabricksEndpointApi } from '@readable-studio/contracts';

/**
 * Streaming/chat fallback maxima from provider specifications (2026-09-11),
 * except where live endpoint measurements are noted. Workspace learning wins.
 * Decimal K/M, except GPT-OSS's documented 131,072 context window.
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
// Effort is model-specific, not a guarantee of either wire protocol. Do not
// extend these recipes to aliases, other versions, or unprobed models.
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
  const recipes = models.map((model) => MODEL_EFFORTS.find((entry) => entry.api === api
    // system.ai is the registry qualifier in foundation_model.name, not a version or alias.
    && entry.name === model.name?.trim().toLowerCase().replace(/^system\.ai\./, '')));
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
type Source = NonNullable<DatabricksCapabilities['limitSources']>['contextWindow'];

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const resolved = models.map((model) => {
    const limits = metadataLimits(model.metadata);
    const known = MODEL_LIMITS.find((entry) => entry.names.some((name) => name === (model.name ? normalizeDatabricksModelIdentity(model.name) : undefined)));
    return { limits, known };
  });
  const field = (key: keyof Limits): { value: number | null; source: Source } => {
    if (reported[key] !== null) return { value: reported[key], source: 'metadata' };
    const values = resolved.map(({ limits, known }) => ({ value: limits[key] ?? known?.[key] ?? null,
      source: limits[key] !== null ? 'metadata' as const : known ? 'model-table' as const : 'unknown' as const }));
    // A routed endpoint must accept the budget on EVERY live destination.
    if (!values.length || values.some((entry) => entry.value === null)) return { value: null, source: 'unknown' };
    return { value: Math.min(...values.map((entry) => entry.value!)),
      source: values.some((entry) => entry.source === 'model-table') ? 'model-table' : 'metadata' };
  };
  const contextWindow = field('contextWindow');
  const maxTokens = field('maxTokens');
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
