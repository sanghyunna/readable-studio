import type { Express, Request, RequestHandler } from 'express';
import {
  API_ERROR_CODES,
  type ApiErrorResponse, type DatabricksClientRequest, type DatabricksDisableRequest,
  type DatabricksEnableRequest, type DatabricksEndpoint, type DatabricksEndpointResponse,
  type DatabricksErrorResponse, type DatabricksIssue, type DatabricksLookupRequest,
  type DatabricksLoginRequest, type DatabricksLoginResponse,
  type DatabricksModelResponse, type DatabricksModelsResponse, type DatabricksProbeRequest,
  type DatabricksProfile, type DatabricksProfilesResponse, type DatabricksRegisteredEndpoint,
  type DatabricksScanEvent, type DatabricksScanPageRequest, type DatabricksScanRequest,
  type DatabricksScanResponse, type DatabricksSetupRequest, type DatabricksSetupResponse, type DatabricksStatusResponse, type DatabricksVerificationResponse,
  type DatabricksVerifyRequest,
} from '@readable-studio/contracts';
import type { DatabricksService } from './databricks/service.js';
import { databricksWorkspaceOrigin, issueFor } from './databricks/client.js';
import { DatabricksRuntimeError, serviceFailureDetail } from './databricks/failure.js';

export interface RegisterDatabricksRoutesDeps {
  http: { requireLocalDaemonRequest: RequestHandler };
  service: Omit<DatabricksService, 'resolveRuntime'>;
  /** Owner resolves the opaque executable reference privately and updates the service client. */
  setClient: (request: DatabricksClientRequest) => Promise<DatabricksStatusResponse>;
}

export class DatabricksInputError extends Error {}
const invalid = (): never => { throw new DatabricksInputError('Invalid Databricks request'); };
const invalidOutput = (): never => { throw new Error('Invalid Databricks response'); };

/** Public IDs cannot contain hostnames, resource names, paths or credentials. */
export function databricksInputId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) return invalid();
  return value;
}
function publicId(value: string): string {
  if (!/^(?:db[cems]_[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value)) return invalidOutput();
  return value;
}
function number(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return invalidOutput();
  return value;
}
function boolean(value: boolean): boolean {
  if (typeof value !== 'boolean') return invalidOutput();
  return value;
}
function choice<T extends string | null>(value: T, allowed: readonly (string | null)[]): T {
  if (!allowed.includes(value)) return invalidOutput();
  return value;
}
function timestamp(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return invalidOutput();
  return value;
}
function issue(value: DatabricksIssue): DatabricksIssue {
  return {
    code: choice(value.code, API_ERROR_CODES.filter((code) => code.startsWith('DATABRICKS_'))),
    action: choice(value.action, ['install-cli', 'choose-executable', 'sign-in', 'rescan', 'verify', 'check-permissions', 'none']),
    retryable: boolean(value.retryable),
  };
}
/** Identity text is allowed only in explicitly projected UI fields, never error details. */
function displayLabel(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalidOutput();
  return value;
}
function profile(value: DatabricksProfile): DatabricksProfile {
  const id = publicId(value.id);
  return {
    id, label: displayLabel(value.label), workspaceLabel: displayLabel(value.workspaceLabel),
    ...(value.displayName === undefined ? {} : { displayName: displayLabel(value.displayName) }),
    ...(value.workspaceDisplayLabel === undefined ? {} : { workspaceDisplayLabel: displayLabel(value.workspaceDisplayLabel) }),
    isDefault: boolean(value.isDefault),
    auth: choice(value.auth, ['unchecked', 'authenticated', 'auth-required', 'unsupported-auth', 'keyring-unavailable', 'unreachable']),
  };
}
function endpoint(value: DatabricksEndpoint): DatabricksEndpoint {
  const id = publicId(value.id);
  const kind = choice(value.kind, ['serving-endpoint', 'uc-model-service']);
  return {
    id, profileId: publicId(value.profileId), kind,
    label: displayLabel(value.label),
    ...(value.displayName === undefined ? {} : { displayName: displayLabel(value.displayName) }),
    ...(value.servedModelName === undefined ? {} : { servedModelName: displayLabel(value.servedModelName) }),
    availability: choice(value.availability, ['compatible', 'verification-required', 'unavailable', 'stale']),
    api: choice(value.api, ['openai-completions', 'anthropic-messages', null]), enabled: boolean(value.enabled),
    ...(value.appModelId === undefined ? {} : { appModelId: publicId(value.appModelId) }),
    ...(value.reasoningOptions === undefined ? {} : { reasoningOptions: value.reasoningOptions.map((option) => {
      // The catalogue owns supported levels; this boundary validates only the
      // public token shape instead of maintaining a second capability list.
      const id = option.id;
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) return invalidOutput();
      return { id, label: id === 'xhigh' ? 'Extra high' : id.charAt(0).toUpperCase() + id.slice(1) };
    }) }),
    capabilities: {
      tools: choice(value.capabilities.tools, ['supported', 'unsupported', 'unknown']),
      images: choice(value.capabilities.images, ['supported', 'unsupported', 'unknown']),
      contextWindow: value.capabilities.contextWindow === null ? null : number(value.capabilities.contextWindow),
      maxTokens: value.capabilities.maxTokens === null ? null : number(value.capabilities.maxTokens),
      ...(value.capabilities.limitSources === undefined ? {} : { limitSources: {
        contextWindow: choice(value.capabilities.limitSources.contextWindow, ['metadata', 'model-table', 'unknown']),
        maxTokens: choice(value.capabilities.limitSources.maxTokens, ['metadata', 'model-table', 'unknown', 'endpoint']),
      } }),
    },
    ...(value.protocolEvidence === undefined ? {} : { protocolEvidence: {
      advertised: value.protocolEvidence.advertised.map((api) => choice(api, ['anthropic/v1/messages', 'openai/v1/chat/completions', 'mlflow/v1/chat/completions', 'openai/v1/responses', 'mlflow/v1/responses'])),
      native: value.protocolEvidence.native.map((api) => choice(api, ['anthropic/v1/messages', 'openai/v1/chat/completions', 'mlflow/v1/chat/completions', 'openai/v1/responses', 'mlflow/v1/responses'])),
      reason: choice(value.protocolEvidence.reason, ['native-api', 'advertised-api', 'prefer-messages', 'chat-task', 'unresolved', 'runtime-accepted']),
    } }),
    evidence: choice(value.evidence, ['metadata', 'recipe', 'verified']),
    ...(value.issue === undefined ? {} : { issue: issue(value.issue) }),
  };
}
function registered(value: DatabricksRegisteredEndpoint): DatabricksRegisteredEndpoint {
  const safe = endpoint(value);
  if (safe.enabled !== true || !safe.appModelId) return invalidOutput();
  return { ...safe, enabled: true, appModelId: safe.appModelId };
}
function counters(value: DatabricksScanResponse['counters']): DatabricksScanResponse['counters'] {
  return { scopesChecked: number(value.scopesChecked), scopesInaccessible: number(value.scopesInaccessible), candidates: number(value.candidates), excluded: number(value.excluded) };
}
function completeness(value: DatabricksScanResponse['completeness']): DatabricksScanResponse['completeness'] {
  return { serving: boolean(value.serving), uc: boolean(value.uc), truncated: boolean(value.truncated) };
}
function state(value: DatabricksScanResponse['state']): DatabricksScanResponse['state'] {
  return choice(value, ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled']);
}

/** Explicit DTO projections are shared by HTTP and CLI; never serialize arbitrary service/HTTP objects. */
export const databricksPublic = {
  status(value: DatabricksStatusResponse): DatabricksStatusResponse {
    return {
      cli: choice(value.cli, ['missing', 'ready', 'unsupported', 'uninvocable']),
      ...(value.cliSource === undefined ? {} : { cliSource: value.cliSource === null ? null : choice(value.cliSource, ['override', 'path', 'bundled']) }),
      version: value.version !== null && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : null,
      auth: choice(value.auth, ['unchecked', 'authenticated', 'auth-required', 'unsupported-auth', 'keyring-unavailable', 'unreachable']),
      profiles: value.profiles.map(profile), enabledCount: number(value.enabledCount), issues: value.issues.map(issue),
      ...(value.setupRequired === undefined ? {} : { setupRequired: boolean(value.setupRequired) }),
    };
  },
  login(value: DatabricksLoginResponse): DatabricksLoginResponse {
    const createdAt = timestamp(value.createdAt);
    const deadlineAt = timestamp(value.deadlineAt);
    if (createdAt === null || deadlineAt === null) return invalidOutput();
    return { loginId: publicId(value.loginId),
      state: choice(value.state, ['starting', 'waiting-for-browser', 'authenticated', 'cancelled', 'timed-out', 'failed']),
      createdAt, deadlineAt, completedAt: timestamp(value.completedAt),
      profileId: value.profileId === null ? null : publicId(value.profileId), issues: value.issues.map(issue) };
  },
  setup(value: DatabricksSetupResponse): DatabricksSetupResponse {
    return { profile: profile(value.profile), status: databricksPublic.status(value.status) };
  },
  profiles(value: DatabricksProfilesResponse): DatabricksProfilesResponse {
    return { profiles: value.profiles.map(profile), issues: value.issues.map(issue) };
  },
  scan(value: DatabricksScanResponse): DatabricksScanResponse {
    const createdAt = timestamp(value.createdAt);
    if (createdAt === null) return invalidOutput();
    return {
      scanId: publicId(value.scanId), profileId: publicId(value.profileId), revision: number(value.revision), state: state(value.state),
      createdAt, startedAt: timestamp(value.startedAt), completedAt: timestamp(value.completedAt), endpoints: value.endpoints.map(endpoint),
      cursor: value.cursor === null ? null : publicId(value.cursor), counters: counters(value.counters), completeness: completeness(value.completeness), issues: value.issues.map(issue),
    };
  },
  event(value: DatabricksScanEvent): DatabricksScanEvent {
    const revision = number(value.revision);
    switch (value.type) {
      case 'snapshot': case 'done': return { type: value.type, revision, scan: databricksPublic.scan(value.scan) };
      case 'endpoint': return { type: value.type, revision, scanId: publicId(value.scanId), endpoint: endpoint(value.endpoint) };
      case 'progress': return { type: value.type, revision, scanId: publicId(value.scanId), state: state(value.state), counters: counters(value.counters), completeness: completeness(value.completeness), issues: value.issues.map(issue) };
      default: return invalidOutput();
    }
  },
  lookup(value: DatabricksEndpointResponse): DatabricksEndpointResponse {
    return { endpoint: endpoint(value.endpoint), scanId: publicId(value.scanId), revision: number(value.revision) };
  },
  models(value: DatabricksModelsResponse): DatabricksModelsResponse {
    return { models: value.models.map(registered), revision: number(value.revision), issues: value.issues.map(issue) };
  },
  model(value: DatabricksModelResponse): DatabricksModelResponse {
    return { endpoint: registered(value.endpoint), appModelId: publicId(value.appModelId), revision: number(value.revision) };
  },
  verification(value: DatabricksVerificationResponse): DatabricksVerificationResponse {
    const check = (result: DatabricksVerificationResponse['checks']['tools']) => choice(result, ['passed', 'failed', 'inconclusive', 'not-run']);
    return { ...databricksPublic.lookup(value), result: choice(value.result, ['passed', 'failed', 'inconclusive']),
      checks: { streaming: check(value.checks.streaming), tools: check(value.checks.tools), effort: check(value.checks.effort) },
      ...(value.issue === undefined ? {} : { issue: issue(value.issue) }) };
  },
};

export function databricksFailure(error: unknown): DatabricksErrorResponse | ApiErrorResponse {
  if (error instanceof DatabricksInputError) return { error: { code: 'BAD_REQUEST', message: 'Invalid Databricks request', retryable: false } };
  const fault = issueFor(error);
  const detail = error instanceof DatabricksRuntimeError ? error.detail : serviceFailureDetail(fault.code);
  return { error: { code: fault.code, ...detail, retryable: error instanceof DatabricksRuntimeError ? detail.retryable : fault.retryable } };
}
function input(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return invalid();
  return record;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function enableRequest(value: unknown, verify = false): DatabricksEnableRequest {
  const body = input(value, ['scanId', 'expectedRevision', ...(verify ? ['allowInference'] : [])]);
  if (verify && body.allowInference !== true) return invalid();
  return { scanId: databricksInputId(body.scanId), expectedRevision: revision(body.expectedRevision) };
}
function optionalProfile(value: unknown): DatabricksProbeRequest {
  const body = input(value, ['profileId']);
  return body.profileId === undefined ? {} : { profileId: databricksInputId(body.profileId) };
}

export function databricksLoginRequest(value: unknown): DatabricksLoginRequest {
  const body = input(value, ['host']);
  try { return { host: databricksWorkspaceOrigin(body.host) }; }
  catch { return invalid(); }
}

export function databricksSetupRequest(value: unknown): DatabricksSetupRequest {
  const body = input(value, ['mode', 'host', 'token', 'profileId']);
  if (body.mode === 'cli-profile') {
    if (body.host !== undefined || body.token !== undefined) return invalid();
    return { mode: body.mode, ...(body.profileId === undefined ? {} : { profileId: databricksInputId(body.profileId) }) };
  }
  if (body.mode !== 'workspace-token' || typeof body.host !== 'string' || typeof body.token !== 'string'
    || body.profileId !== undefined || !/^[\x21-\x7e]{1,8192}$/.test(body.token)) return invalid();
  let url: URL;
  try { url = new URL(body.host); }
  catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return invalid();
  return { mode: body.mode, host: url.origin, token: body.token };
}

export function registerDatabricksRoutes(app: Express, ctx: RegisterDatabricksRoutesDeps): void {
  const { service } = ctx;
  const noStore: RequestHandler = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  const guards = [noStore, ctx.http.requireLocalDaemonRequest];
  function route<T>(method: 'get' | 'post' | 'put' | 'delete', path: string, run: (req: Request) => Promise<T>, sanitize: (value: T) => T, status = 200): void {
    app[method](`/api/databricks${path}`, ...guards, async (req, res) => {
      try { res.status(status).json(sanitize(await run(req))); }
      catch (error) {
        const failure = databricksFailure(error);
        const code = failure.error.code;
        res.status(error instanceof DatabricksInputError ? 400 : code === 'DATABRICKS_AUTH_REQUIRED' ? 401
          : code === 'DATABRICKS_PERMISSION_DENIED' ? 403 : code === 'DATABRICKS_SCAN_EXPIRED' ? 404
          : code === 'DATABRICKS_STALE_REVISION' ? 409 : 503).json(failure);
      }
    });
  }
  route('get', '/status', () => service.status(), databricksPublic.status);
  route('post', '/setup', (req) => service.setup(databricksSetupRequest(req.body)), databricksPublic.setup);
  route('post', '/login', (req) => service.startLogin(databricksLoginRequest(req.body)), databricksPublic.login, 202);
  route('get', '/login/:loginId', (req) => service.getLogin(databricksInputId(req.params.loginId)), databricksPublic.login);
  route('delete', '/login/:loginId', (req) => service.cancelLogin(databricksInputId(req.params.loginId)), databricksPublic.login);
  route('post', '/probe', (req) => service.probe(optionalProfile(req.body)), databricksPublic.profiles);
  route('put', '/client', (req) => {
    const body = input(req.body, ['executableId']);
    const request: DatabricksClientRequest = { executableId: body.executableId === null ? null : databricksInputId(body.executableId) };
    return ctx.setClient(request);
  }, databricksPublic.status);
  route('post', '/scans', (req) => {
    const body = input(req.body, ['profileId', 'scopeIds']);
    if (body.scopeIds !== undefined && !Array.isArray(body.scopeIds)) return invalid();
    const request: DatabricksScanRequest = { profileId: databricksInputId(body.profileId),
      ...(body.scopeIds === undefined ? {} : { scopeIds: (body.scopeIds as unknown[]).map(databricksInputId) }) };
    return service.startScan(request);
  }, databricksPublic.scan, 202);
  route('get', '/scans/:scanId', (req) => {
    const query = input(req.query, ['cursor', 'limit']);
    const page: DatabricksScanPageRequest = {};
    if (query.cursor !== undefined) page.cursor = databricksInputId(query.cursor);
    if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) return invalid();
      page.limit = Number(query.limit);
      if (page.limit < 1 || page.limit > 1000) return invalid();
    }
    return service.getScan(databricksInputId(req.params.scanId), page);
  }, databricksPublic.scan);
  route('delete', '/scans/:scanId', (req) => service.cancelScan(databricksInputId(req.params.scanId)), databricksPublic.scan);
  route('post', '/lookup', (req) => {
    const body = input(req.body, ['profileId', 'resourceId', 'kind']);
    if (body.kind !== 'serving-endpoint' && body.kind !== 'uc-model-service') return invalid();
    const request: DatabricksLookupRequest = { profileId: databricksInputId(body.profileId), resourceId: databricksInputId(body.resourceId), kind: body.kind };
    return service.lookup(request);
  }, databricksPublic.lookup);
  route('get', '/models', (req) => service.listModels(optionalProfile(req.query)), databricksPublic.models);
  route('put', '/models/:endpointId', (req) => service.enable(databricksInputId(req.params.endpointId), enableRequest(req.body)), databricksPublic.model);
  route('delete', '/models/:endpointId', (req) => {
    const body = input(req.body, ['expectedRevision']);
    const request: DatabricksDisableRequest = { expectedRevision: revision(body.expectedRevision) };
    return service.disable(databricksInputId(req.params.endpointId), request);
  }, databricksPublic.models);
  route('post', '/models/:endpointId/verify', (req) => {
    const request: DatabricksVerifyRequest = { ...enableRequest(req.body, true), allowInference: true };
    return service.verify(databricksInputId(req.params.endpointId), request);
  }, databricksPublic.verification);
  route('delete', '/connections/:connectionId', (req) => service.disconnect(databricksInputId(req.params.connectionId)), databricksPublic.status);

  app.get('/api/databricks/scans/:scanId/events', ...guards, async (req, res) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const close = () => { closed = true; const release = unsubscribe; unsubscribe = undefined; release?.(); };
    res.once('close', close);
    try {
      const scanId = databricksInputId(req.params.scanId);
      // The service atomically subscribes and replays its latest snapshot, including done.
      unsubscribe = await service.subscribeScan(scanId, (raw) => {
        if (closed) return;
        try {
          const event = databricksPublic.event(raw);
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Accel-Buffering', 'no');
          }
          res.write(`id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'done') { close(); res.end(); }
        } catch (error) {
          // A projection failure is a terminal public error, not a dropped SSE
          // connection that an intermediary may leave open indefinitely.
          if (!res.headersSent) res.setHeader('Content-Type', 'text/event-stream');
          res.write(`event: error\ndata: ${JSON.stringify(databricksFailure(error))}\n\n`);
          close(); res.end();
        }
      });
      if (closed) close();
    } catch (error) {
      close();
      if (res.headersSent) res.destroy();
      else res.status(error instanceof DatabricksInputError ? 400 : 404).json(databricksFailure(error));
    }
  });
}
