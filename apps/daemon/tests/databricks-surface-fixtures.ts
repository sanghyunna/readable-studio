import { createServer } from 'node:http';
import express from 'express';
import { vi, type Mock } from 'vitest';
import type {
  AppConfigPrefs, DatabricksEndpointResponse, DatabricksModelResponse, DatabricksModelsResponse, DatabricksLoginResponse,
  DatabricksRegisteredEndpoint, DatabricksScanEvent, DatabricksScanResponse,
  DatabricksStatusResponse, DatabricksVerificationResponse,
} from '@readable-studio/contracts';
import { registerDatabricksRoutes, type RegisterDatabricksRoutesDeps } from '../src/databricks-routes.js';
import { listenOnFetchCompatiblePort } from '../src/fetch-compatible-listener.js';

export const ids = { profile: `dbc_${'a'.repeat(32)}`, endpoint: `dbe_${'b'.repeat(32)}`, model: `dbm_${'c'.repeat(32)}`, scan: '11111111-1111-4111-8111-111111111111' };
export const secrets = { access_token: 'dapi-DO-NOT-EMIT', host: 'https://private-workspace.azuredatabricks.net', full_name: 'private_catalog.private_schema.private_model' };
export const endpoint: DatabricksRegisteredEndpoint = {
  id: ids.endpoint, profileId: ids.profile, label: 'claude-sonnet-5', kind: 'uc-model-service',
  displayName: secrets.full_name, servedModelName: 'claude-sonnet-5',
  availability: 'compatible', api: 'anthropic-messages', enabled: true, appModelId: ids.model,
  reasoningOptions: [{ id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }],
  capabilities: { tools: 'supported', images: 'unknown', contextWindow: null, maxTokens: null }, evidence: 'metadata',
};
export const status: DatabricksStatusResponse = {
  cli: 'ready', version: '0.280.0', auth: 'authenticated', enabledCount: 1, issues: [],
  profiles: [{ id: ids.profile, label: 'team-dev', displayName: 'team-dev', workspaceLabel: secrets.host,
    workspaceDisplayLabel: secrets.host, isDefault: false, auth: 'authenticated' }],
};
export function scan(state: DatabricksScanResponse['state'] = 'complete', revision = 2): DatabricksScanResponse {
  return { scanId: ids.scan, profileId: ids.profile, revision, state,
    createdAt: '2026-09-10T00:00:00.000Z', startedAt: '2026-09-10T00:00:00.000Z',
    completedAt: ['running', 'queued'].includes(state) ? null : '2026-09-10T00:00:01.000Z',
    endpoints: [endpoint], cursor: null, counters: { scopesChecked: 2, scopesInaccessible: 0, candidates: 1, excluded: 0 },
    completeness: { serving: state === 'complete', uc: state === 'complete', truncated: false }, issues: [],
  };
}
export function login(state: DatabricksLoginResponse['state'] = 'starting'): DatabricksLoginResponse {
  return { loginId: ids.scan, state, createdAt: '2026-09-13T00:00:00.000Z', deadlineAt: '2026-09-13T00:10:00.000Z',
    completedAt: ['starting', 'waiting-for-browser'].includes(state) ? null : '2026-09-13T00:01:00.000Z',
    profileId: state === 'authenticated' ? ids.profile : null, issues: [] };
}
export const models: DatabricksModelsResponse = { models: [endpoint], revision: 2, issues: [] };
export const model: DatabricksModelResponse = { endpoint, appModelId: ids.model, revision: 2 };
export const lookup: DatabricksEndpointResponse = { endpoint, scanId: ids.scan, revision: 2 };
export const verification: DatabricksVerificationResponse = { ...lookup, result: 'passed', checks: { streaming: 'passed', tools: 'passed', effort: 'passed' } };

/** Inject unapproved fields at every level; declared UI identity fields are allowed. */
export function contaminated<T>(value: T): T {
  if (Array.isArray(value)) return value.map(contaminated) as T;
  if (value !== null && typeof value === 'object') {
    return { ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, contaminated(entry)])), ...secrets } as T;
  }
  return value;
}

export async function bounded<T>(signal: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([signal, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expected surface event was not received')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Explicit shape so the inferred type never leaks express, qs or vitest spy internals. */
export interface SurfaceHarness {
  service: { [K in keyof RegisterDatabricksRoutesDeps['service']]: Mock<RegisterDatabricksRoutesDeps['service'][K]> };
  setClient: Mock<RegisterDatabricksRoutesDeps['setClient']>;
  guard: Mock<RegisterDatabricksRoutesDeps['http']['requireLocalDaemonRequest']>;
  unsubscribe: Mock<() => void>;
  subscribed: Promise<void>;
  saveConfig: Mock<(body: AppConfigPrefs) => void>;
  url: string;
  emit(event: DatabricksScanEvent): void;
  complete(next?: DatabricksScanResponse): void;
  close(): Promise<void>;
}

export async function surfaceHarness(initial = scan()): Promise<SurfaceHarness> {
  let snapshot = initial;
  const listeners = new Set<(event: DatabricksScanEvent) => void>();
  let subscribedResolve!: () => void;
  const subscribed = new Promise<void>((resolve) => { subscribedResolve = resolve; });
  const unsubscribe = vi.fn();
  const service = {
    status: vi.fn(async () => contaminated(status)),
    setup: vi.fn(async () => contaminated({ profile: status.profiles[0]!, status })),
    startLogin: vi.fn(async () => contaminated(login())),
    getLogin: vi.fn(async () => contaminated(login('authenticated'))),
    cancelLogin: vi.fn(async () => contaminated(login('cancelled'))),
    probe: vi.fn(async () => contaminated({ profiles: status.profiles, issues: [] })),
    startScan: vi.fn(async () => contaminated(snapshot)),
    getScan: vi.fn(async () => contaminated(snapshot)),
    subscribeScan: vi.fn(async (_id: string, listener: (event: DatabricksScanEvent) => void) => {
      listeners.add(listener);
      listener(contaminated({ type: ['running', 'queued'].includes(snapshot.state) ? 'snapshot' : 'done', revision: snapshot.revision, scan: snapshot } as DatabricksScanEvent));
      subscribedResolve();
      return () => { unsubscribe(); listeners.delete(listener); };
    }),
    cancelScan: vi.fn(async () => { snapshot = scan('cancelled', snapshot.revision + 1); return contaminated(snapshot); }),
    lookup: vi.fn(async () => contaminated(lookup)),
    listModels: vi.fn(async () => contaminated(models)),
    enable: vi.fn(async () => contaminated(model)),
    disable: vi.fn(async () => contaminated(models)),
    verify: vi.fn(async () => contaminated(verification)),
    disconnect: vi.fn(async () => contaminated(status)),
  } satisfies RegisterDatabricksRoutesDeps['service'];
  const setClient = vi.fn(async () => contaminated(status));
  const guard = vi.fn<RegisterDatabricksRoutesDeps['http']['requireLocalDaemonRequest']>((req, res, next) => {
    // Stand-in for the bootstrap-owned strict guard: these tests verify every route invokes it.
    const local = (value: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
    if (!local(`http://${req.get('host')}`) || (req.get('origin') && !local(req.get('origin')!))) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Local request required' } }); return;
    }
    next();
  });
  const app = express();
  app.use(express.json());
  registerDatabricksRoutes(app, { service, setClient, http: { requireLocalDaemonRequest: guard } });
  let config: AppConfigPrefs = { agentId: 'pi', agentModels: { pi: { model: 'direct-model', reasoning: 'high' } } };
  app.get('/api/app-config', (_req, res) => res.json({ config: { ...config, ...secrets } }));
  const saveConfig = vi.fn((body: AppConfigPrefs) => { config = { ...config, ...body }; });
  app.put('/api/app-config', (req, res) => { saveConfig(req.body as AppConfigPrefs); res.json({ config: { ...config, ...secrets } }); });
  const { server, port } = await bounded(listenOnFetchCompatiblePort(createServer(app)));
  const url = `http://127.0.0.1:${port}`;
  return {
    service, setClient, guard, unsubscribe, subscribed, saveConfig, url,
    emit(event: DatabricksScanEvent) { for (const listener of listeners) listener(contaminated(event)); },
    complete(next = scan()) {
      snapshot = next;
      for (const listener of listeners) listener(contaminated({ type: 'done', revision: next.revision, scan: next }));
    },
    async close() {
      server.closeAllConnections();
      await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    },
  };
}
