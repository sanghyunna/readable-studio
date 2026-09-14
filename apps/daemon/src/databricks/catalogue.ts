import { createHmac } from 'node:crypto';
import type { DatabricksEndpoint, DatabricksEndpointApi } from '@readable-studio/contracts';
import type { DiscoveredResource } from './scan.js';
import { databricksEndpointLabel, resolveDatabricksCapabilities, resolveDatabricksReasoningOptions } from './capabilities.js';

/** Daemon-private catalogue: routing and UI identities, never arbitrary upstream metadata. */
export interface CatalogueEntry {
  endpoint: DatabricksEndpoint;
  upstreamName: string;
  basePath: string;
}

export function opaqueId(secret: string, prefix: string, ...identity: string[]): string {
  return `${prefix}_${createHmac('sha256', secret).update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; }

/** Protocol is selected from wire metadata, never from a model/provider name. */
export function classifyProtocol(resource: DiscoveredResource): DatabricksEndpointApi {
  const supported = strings(resource.metadata.supported_api_types);
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
  if (anthropic && native.length > 0 && native.every((api) => api === 'anthropic/v1/messages')) return 'anthropic-messages';
  if (anthropic && !openai) return 'anthropic-messages';
  if (openai && !anthropic) return 'openai-completions';
  if (openai && native.length > 0 && native.every((api) => api === 'openai/v1/chat/completions')) return 'openai-completions';
  if (resource.kind === 'serving-endpoint' && resource.metadata.task === 'llm/v1/chat') return 'openai-completions';
  return null;
}

/** Read only model identity fields, not destination aliases or provider credentials. */
function servedModels(resource: DiscoveredResource): Array<{ name?: string; metadata: Record<string, unknown> }> {
  const models: Array<{ name?: string; metadata: Record<string, unknown> }> = [];
  const add = (value: unknown, metadata: Record<string, unknown>) => {
    models.push({ ...(typeof value === 'string' && value.trim() ? { name: value } : {}), metadata });
  };
  const config = record(resource.metadata.config);
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
      add(external.name ?? entity.entity_name ?? entity.model_name, { ...entity, ...external });
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
  const api = classifyProtocol(resource);
  const ready = record(resource.metadata.state).ready;
  const unavailable = ready != null && ready !== 'READY';
  const models = servedModels(resource);
  const modelName = [...new Set(models.flatMap((model) => model.name ? [model.name] : []))].join(', ') || undefined;
  const capabilities = resolveDatabricksCapabilities(resource.metadata, models);
  const endpoint: DatabricksEndpoint = {
    id, profileId, label: databricksEndpointLabel(modelName ?? resource.name), displayName: resource.name,
    ...(modelName ? { servedModelName: modelName } : {}),
    kind: resource.kind, availability: unavailable ? 'unavailable' : api ? 'compatible' : 'verification-required',
    api, enabled: previous?.endpoint.enabled ?? false,
    appModelId: opaqueId(secret, 'dbm', id),
    capabilities,
    evidence: Object.values(capabilities.limitSources!).includes('model-table') ? 'recipe' : 'metadata',
    reasoningOptions: resolveDatabricksReasoningOptions(api, models),
    ...(!api ? { issue: { code: 'DATABRICKS_VERIFICATION_REQUIRED' as const, action: 'verify' as const, retryable: false } } : {}),
  };
  return {
    endpoint, upstreamName: resource.name,
    basePath: resource.kind === 'serving-endpoint' ? '/serving-endpoints'
      : api === 'anthropic-messages' ? '/ai-gateway/anthropic' : '/ai-gateway/openai/v1',
  };
}
