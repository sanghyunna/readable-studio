import { createHmac } from 'node:crypto';
import type { DatabricksEndpoint, DatabricksEndpointApi } from '@readable-studio/contracts';
import type { DiscoveredResource } from './scan.js';
import { databricksEndpointLabel, resolveDatabricksCapabilities, resolveDatabricksReasoningOptions } from './capabilities.js';

/** Daemon-private catalogue: routing and UI identities, never arbitrary upstream metadata. */
export interface DatabricksWireCapabilities {
  responsesUnsupported: boolean;
  /** Learned same-workspace Responses surface, never an arbitrary upstream URL. */
  responsesPath?: string;
  /** Accepted native protocol; fixed workspace path, not an upstream-supplied URL. */
  api?: 'anthropic-messages';
  /** Version of the documented surfaces exhausted before artifact fallback. */
  toolSurfaceVersion?: 2;
  tools?: 'supported' | 'unsupported' | 'unknown';
  /** Positive learning was recorded after a tool-bearing response completed. */
  toolsCompletionVersion?: 1;
  chatTokensField: 'max_completion_tokens' | 'max_tokens';
  outputLimit?: number;
  requiredOutputBudget: boolean;
  omittedFields: string[];
}

export interface CatalogueEntry {
  endpoint: DatabricksEndpoint;
  configurationId?: string;
  wireCapabilities?: DatabricksWireCapabilities;
  upstreamName: string;
  basePath: string;
}

export function applyLearnedDatabricksProtocol(entry: CatalogueEntry): void {
  if (entry.wireCapabilities?.api !== 'anthropic-messages') return;
  entry.endpoint.api = 'anthropic-messages';
  entry.basePath = '/ai-gateway/anthropic';
  entry.endpoint.protocolEvidence = { advertised: entry.endpoint.protocolEvidence?.advertised ?? [],
    native: entry.endpoint.protocolEvidence?.native ?? [], reason: 'runtime-accepted' };
}

export function opaqueId(secret: string, prefix: string, ...identity: string[]): string {
  return `${prefix}_${createHmac('sha256', secret).update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; }

/** Protocol is selected from wire metadata, never from a model/provider name. */
function protocolDecision(resource: DiscoveredResource): { api: DatabricksEndpointApi; evidence: NonNullable<DatabricksEndpoint['protocolEvidence']> } {
  if (resource.measuredApi) return { api: resource.measuredApi, evidence: { advertised: [], native: [], reason: 'measured-api' } };
  const allowed = ['anthropic/v1/messages', 'openai/v1/chat/completions', 'mlflow/v1/chat/completions', 'openai/v1/responses', 'mlflow/v1/responses'];
  const supported = strings(resource.metadata.supported_api_types).filter((api) => allowed.includes(api));
  const destinations = record(record(resource.metadata.config).routing).destinations;
  const native: string[] = [];
  if (Array.isArray(destinations)) {
    for (const raw of destinations) {
      const destination = record(raw);
      if (destination.is_deleted === true || destination.traffic_percentage === 0) continue;
      native.push(...strings(record(record(destination.external_model_config).target).native_api_types));
    }
  }
  const anthropic = supported.includes('anthropic/v1/messages');
  const openai = supported.some((api) => ['openai/v1/chat/completions', 'mlflow/v1/chat/completions'].includes(api));
  const decision = (api: DatabricksEndpointApi, reason: NonNullable<DatabricksEndpoint['protocolEvidence']>['reason']) =>
    ({ api, evidence: { advertised: supported, native: native.filter((api) => allowed.includes(api)), reason } });
  if (anthropic && native.length > 0 && native.every((api) => api === 'anthropic/v1/messages')) return decision('anthropic-messages', 'native-api');
  if (openai && native.length > 0 && native.every((api) => api === 'openai/v1/chat/completions')) return decision('openai-completions', 'native-api');
  if (anthropic && !openai) return decision('anthropic-messages', 'advertised-api');
  if (openai && !anthropic) return decision('openai-completions', 'advertised-api');
  // Both surfaces are advertised: avoid translating native thinking/tool blocks.
  if (anthropic && openai && !native.length) return decision('anthropic-messages', 'prefer-messages');
  if (!strings(resource.metadata.supported_api_types).length && resource.kind === 'serving-endpoint' && resource.metadata.task === 'llm/v1/chat') return decision('openai-completions', 'chat-task');
  return decision(null, 'unresolved');
}

export function classifyProtocol(resource: DiscoveredResource): DatabricksEndpointApi {
  return protocolDecision(resource).api;
}

/** Read only model identity fields, not destination aliases or provider credentials. */
function servedModels(resource: DiscoveredResource): Array<{ name?: string; metadata: Record<string, unknown> }> {
  const models: Array<{ name?: string; metadata: Record<string, unknown> }> = [];
  const add = (value: unknown, metadata: Record<string, unknown>) => {
    models.push({ ...(typeof value === 'string' && value.trim() ? { name: value } : {}), metadata });
  };
  const config = record(resource.metadata.config);
  if (resource.measuredApi) add(resource.name, {});
  if (resource.kind === 'uc-model-service') {
    const destinations = record(config.routing).destinations;
    if (Array.isArray(destinations)) for (const raw of destinations) {
      const destination = record(raw);
      if (destination.is_deleted === true || destination.traffic_percentage === 0) continue;
      const target = record(record(destination.external_model_config).target);
      add(target.model, target);
    }
  } else {
    const entities = config.served_entities ?? config.served_models;
    if (Array.isArray(entities)) for (const raw of entities) {
      const entity = record(raw);
      const external = record(entity.external_model);
      const foundation = record(entity.foundation_model);
      add(external.name ?? foundation.name ?? entity.entity_name ?? entity.model_name, { ...entity, ...external, ...foundation });
    }
  }
  // Databricks foundation endpoint IDs are documented model IDs, unlike arbitrary
  // user-created endpoint aliases. No alias guessing for custom serving endpoints.
  if (!models.length && resource.kind === 'serving-endpoint' && resource.metadata.endpoint_type === 'FOUNDATION_MODEL_API') {
    add(resource.name.replace(/^databricks-/, ''), {});
  }
  return models;
}

export function normalizeResource(secret: string, profileId: string, resource: DiscoveredResource, previous?: CatalogueEntry): CatalogueEntry {
  const id = opaqueId(secret, 'dbe', profileId, resource.kind, resource.name);
  const { api, evidence: protocolEvidence } = protocolDecision(resource);
  const ready = record(resource.metadata.state).ready;
  const unavailable = ready != null && ready !== 'READY';
  const models = servedModels(resource);
  const modelName = [...new Set(models.flatMap((model) => model.name ? [model.name] : []))].join(', ') || undefined;
  const capabilities = resolveDatabricksCapabilities(resource.metadata, models);
  const endpoint: DatabricksEndpoint = {
    id, profileId, label: databricksEndpointLabel(modelName ?? resource.name), displayName: resource.name,
    ...(modelName ? { servedModelName: modelName } : {}),
    kind: resource.kind, availability: unavailable ? 'unavailable' : api ? 'compatible' : 'verification-required',
    api, protocolEvidence, enabled: previous?.endpoint.enabled ?? false,
    appModelId: opaqueId(secret, 'dbm', id),
    capabilities,
    evidence: Object.values(capabilities.limitSources!).includes('model-table') ? 'recipe' : 'metadata',
    reasoningOptions: resolveDatabricksReasoningOptions(api, models),
    ...(!api ? { issue: { code: 'DATABRICKS_VERIFICATION_REQUIRED' as const, action: 'verify' as const, retryable: false } } : {}),
  };
  const configurationId = opaqueId(secret, 'dbcfg', JSON.stringify(resource.metadata), resource.measuredApi ?? '');
  const wireCapabilities = previous?.configurationId === configurationId && previous.wireCapabilities
    ? { ...previous.wireCapabilities } : undefined;
  // A rescan/lookup is the recovery path for registrations learned before body
  // completion was checked, even when workspace metadata has not changed.
  if (wireCapabilities?.tools === 'supported' && wireCapabilities.toolsCompletionVersion !== 1) delete wireCapabilities.tools;
  if (wireCapabilities?.tools) endpoint.capabilities.tools = wireCapabilities.tools;
  if (previous?.configurationId === configurationId && previous.wireCapabilities?.outputLimit !== undefined) {
    endpoint.capabilities.maxTokens = previous.wireCapabilities.outputLimit;
    endpoint.capabilities.limitSources!.maxTokens = 'endpoint';
  }
  const entry: CatalogueEntry = {
    endpoint, upstreamName: resource.name, configurationId,
    ...(wireCapabilities ? { wireCapabilities } : {}),
    basePath: api === 'anthropic-messages' ? '/ai-gateway/anthropic'
      : resource.kind === 'serving-endpoint' ? `/serving-endpoints/${encodeURIComponent(resource.name)}/invocations` : '/ai-gateway/openai/v1',
  };
  applyLearnedDatabricksProtocol(entry);
  return entry;
}
