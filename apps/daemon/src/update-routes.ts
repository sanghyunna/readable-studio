import type { Express, Request, Response } from 'express';
import { compareUpdateVersions, type AutoUpdateConfig, type UpdateCheckResult, type UpdateConnectionFailure, type UpdateConnectionReport, type UpdateConnectionStep, type UpdateUnavailableReason } from '@readable-studio/contracts';
import { readCurrentAppVersionInfo } from './app-version.js';
import { DatabricksUpdateSource, resolveUpdateConfigDefaults, UpdateSourceError, type UpdateTokenProvider, type UpdateTraceEvent } from './update-source.js';
import { readAppConfig } from './app-config.js';
import { resolve } from 'node:path';
import { updateDownload } from './update-download.js';
import { DatabricksServiceError, withDeadline } from './databricks/client.js';

export interface UpdateCheckDependencies {
  fetch?: typeof fetch;
  currentVersion?: () => Promise<string>;
  config?: (signal?: AbortSignal) => Promise<AutoUpdateConfig>;
  token?: UpdateTokenProvider;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Optional injected deadline; normal workspace discovery has none. */
  connectionTimeoutMs?: number;
  signal?: AbortSignal;
}
function connectionFailure(error: unknown): UpdateConnectionFailure {
  if (!(error instanceof UpdateSourceError)) return 'invalid-response';
  if (error.failure) return error.failure;
  const legacy: Partial<Record<UpdateUnavailableReason, UpdateConnectionFailure>> = {
    'not-logged-in': 'not-logged-in', forbidden: 'forbidden', 'app-not-accessible': 'workspace-not-found',
    'no-release': 'not-update-server', timeout: 'timeout', 'invalid-response': 'invalid-response',
  };
  return legacy[error.reason] ?? 'unreachable';
}
function legacyReason(failure: UpdateConnectionFailure | undefined): UpdateUnavailableReason {
  switch (failure) {
    case 'not-logged-in': case 'forbidden': case 'timeout': return failure;
    case 'workspace-not-found': return 'app-not-accessible';
    case 'dns': case 'unreachable': case 'app-stopped': case 'cli-missing': return 'unreachable';
    default: return 'invalid-response';
  }
}
/**
 * Workspace discovery has no elapsed-time cutoff; the requester owns cancellation.
 */
export async function diagnoseUpdateConnection(input: unknown, deps: UpdateCheckDependencies = {}, options: { latest?: boolean } = {}): Promise<UpdateConnectionReport> {
  const timeoutMs = deps.connectionTimeoutMs ?? 0;
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const steps: UpdateConnectionStep[] = [];
  const report: UpdateConnectionReport = { ok: false, serverUrl: null, timeoutMs, elapsedMs: 0, steps };
  const done = (failure?: UpdateConnectionFailure) => {
    if (failure) report.failure = failure; else report.ok = true;
    report.elapsedMs = elapsed();
    return report;
  };
  const text = typeof input === 'string' ? input.trim() : '';
  let url: URL | undefined;
  try { url = new URL(text); } catch { url = undefined; }
  const invalid = !url ? 'invalid-url' : url.protocol !== 'https:' ? 'not-https'
    : url.username || url.password || url.search || url.hash ? 'invalid-url' : undefined;
  if (!url || invalid) {
    steps.push({ step: 'url', ok: false, elapsedMs: 0, detail: url ? `${url.protocol}//${url.host}${url.pathname}` : text ? 'not a URL' : 'empty' });
    return done(invalid ?? 'invalid-url');
  }
  const serverUrl = url.href.replace(/\/+$/, '');
  report.serverUrl = serverUrl;
  steps.push({ step: 'url', ok: true, elapsedMs: 0, detail: serverUrl });
  let settled = false;
  const trace = (event: UpdateTraceEvent) => {
    if (settled) return;
    const { cli, profile, host, ...step } = event;
    steps.push(step);
    if (cli) report.cli = cli;
    if (profile) report.profile = profile;
    if (host) report.host = host;
  };
  try {
    await withDeadline(async (signal) => {
      const source = new DatabricksUpdateSource(serverUrl, deps.token, deps.fetch, { trace, signal });
      await source.health();
      if (options.latest === false) return;
      let latest: string | null;
      try { latest = (await source.latest()).version; }
      catch (error) { if (error instanceof UpdateSourceError && error.reason === 'no-release' && !error.failure) latest = null; else throw error; }
      if (!settled) report.latest = latest;
    }, timeoutMs || null, deps.signal);
    settled = true;
    return done();
  } catch (error) {
    settled = true;
    if (error instanceof DatabricksServiceError && error.diagnostic?.category === 'timeout') {
      steps.push({ step: 'timeout', ok: false, elapsedMs: elapsed(), detail: `no answer within ${timeoutMs} ms` });
      return done('timeout');
    }
    if (deps.signal?.aborted) return done('unreachable');
    if (error instanceof UpdateSourceError && error.host && !report.host) report.host = error.host;
    return done(connectionFailure(error));
  }
}
export async function updateConfig(signal?: AbortSignal): Promise<AutoUpdateConfig> {
  return resolveUpdateConfigDefaults((await readAppConfig(process.env.READABLE_DATA_DIR ?? resolve('.readable-studio'))).autoUpdate ?? { enabled: false, serverUrl: null }, undefined, signal);
}
export async function checkForUpdate(deps: UpdateCheckDependencies = {}, automatic = false): Promise<UpdateCheckResult> {
  const config = await (deps.config ?? updateConfig)(deps.signal);
  if (automatic && !config.enabled) return { unavailable: 'disabled' };
  if (!config.serverUrl) return { unavailable: 'not-configured' };
  try {
    const manifest = await new DatabricksUpdateSource(config.serverUrl, deps.token, deps.fetch, deps.signal ? { signal: deps.signal } : {}).latest();
    const current = await (deps.currentVersion ?? (async () => (await readCurrentAppVersionInfo()).version))();
    const comparison = compareUpdateVersions(manifest.version, current);
    if (comparison === null) return { unavailable: 'invalid-response' };
    return { current, latest: manifest.version, isNewer: comparison > 0, assetName: manifest.fileName, assetSize: manifest.size,
      sha256: manifest.sha256, releaseUrl: config.serverUrl, notes: manifest.notes, checkedAt: new Date().toISOString() };
  } catch (error) {
    return error instanceof UpdateSourceError ? { unavailable: error.reason, ...(error.host ? { host: error.host } : {}) } : { unavailable: 'unreachable' };
  }
}
export function updateRequestSignal(req: Request, res: Response, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (req.aborted || res.destroyed && !res.writableEnded) { controller.abort(); return controller.signal; }
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
    req.removeListener('aborted', abort);
  });
  return parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
}
export function registerUpdateRoutes(app: Express, deps: UpdateCheckDependencies = {}): void {
  app.get('/api/update/check', async (req, res) => {
    const download = process.env.READABLE_UPDATE_ROOT ? updateDownload(process.env.READABLE_UPDATE_ROOT) : undefined;
    download?.checking();
    const result = await checkForUpdate({ ...deps, signal: updateRequestSignal(req, res, deps.signal) }, req.query.automatic === '1');
    await download?.checked(result);
    res.json(result);
  });
  app.post('/api/update/health', async (req, res) => {
    const signal = updateRequestSignal(req, res, deps.signal);
    const value: unknown = req.body?.serverUrl ?? (await (deps.config ?? updateConfig)(signal)).serverUrl;
    if (typeof value !== 'string') { res.status(400).json({ error: 'not-configured' }); return; }
    const report = await diagnoseUpdateConnection(value, { ...deps, signal }, { latest: false });
    if (report.ok) { res.json({ ok: true }); return; }
    const error = legacyReason(report.failure);
    res.status(400).json({ error, ...(error === 'not-logged-in' && report.host ? { host: report.host } : {}), failure: report.failure });
  });
  app.post('/api/update/connection', async (req, res) => {
    const signal = updateRequestSignal(req, res, deps.signal);
    const value: unknown = req.body?.serverUrl ?? (await (deps.config ?? updateConfig)(signal)).serverUrl;
    res.json(await diagnoseUpdateConnection(value, { ...deps, signal }));
  });
}
