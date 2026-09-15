import { randomUUID } from 'node:crypto';
import type {
  DatabricksAuthState, DatabricksCapabilities, DatabricksDisableRequest, DatabricksEnableRequest,
  DatabricksLoginRequest, DatabricksLoginResponse,
  DatabricksEndpointApi, DatabricksEndpointResponse, DatabricksLookupRequest, DatabricksModelResponse,
  DatabricksModelsRequest, DatabricksModelsResponse, DatabricksProbeRequest, DatabricksProfilesResponse,
  DatabricksRegisteredEndpoint, DatabricksScanEvent, DatabricksScanPageRequest, DatabricksScanRequest,
  DatabricksScanResponse, DatabricksSetupRequest, DatabricksSetupResponse, DatabricksStatusResponse, DatabricksVerificationResponse, DatabricksVerifyRequest,
} from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError, issueFor, withDeadline, type DatabricksClientOptions } from './client.js';
import { DatabricksCredentials, type DatabricksConnectionBinding } from './credentials.js';
import { DatabricksLogins, type DatabricksLoginOptions } from './login.js';
import { applyLearnedDatabricksProtocol, normalizeResource, opaqueId, type CatalogueEntry, type DatabricksWireCapabilities } from './catalogue.js';
import { lookupResource, objectValue, requestJson, scanWorkspace, type DatabricksFetch, type WorkspaceScanOptions } from './scan.js';
import { DatabricksStore, type CatalogueGeneration } from './store.js';
import { EncryptedConnectionSecretStorage, type ConnectionSecretStorage } from './secret-storage.js';

/** INTERNAL ONLY: launch-time material. Never return through HTTP, SSE, CLI, or logs. */
export interface DatabricksRuntimeResolution {
  appModelId: string;
  endpointId: string;
  profileId: string;
  api: Exclude<DatabricksEndpointApi, null>;
  baseUrl: string;
  model: string;
  apiKey: string;
  onAuthRejected?: () => Promise<void>;
  wireCapabilities?: DatabricksWireCapabilities;
  onCapabilitiesLearned?: (learned: DatabricksWireCapabilities) => Promise<void>;
  compat: { forceAdaptiveThinking?: true };
  capabilities: DatabricksCapabilities;
  reasoningOptions: string[];
}

/** Routes consume only these frozen DTO methods. resolveRuntime is daemon-private. */
export interface DatabricksService {
  status(): Promise<DatabricksStatusResponse>;
  setup(request: DatabricksSetupRequest): Promise<DatabricksSetupResponse>;
  startLogin(request: DatabricksLoginRequest): Promise<DatabricksLoginResponse>;
  getLogin(loginId: string): Promise<DatabricksLoginResponse>;
  cancelLogin(loginId: string): Promise<DatabricksLoginResponse>;
  probe(request?: DatabricksProbeRequest): Promise<DatabricksProfilesResponse>;
  startScan(request: DatabricksScanRequest): Promise<DatabricksScanResponse>;
  getScan(scanId: string, page?: DatabricksScanPageRequest): Promise<DatabricksScanResponse>;
  subscribeScan(scanId: string, listener: (event: DatabricksScanEvent) => void): Promise<() => void>;
  cancelScan(scanId: string): Promise<DatabricksScanResponse>;
  lookup(request: DatabricksLookupRequest): Promise<DatabricksEndpointResponse>;
  listModels(request?: DatabricksModelsRequest): Promise<DatabricksModelsResponse>;
  enable(endpointId: string, request: DatabricksEnableRequest): Promise<DatabricksModelResponse>;
  disable(endpointId: string, request: DatabricksDisableRequest): Promise<DatabricksModelsResponse>;
  verify(endpointId: string, request: DatabricksVerifyRequest): Promise<DatabricksVerificationResponse>;
  disconnect(profileId: string): Promise<DatabricksStatusResponse>;
  resolveRuntime(appModelId: string): Promise<DatabricksRuntimeResolution>;
}

export interface DatabricksServiceOptions {
  dataRoot: string;
  secretStorage?: ConnectionSecretStorage;
  client?: DatabricksClient;
  clientOptions?: DatabricksClientOptions;
  fetch?: DatabricksFetch;
  now?: () => number;
  safetyMarginMs?: number;
  loginOptions?: DatabricksLoginOptions;
  scanOptions?: Pick<WorkspaceScanOptions, 'requestTimeoutMs' | 'branchTimeoutMs' | 'maxPages' | 'maxResources'>;
  /** Trusted owner-side reference resolver. The public request never contains an FQN. */
  resolveResource?: (resourceId: string, profileId: string) => Promise<string | null>;
}

interface ScanJob { snapshot: DatabricksScanResponse; controller: AbortController; finished: Promise<void>; }
const terminal = (scan: DatabricksScanResponse) => !['queued', 'running'].includes(scan.state);

export function createDatabricksService(options: DatabricksServiceOptions): DatabricksService {
  return new LocalDatabricksService(options);
}

export class LocalDatabricksService implements DatabricksService {
  private readonly store: DatabricksStore;
  private readonly client: DatabricksClient;
  private readonly credentials: DatabricksCredentials;
  private readonly logins: DatabricksLogins;
  private readonly now: () => number;
  private readonly fetch: DatabricksFetch;
  private readonly auth = new Map<string, DatabricksAuthState>();
  private readonly jobs = new Map<string, ScanJob>();
  private readonly listeners = new Map<string, Set<(event: DatabricksScanEvent) => void>>();
  private readonly cursors = new Map<string, { scanId: string; revision: number; offset: number }>();
  private inspection: Promise<void> | undefined;
  private inspectionIssues: DatabricksProfilesResponse['issues'] = [];

  constructor(private readonly options: DatabricksServiceOptions) {
    this.store = new DatabricksStore(options.dataRoot);
    this.client = options.client ?? new DatabricksClient(options.clientOptions);
    this.now = options.now ?? Date.now;
    this.logins = new DatabricksLogins(this.client, async (host, profileName, signal) => {
      const generation = await this.store.update((next) => {
        if (signal.aborted) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
        const id = opaqueId(next.secret, 'dbc', profileName, host);
        next.bindings.push({ id, profileName, host, isDefault: false });
      });
      const binding = generation.bindings.find((entry) => entry.profileName === profileName && entry.host === host)!;
      this.auth.set(binding.id, 'authenticated');
      return binding.id;
    }, options.loginOptions);
    this.credentials = new DatabricksCredentials(this.client, this.now, options.safetyMarginMs,
      options.secretStorage ?? new EncryptedConnectionSecretStorage(options.dataRoot));
    this.fetch = async (url, init) => {
      const response = await (options.fetch ?? fetch)(url, init);
      if (response.status === 401) {
        for (const binding of (await this.store.read()).bindings) {
          if (binding.mode === 'workspace-token' && binding.host === new URL(url).origin) {
            await this.invalidate(binding, new Headers(init.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '');
          }
        }
      }
      return response;
    };
  }

  private async binding(profileId: string, generation?: CatalogueGeneration): Promise<DatabricksConnectionBinding> {
    const binding = (generation ?? await this.store.read()).bindings.find((entry) => entry.id === profileId);
    if (!binding) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    return binding;
  }

  private inspect(): Promise<void> {
    return this.inspection ??= this.inspectProfiles();
  }

  private async inspectProfiles(): Promise<void> {
    this.inspectionIssues = [];
    if ((await this.client.probe()).cli !== 'ready') return;
    try {
      const payload = objectValue(await this.client.json(['auth', 'profiles', '--output', 'json']));
      if (!Array.isArray(payload.profiles)) throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED');
      const discovered = payload.profiles.map((raw) => {
        const profile = objectValue(raw);
        if (typeof profile.name !== 'string' || !profile.name || typeof profile.host !== 'string') throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED');
        let url: URL;
        try { url = new URL(profile.host); }
        catch { throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED');
        return { profileName: profile.name, host: url.origin, isDefault: profile.is_default === true };
      });
      const generation = await this.store.update((next) => {
        for (const profile of discovered) {
          const id = opaqueId(next.secret, 'dbc', profile.profileName, profile.host);
          if (!next.bindings.some((binding) => binding.id === id)) next.bindings.push({ id, ...profile });
        }
      });
      await Promise.all(generation.bindings.filter((binding) => binding.mode !== 'workspace-token').map(async (binding) => {
        try { await this.authenticate(binding); }
        catch (error) { this.inspectionIssues.push(issueFor(error)); }
      }));
    } catch (error) { this.inspectionIssues.push(issueFor(error)); }
  }

  private async bearer(binding: DatabricksConnectionBinding): Promise<string> {
    if (binding.mode !== 'workspace-token') await this.inspect();
    return this.authenticate(binding);
  }

  private async invalidate(binding: DatabricksConnectionBinding, rejectedToken?: string): Promise<void> {
    // An old relay or a CLI profile on the same host must not revoke a replacement token.
    if (rejectedToken !== undefined && !this.credentials.matches(binding, rejectedToken)) return;
    this.auth.set(binding.id, 'auth-required');
    await this.credentials.forget(binding);
  }

  private async validateWorkspaceToken(binding: DatabricksConnectionBinding, token: string): Promise<void> {
    try {
      // Identity bodies are discarded, including any upstream echo of the token.
      const identity = await requestJson({ binding, bearer: token, fetch: this.fetch,
        ...this.options.scanOptions }, '/api/2.0/preview/scim/v2/Me');
      if (typeof identity.id !== 'string' || !identity.id) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    } catch (error) {
      if (issueFor(error).code === 'DATABRICKS_AUTH_REQUIRED') await this.invalidate(binding);
      throw error;
    }
  }

  private async authenticate(binding: DatabricksConnectionBinding): Promise<string> {
    try {
      const token = await this.credentials.acquire(binding);
      if (binding.mode === 'workspace-token' && this.auth.get(binding.id) !== 'authenticated') await this.validateWorkspaceToken(binding, token);
      this.auth.set(binding.id, 'authenticated');
      return token;
    } catch (error) {
      const code = issueFor(error).code;
      this.auth.set(binding.id, code === 'DATABRICKS_KEYRING_UNAVAILABLE' ? 'keyring-unavailable'
        : code === 'DATABRICKS_CLI_UNSUPPORTED' ? 'unsupported-auth'
        : code === 'DATABRICKS_UPSTREAM_UNAVAILABLE' ? 'unreachable' : 'auth-required');
      throw error;
    }
  }

  async status(): Promise<DatabricksStatusResponse> {
    await this.inspect();
    const generation = await this.store.read();
    const restoreIssues: DatabricksStatusResponse['issues'] = [];
    for (const binding of generation.bindings) {
      const auth = this.auth.get(binding.id);
      // Packaged starts the daemon before Electron's provider; absence must not stick for the session.
      if (binding.mode === 'workspace-token' && (auth === undefined || auth === 'keyring-unavailable' || auth === 'unreachable')) {
        try { await this.authenticate(binding); }
        catch (error) { restoreIssues.push(issueFor(error)); }
      }
    }
    const persistenceIssues: DatabricksStatusResponse['issues'] = generation.bindings.some((binding) => this.credentials.persistenceUnavailable(binding))
      ? [{ code: 'DATABRICKS_KEYRING_UNAVAILABLE', action: 'sign-in', retryable: true }] : [];
    const cli = this.client.status();
    const priority = (binding: DatabricksConnectionBinding) => (this.auth.get(binding.id) === 'authenticated' ? 4 : 0)
      + (binding.mode !== 'workspace-token' ? 2 : 0) + (binding.isDefault ? 1 : 0);
    const bindings = generation.bindings.sort((a, b) => priority(b) - priority(a));
    const profiles = bindings.map((binding, index) => ({
      id: binding.id, label: binding.profileName || 'Workspace connection', workspaceLabel: binding.host,
      displayName: binding.profileName || 'Workspace connection', workspaceDisplayLabel: binding.host,
      isDefault: index === 0, auth: this.auth.get(binding.id) ?? (binding.mode === 'workspace-token' ? 'auth-required' : 'unchecked') as DatabricksAuthState,
    }));
    const setupRequired = !profiles.some((profile) => profile.auth === 'authenticated');
    return {
      ...cli, profiles, setupRequired, auth: setupRequired ? profiles[0]?.auth ?? 'auth-required' : 'authenticated',
      enabledCount: generation.entries.filter((entry) => entry.endpoint.enabled).length,
      issues: [...persistenceIssues, ...(setupRequired ? [...this.inspectionIssues, ...restoreIssues,
        issueFor(new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED'))] : [])],
    };
  }

  async probe(request: DatabricksProbeRequest = {}): Promise<DatabricksProfilesResponse> {
    this.inspection = this.inspectProfiles();
    await this.inspection;
    const issues = [...this.inspectionIssues];
    try {
      if (request.profileId) await this.bearer(await this.binding(request.profileId));
    } catch (error) { issues.push(issueFor(error)); }
    return { profiles: (await this.status()).profiles, issues };
  }

  async startLogin(request: DatabricksLoginRequest): Promise<DatabricksLoginResponse> { return this.logins.start(request); }
  async getLogin(loginId: string): Promise<DatabricksLoginResponse> { return this.logins.get(loginId); }
  async cancelLogin(loginId: string): Promise<DatabricksLoginResponse> { return this.logins.cancel(loginId); }

  async setup(request: DatabricksSetupRequest): Promise<DatabricksSetupResponse> {
    let profileId: string;
    if (request.mode === 'cli-profile') {
      await this.inspect();
      const selectedId = request.profileId ?? (await this.status()).profiles.find((profile) => profile.auth === 'authenticated')?.id;
      if (!selectedId) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
      profileId = selectedId;
      const binding = await this.binding(profileId);
      if (binding.mode === 'workspace-token') throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
      await this.bearer(binding);
    } else {
      if (request.mode !== 'workspace-token' || typeof request.host !== 'string' || typeof request.token !== 'string'
        || !/^[\x21-\x7e]{1,8192}$/.test(request.token) || request.profileId !== undefined) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
      let url: URL;
      try { url = new URL(request.host); }
      catch { throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
      const generation = await this.store.read();
      const binding: DatabricksConnectionBinding = {
        id: opaqueId(generation.secret, 'dbc', 'workspace-token', url.origin), mode: 'workspace-token',
        profileName: '', host: url.origin, isDefault: false,
      };
      // Validate before saving; a rejected replacement also erases the old credential.
      await this.validateWorkspaceToken(binding, request.token);
      await this.store.update((next) => {
        if (!next.bindings.some((entry) => entry.id === binding.id)) next.bindings.push(binding);
      });
      await this.credentials.setWorkspaceToken(binding, request.token);
      this.auth.set(binding.id, 'authenticated');
      profileId = binding.id;
    }
    const status = await this.status();
    return { profile: status.profiles.find((profile) => profile.id === profileId)!, status };
  }

  private snapshot(profileId: string): DatabricksScanResponse {
    return {
      scanId: randomUUID(), profileId, revision: 0, state: 'queued', createdAt: new Date(this.now()).toISOString(),
      startedAt: null, completedAt: null, endpoints: [], cursor: null,
      counters: { scopesChecked: 0, scopesInaccessible: 0, candidates: 0, excluded: 0 },
      completeness: { serving: false, uc: false, truncated: false }, issues: [],
    };
  }

  private emit(snapshot: DatabricksScanResponse): void {
    const event: DatabricksScanEvent = { type: terminal(snapshot) ? 'done' : 'snapshot', revision: snapshot.revision, scan: structuredClone(snapshot) };
    for (const listener of this.listeners.get(snapshot.scanId) ?? []) listener(structuredClone(event));
  }

  async startScan(request: DatabricksScanRequest): Promise<DatabricksScanResponse> {
    const generation = await this.store.read();
    const binding = await this.binding(request.profileId, generation);
    if ([...this.jobs.values()].some((job) => job.snapshot.profileId === binding.id && !terminal(job.snapshot))) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
    const scopeNames = request.scopeIds?.map((id) => {
      const scope = generation.scopes.find((entry) => entry.id === id && entry.profileId === binding.id);
      if (!scope) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
      return scope.name;
    });
    const snapshot = this.snapshot(binding.id);
    const job: ScanJob = { snapshot, controller: new AbortController(), finished: Promise.resolve() };
    this.jobs.set(snapshot.scanId, job);
    job.finished = this.runScan(job, binding, scopeNames);
    return structuredClone(snapshot);
  }

  private async runScan(job: ScanJob, binding: DatabricksConnectionBinding, scopeNames?: string[]): Promise<void> {
    const snapshot = job.snapshot;
    snapshot.state = 'running'; snapshot.startedAt = new Date(this.now()).toISOString(); snapshot.revision++;
    this.emit(snapshot);
    try {
      const token = await withDeadline(() => this.bearer(binding), this.options.scanOptions?.branchTimeoutMs ?? 60_000, job.controller.signal);
      const result = await scanWorkspace({
        ...this.options.scanOptions, binding, bearer: token, fetch: this.fetch, signal: job.controller.signal,
        ...(scopeNames ? { scopeNames } : {}),
      });
      snapshot.counters = result.counters; snapshot.completeness = result.completeness; snapshot.issues = result.issues;
      snapshot.state = result.cancelled ? 'cancelled' : result.completeness.serving && result.completeness.uc && !result.completeness.truncated ? 'complete' : 'partial';
      snapshot.completedAt = new Date(this.now()).toISOString(); snapshot.revision++;
      await this.store.update((generation) => {
        if (!generation.bindings.some((entry) => entry.id === binding.id)) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
        const candidates = result.resources.map((resource) => normalizeResource(generation.secret, binding.id, resource,
          generation.entries.find((entry) => entry.endpoint.profileId === binding.id && entry.upstreamName === resource.name && entry.endpoint.kind === resource.kind)));
        snapshot.endpoints = candidates.map((entry) => entry.endpoint);
        if (snapshot.state !== 'cancelled') {
          for (const candidate of candidates) {
            const existing = generation.entries.findIndex((entry) => entry.endpoint.id === candidate.endpoint.id);
            if (existing < 0) generation.entries.push(candidate); else generation.entries[existing] = candidate;
          }
          if (snapshot.state === 'complete' && !scopeNames) {
            for (const entry of generation.entries) {
              if (entry.endpoint.profileId === binding.id && !candidates.some((candidate) => candidate.endpoint.id === entry.endpoint.id)) entry.endpoint.availability = 'stale';
            }
          }
          for (const name of result.scopes) {
            const id = opaqueId(generation.secret, 'dbs', binding.id, name);
            if (!generation.scopes.some((scope) => scope.id === id)) generation.scopes.push({ id, profileId: binding.id, name });
          }
        }
        generation.scans.push(structuredClone(snapshot));
      });
    } catch (error) {
      snapshot.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      snapshot.completedAt = new Date(this.now()).toISOString(); snapshot.revision++;
      snapshot.issues = [issueFor(error)];
    }
    this.emit(snapshot);
  }

  async getScan(scanId: string, page: DatabricksScanPageRequest = {}): Promise<DatabricksScanResponse> {
    const generation = await this.store.read();
    const stored = generation.scans.find((scan) => scan.scanId === scanId);
    const scan = structuredClone(stored ?? this.jobs.get(scanId)?.snapshot);
    if (!scan) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    const cursor = page.cursor ? this.cursors.get(page.cursor) : undefined;
    if (page.cursor && (!cursor || cursor.scanId !== scanId || cursor.revision !== scan.revision)) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
    const limit = page.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    const offset = cursor?.offset ?? 0;
    const count = scan.endpoints.length;
    scan.endpoints = scan.endpoints.slice(offset, offset + limit);
    scan.cursor = null;
    if (offset + limit < count) {
      scan.cursor = randomUUID();
      this.cursors.set(scan.cursor, { scanId, revision: scan.revision, offset: offset + limit });
    }
    return scan;
  }

  async subscribeScan(scanId: string, listener: (event: DatabricksScanEvent) => void): Promise<() => void> {
    // Subscribe before reading so an asynchronous completion cannot fall into a gap.
    const listeners = this.listeners.get(scanId) ?? new Set();
    this.listeners.set(scanId, listeners);
    let revision = -1;
    const ordered = (event: DatabricksScanEvent) => { if (event.revision > revision) { revision = event.revision; listener(event); } };
    listeners.add(ordered);
    try {
      const scan = await this.getScan(scanId, { limit: 1000 });
      ordered({ type: terminal(scan) ? 'done' : 'snapshot', revision: scan.revision, scan });
    } catch (error) { listeners.delete(ordered); throw error; }
    return () => { listeners.delete(ordered); if (!listeners.size) this.listeners.delete(scanId); };
  }

  async cancelScan(scanId: string): Promise<DatabricksScanResponse> {
    const job = this.jobs.get(scanId);
    if (job && !terminal(job.snapshot)) { job.controller.abort(); await job.finished; }
    return this.getScan(scanId);
  }

  async lookup(request: DatabricksLookupRequest): Promise<DatabricksEndpointResponse> {
    const binding = await this.binding(request.profileId);
    const generation = await this.store.read();
    const known = generation.entries.find((entry) => entry.endpoint.id === request.resourceId && entry.endpoint.profileId === binding.id && entry.endpoint.kind === request.kind);
    const name = known?.upstreamName ?? await this.options.resolveResource?.(request.resourceId, binding.id);
    if (!name) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    const resource = await lookupResource({ ...this.options.scanOptions, binding, bearer: await this.bearer(binding), fetch: this.fetch }, request.kind, name);
    const snapshot = this.snapshot(binding.id);
    snapshot.state = 'partial'; snapshot.startedAt = snapshot.createdAt; snapshot.completedAt = new Date(this.now()).toISOString(); snapshot.revision = 1;
    const saved = await this.store.update((next) => {
      const entry = normalizeResource(next.secret, binding.id, resource, known);
      next.entries = next.entries.filter((candidate) => candidate.endpoint.id !== entry.endpoint.id);
      next.entries.push(entry); snapshot.endpoints = [entry.endpoint]; snapshot.counters.candidates = 1;
      next.scans.push(snapshot);
    });
    const endpoint = saved.scans.find((scan) => scan.scanId === snapshot.scanId)!.endpoints[0]!;
    return { endpoint, scanId: snapshot.scanId, revision: snapshot.revision };
  }

  async listModels(request: DatabricksModelsRequest = {}): Promise<DatabricksModelsResponse> {
    const generation = await this.store.read();
    return { revision: generation.revision, issues: [], models: generation.entries.map((entry) => entry.endpoint)
      .filter((endpoint): endpoint is DatabricksRegisteredEndpoint => endpoint.enabled && !!endpoint.appModelId && (!request.profileId || endpoint.profileId === request.profileId)) };
  }

  private candidate(generation: CatalogueGeneration, endpointId: string, request: DatabricksEnableRequest): { entry: CatalogueEntry; scan: DatabricksScanResponse } {
    const scan = generation.scans.find((item) => item.scanId === request.scanId);
    if (!scan || scan.state === 'cancelled' || scan.state === 'failed') throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    if (scan.revision !== request.expectedRevision) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
    const entry = generation.entries.find((item) => item.endpoint.id === endpointId);
    if (!entry || !scan.endpoints.some((endpoint) => endpoint.id === endpointId)) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    const latest = [...generation.scans].reverse().find((item) => item.state !== 'cancelled' && item.state !== 'failed' && item.endpoints.some((endpoint) => endpoint.id === endpointId));
    if (latest?.scanId !== scan.scanId) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
    return { entry, scan };
  }

  async enable(endpointId: string, request: DatabricksEnableRequest): Promise<DatabricksModelResponse> {
    const generation = await this.store.update((next) => {
      const { entry } = this.candidate(next, endpointId, request);
      if (!entry.endpoint.api) throw new DatabricksServiceError('DATABRICKS_UNSUPPORTED_DIALECT');
      if (entry.endpoint.availability !== 'compatible') throw new DatabricksServiceError('DATABRICKS_VERIFICATION_REQUIRED');
      entry.endpoint.enabled = true;
    });
    const endpoint = generation.entries.find((entry) => entry.endpoint.id === endpointId)!.endpoint as DatabricksRegisteredEndpoint;
    return { endpoint, appModelId: endpoint.appModelId, revision: generation.revision };
  }

  async disable(endpointId: string, request: DatabricksDisableRequest): Promise<DatabricksModelsResponse> {
    await this.store.update((generation) => {
      if (generation.revision !== request.expectedRevision) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
      const entry = generation.entries.find((candidate) => candidate.endpoint.id === endpointId);
      if (!entry) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
      entry.endpoint.enabled = false;
    });
    return this.listModels();
  }

  async resolveRuntime(appModelId: string): Promise<DatabricksRuntimeResolution> {
    const generation = await this.store.read();
    const entry = generation.entries.find((candidate) => candidate.endpoint.appModelId === appModelId && candidate.endpoint.enabled);
    if (!entry) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    if (entry.endpoint.availability !== 'compatible') throw new DatabricksServiceError('DATABRICKS_VERIFICATION_REQUIRED');
    return this.runtime(entry);
  }

  private async runtime(entry: CatalogueEntry): Promise<DatabricksRuntimeResolution> {
    if (!entry.endpoint.api) throw new DatabricksServiceError('DATABRICKS_UNSUPPORTED_DIALECT');
    const binding = await this.binding(entry.endpoint.profileId);
    const apiKey = await this.bearer(binding);
    return {
      appModelId: entry.endpoint.appModelId!, endpointId: entry.endpoint.id, profileId: binding.id,
      api: entry.endpoint.api, baseUrl: `${binding.host}${entry.basePath}`, model: entry.upstreamName,
      apiKey,
      ...(entry.wireCapabilities ? { wireCapabilities: entry.wireCapabilities } : {}),
      onCapabilitiesLearned: async (learned) => {
        await this.store.update((generation) => {
          const current = generation.entries.find((candidate) => candidate.endpoint.id === entry.endpoint.id);
          if (!current || current.configurationId !== entry.configurationId) return;
          current.wireCapabilities = learned;
          applyLearnedDatabricksProtocol(current);
          if (learned.tools) current.endpoint.capabilities.tools = learned.tools;
          for (const scan of generation.scans) {
            scan.endpoints = scan.endpoints.map(endpoint => endpoint.id === current.endpoint.id
              ? { ...endpoint, api: current.endpoint.api,
                ...(current.endpoint.protocolEvidence ? { protocolEvidence: structuredClone(current.endpoint.protocolEvidence) } : {}),
                capabilities: { ...endpoint.capabilities, tools: current.endpoint.capabilities.tools } } : endpoint);
          }
          if (learned.outputLimit !== undefined) {
            current.endpoint.capabilities.maxTokens = learned.outputLimit;
            current.endpoint.capabilities.limitSources = {
              contextWindow: current.endpoint.capabilities.limitSources?.contextWindow ?? 'unknown', maxTokens: 'endpoint',
            };
          }
        });
      },
      ...(binding.mode === 'workspace-token' ? { onAuthRejected: () => this.invalidate(binding, apiKey) } : {}),
      compat: entry.endpoint.api === 'anthropic-messages' ? { forceAdaptiveThinking: true } : {},
      capabilities: entry.endpoint.capabilities, reasoningOptions: entry.endpoint.reasoningOptions?.map((option) => option.id) ?? [],
    };
  }

  async verify(endpointId: string, request: DatabricksVerifyRequest): Promise<DatabricksVerificationResponse> {
    if (request.allowInference !== true) throw new DatabricksServiceError('DATABRICKS_VERIFICATION_REQUIRED');
    const { entry } = this.candidate(await this.store.read(), endpointId, request);
    const runtime = await this.runtime(entry);
    const checks: DatabricksVerificationResponse['checks'] = { streaming: 'not-run', tools: 'not-run', effort: 'not-run' };
    let issue: DatabricksVerificationResponse['issue'];
    for (const check of ['streaming', 'tools', 'effort'] as const) {
      try { checks[check] = await this.verifyCheck(runtime, check) ? 'passed' : 'failed'; }
      catch (error) { checks[check] = 'inconclusive'; issue = issueFor(error); }
    }
    const result = Object.values(checks).every((check) => check === 'passed') ? 'passed'
      : Object.values(checks).some((check) => check === 'failed') ? 'failed' : 'inconclusive';
    const saved = await this.store.update((generation) => {
      const { entry: current, scan } = this.candidate(generation, endpointId, request);
      current.endpoint.capabilities.tools = checks.tools === 'passed' ? 'supported' : checks.tools === 'failed' ? 'unsupported' : 'unknown';
      current.endpoint.availability = result === 'passed' ? 'compatible' : 'verification-required';
      if (result === 'passed') { current.endpoint.evidence = 'verified'; delete current.endpoint.issue; }
      else current.endpoint.issue = issue ?? issueFor(new DatabricksServiceError('DATABRICKS_VERIFICATION_REQUIRED'));
      scan.endpoints = scan.endpoints.map((endpoint) => endpoint.id === endpointId ? structuredClone(current.endpoint) : endpoint);
      scan.revision++;
    });
    const scan = saved.scans.find((candidate) => candidate.scanId === request.scanId)!;
    this.emit(scan);
    return { endpoint: scan.endpoints.find((endpoint) => endpoint.id === endpointId)!, scanId: scan.scanId, revision: scan.revision, result, checks, ...(issue ? { issue } : {}) };
  }

  private async verifyCheck(runtime: DatabricksRuntimeResolution, check: keyof DatabricksVerificationResponse['checks']): Promise<boolean> {
    return withDeadline(async (signal) => {
      const anthropic = runtime.api === 'anthropic-messages';
      const body: Record<string, unknown> = {
        model: runtime.model, messages: [{ role: 'user', content: check === 'tools' ? 'Call the readable_probe tool with ok true.' : 'Reply with OK.' }],
        stream: check === 'streaming', [anthropic ? 'max_tokens' : 'max_completion_tokens']: 256,
      };
      if (check === 'tools') {
        const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
        body.tools = anthropic ? [{ name: 'readable_probe', description: 'Check tool support.', input_schema: schema }]
          : [{ type: 'function', function: { name: 'readable_probe', description: 'Check tool support.', parameters: schema } }];
        body.tool_choice = anthropic ? { type: 'tool', name: 'readable_probe' } : { type: 'function', function: { name: 'readable_probe' } };
      }
      if (check === 'effort') {
        if (anthropic) { body.thinking = { type: 'adaptive' }; body.output_config = { effort: 'high' }; }
        else body.reasoning_effort = 'high';
      }
      const response = await this.fetch(`${runtime.baseUrl}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}) }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 400) return false;
        throw new DatabricksServiceError(response.status === 403 ? 'DATABRICKS_PERMISSION_DENIED' : response.status === 401 ? 'DATABRICKS_AUTH_REQUIRED' : response.status === 429 ? 'DATABRICKS_RATE_LIMITED' : 'DATABRICKS_UPSTREAM_UNAVAILABLE', true);
      }
      if (check === 'streaming') {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) return false;
        const stream = await response.text();
        return /data:\s*(?:\[DONE\]|\{[^\n]*"type"\s*:\s*"message_stop")/.test(stream);
      }
      const payload = objectValue(await response.json());
      if (check === 'tools') {
        if (anthropic) return Array.isArray(payload.content) && payload.content.some((raw) => {
          const content = objectValue(raw);
          return content.type === 'tool_use' && content.name === 'readable_probe' && objectValue(content.input).ok === true;
        });
        const choices = payload.choices;
        if (!Array.isArray(choices)) return false;
        return choices.some((raw) => {
          const calls = objectValue(objectValue(raw).message).tool_calls;
          return Array.isArray(calls) && calls.some((call) => {
            const fn = objectValue(objectValue(call).function);
            return fn.name === 'readable_probe' && typeof fn.arguments === 'string' && objectValue(JSON.parse(fn.arguments)).ok === true;
          });
        });
      }
      return anthropic ? payload.type === 'message' && Array.isArray(payload.content) : Array.isArray(payload.choices) && payload.choices.length > 0;
    }, this.options.scanOptions?.requestTimeoutMs ?? 15_000);
  }

  async disconnect(profileId: string): Promise<DatabricksStatusResponse> {
    const binding = await this.binding(profileId);
    const jobs = [...this.jobs.values()].filter((job) => job.snapshot.profileId === profileId && !terminal(job.snapshot));
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.finished));
    await this.credentials.forget(binding);
    this.auth.delete(profileId);
    await this.store.update((generation) => {
      generation.bindings = generation.bindings.filter((entry) => entry.id !== profileId);
      generation.entries = generation.entries.filter((entry) => entry.endpoint.profileId !== profileId);
      generation.scopes = generation.scopes.filter((entry) => entry.profileId !== profileId);
      generation.scans = generation.scans.filter((scan) => scan.profileId !== profileId);
    });
    for (const [id, job] of this.jobs) if (job.snapshot.profileId === profileId) { this.jobs.delete(id); this.listeners.delete(id); }
    return this.status();
  }
}

export { DatabricksServiceError } from './client.js';
