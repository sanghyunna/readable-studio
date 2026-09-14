import type { DatabricksEndpointKind, DatabricksIssue, DatabricksScanCompleteness, DatabricksScanCounters } from '@readable-studio/contracts';
import { DatabricksServiceError, issueFor, withDeadline } from './client.js';
import type { DatabricksConnectionBinding } from './credentials.js';

export type DatabricksFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface DiscoveredResource {
  kind: DatabricksEndpointKind;
  name: string;
  metadata: Record<string, unknown>;
}
export interface WorkspaceScanResult {
  resources: DiscoveredResource[];
  scopes: string[];
  counters: DatabricksScanCounters;
  completeness: DatabricksScanCompleteness;
  issues: DatabricksIssue[];
  cancelled: boolean;
}
export interface WorkspaceScanOptions {
  binding: DatabricksConnectionBinding;
  bearer: string;
  fetch: DatabricksFetch;
  signal?: AbortSignal;
  scopeNames?: string[];
  requestTimeoutMs?: number;
  branchTimeoutMs?: number;
  maxPages?: number;
  maxResources?: number;
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  return value as Record<string, unknown>;
}

export async function requestJson(options: WorkspaceScanOptions, path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withDeadline(async (bounded) => {
    let response: Response;
    try {
      response = await options.fetch(new URL(path, options.binding.host).toString(), {
        headers: { Authorization: `Bearer ${options.bearer}`, Accept: 'application/json' }, signal: bounded, redirect: 'error',
      });
    } catch { throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true); }
    if (!response.ok) {
      throw new DatabricksServiceError(response.status === 401 ? 'DATABRICKS_AUTH_REQUIRED'
        : response.status === 403 ? 'DATABRICKS_PERMISSION_DENIED'
        : response.status === 429 ? 'DATABRICKS_RATE_LIMITED' : 'DATABRICKS_UPSTREAM_UNAVAILABLE', response.status >= 429);
    }
    try { return objectValue(await response.json()); }
    catch { throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true); }
  }, options.requestTimeoutMs ?? 10_000, signal ?? options.signal);
}

export async function lookupResource(options: WorkspaceScanOptions, kind: DatabricksEndpointKind, name: string): Promise<DiscoveredResource> {
  const path = kind === 'uc-model-service' ? `/api/2.1/unity-catalog/model-services/${encodeURIComponent(name)}`
    : `/api/2.0/serving-endpoints/${encodeURIComponent(name)}`;
  const metadata = await requestJson(options, path);
  return { kind, name, metadata };
}

export async function scanWorkspace(options: WorkspaceScanOptions): Promise<WorkspaceScanResult> {
  const result: WorkspaceScanResult = {
    resources: [], scopes: [], counters: { scopesChecked: 0, scopesInaccessible: 0, candidates: 0, excluded: 0 },
    completeness: { serving: false, uc: false, truncated: false }, issues: [], cancelled: false,
  };
  let active = true;
  const recordIssue = (error: unknown) => {
    if (!active) return;
    const issue = issueFor(error);
    if (!result.issues.some((entry) => entry.code === issue.code)) result.issues.push(issue);
    result.counters.scopesInaccessible++;
    if (issue.code === 'DATABRICKS_UPSTREAM_UNAVAILABLE') result.completeness.truncated = true;
  };
  const check = (signal: AbortSignal) => {
    if (!active || signal.aborted) throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  };
  const add = (resource: DiscoveredResource, signal: AbortSignal) => {
    check(signal);
    if (result.resources.length >= (options.maxResources ?? 10_000)) {
      result.completeness.truncated = true;
      throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
    }
    result.counters.candidates++;
    if (resource.metadata.task === 'llm/v1/embeddings' || resource.metadata.task === 'llm/v1/completions') result.counters.excluded++;
    else if (!result.resources.some((entry) => entry.kind === resource.kind && entry.name === resource.name)) result.resources.push(resource);
  };
  const pages = async (path: string, field: string, signal: AbortSignal, visit: (record: Record<string, unknown>) => Promise<void>) => {
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < (options.maxPages ?? 100); page++) {
      check(signal);
      const url = new URL(path, options.binding.host);
      if (token) url.searchParams.set('page_token', token);
      const payload = await requestJson(options, `${url.pathname}${url.search}`, signal);
      check(signal);
      // Empty arrays may be omitted by protobuf JSON encoders.
      const records = payload[field] ?? [];
      if (!Array.isArray(records)) throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
      for (const record of records) { check(signal); await visit(objectValue(record)); }
      const next = payload.next_page_token;
      if (next == null || next === '') return;
      if (typeof next !== 'string' || tokens.has(next)) break;
      tokens.add(next);
      token = next;
    }
    result.completeness.truncated = true;
    throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  };
  const resourceName = (record: Record<string, unknown>): string => {
    if (typeof record.name !== 'string' || !record.name) throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
    return record.name;
  };
  const branch = async (work: (signal: AbortSignal) => Promise<void>) => {
    try { await withDeadline(work, options.branchTimeoutMs ?? 60_000, options.signal); }
    catch (error) { if (!options.signal?.aborted) recordIssue(error); }
  };
  await Promise.all([
    branch(async (signal) => {
      result.counters.scopesChecked++;
      await pages('/api/2.0/serving-endpoints', 'endpoints', signal, async (metadata) => {
        add({ kind: 'serving-endpoint', name: resourceName(metadata), metadata }, signal);
      });
      check(signal);
      result.completeness.serving = true;
    }),
    branch(async (signal) => {
      let complete = true;
      const schema = async (parent: string) => {
        check(signal);
        result.scopes.push(parent);
        if (options.scopeNames && !options.scopeNames.includes(parent)) return;
        result.counters.scopesChecked++;
        try {
          await pages(`/api/2.1/unity-catalog/model-services?parent=${encodeURIComponent(`schemas/${parent}`)}&view=FULL`, 'model_services', signal, async (record) => {
            const name = resourceName(record).replace(/^model-services\//, '');
            try {
              const resource = await lookupResource({ ...options, signal }, 'uc-model-service', name);
              add(resource, signal);
            } catch (error) {
              check(signal);
              complete = false;
              recordIssue(error);
              // Retain the candidate without claiming protocol compatibility.
              add({ kind: 'uc-model-service', name, metadata: record }, signal);
            }
          });
        } catch (error) { check(signal); complete = false; recordIssue(error); }
      };
      if (options.scopeNames) {
        for (const parent of options.scopeNames) await schema(parent);
      } else {
        result.counters.scopesChecked++;
        await pages('/api/2.1/unity-catalog/catalogs', 'catalogs', signal, async (catalog) => {
          const catalogName = resourceName(catalog);
          result.counters.scopesChecked++;
          try {
            await pages(`/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalogName)}`, 'schemas', signal, async (record) => {
              await schema(`${catalogName}.${resourceName(record)}`);
            });
          } catch (error) { check(signal); complete = false; recordIssue(error); }
        });
      }
      check(signal);
      result.completeness.uc = complete;
    }),
  ]);
  active = false;
  result.cancelled = options.signal?.aborted ?? false;
  return result;
}
