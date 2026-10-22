import type { AutoUpdateConfig, UpdateConnectionFailure, UpdateConnectionReport, UpdateConnectionStep, UpdateManifest, UpdateUnavailableReason } from '@readable-studio/contracts';
import { compareUpdateVersions } from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError, resolveDatabricksCli, withDeadline, type DatabricksExecutable, type DatabricksSubprocessRunner } from './databricks/client.js';
import { DatabricksCredentials, type DatabricksConnectionBinding } from './databricks/credentials.js';
import { createUpdateHttpClient } from './update-http.js';

/** `reason` is the legacy check/health vocabulary; `failure` is the finer connection-check classification. */
export class UpdateSourceError extends Error {
  constructor(readonly reason: UpdateUnavailableReason, readonly host?: string, readonly failure?: UpdateConnectionFailure) { super(reason); }
}
/** A diagnostic step plus facts the connection report lifts out. Never carries a token. */
export type UpdateTraceEvent = UpdateConnectionStep & { cli?: UpdateConnectionReport['cli']; profile?: string; host?: string };
export interface UpdateTraceContext { trace?: (event: UpdateTraceEvent) => void; signal?: AbortSignal }
export type UpdateTokenProvider = (serverUrl: string, force?: boolean, context?: UpdateTraceContext) => Promise<{ token: string; host: string }>;

const since = (start: number) => Math.max(0, Math.round(performance.now() - start));
const errorCode = (error: unknown) => error instanceof DatabricksServiceError ? error.code : error instanceof Error ? error.name : 'unknown';

function tokenFailure(error: unknown, host?: string): UpdateSourceError {
  if (error instanceof UpdateSourceError) return error;
  const code = error instanceof DatabricksServiceError ? error.code : undefined;
  return code === 'DATABRICKS_AUTH_REQUIRED' ? new UpdateSourceError('not-logged-in', host, 'not-logged-in')
    : code === 'DATABRICKS_PERMISSION_DENIED' ? new UpdateSourceError('forbidden', host, 'forbidden')
      : code === 'DATABRICKS_CLI_MISSING' || code === 'DATABRICKS_CLI_UNSUPPORTED' ? new UpdateSourceError('unreachable', host, 'cli-missing')
        : new UpdateSourceError('unreachable', host, 'unreachable');
}

function networkFailure(error: unknown): UpdateConnectionFailure {
  const fault = error as { name?: string; message?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  const code = fault?.cause?.code;
  if (fault?.name === 'TimeoutError' || fault?.name === 'AbortError' || fault?.cause?.name === 'TimeoutError'
    || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns';
  // Databricks Apps redirect requests without a valid workspace bearer to the sign-in page.
  if (/redirect/i.test(`${fault?.message ?? ''} ${fault?.cause?.message ?? ''}`)) return 'not-logged-in';
  return 'unreachable';
}
function networkDetail(error: unknown): string {
  const fault = error as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  return [fault?.cause?.code ?? fault?.name, fault?.cause?.message ?? fault?.message].filter(Boolean).join(': ') || 'network error';
}

export interface UpdateTokenProviderOptions {
  resolveCli?: (override?: string | null) => Promise<DatabricksExecutable | null>;
  runner?: DatabricksSubprocessRunner;
  /** Unauthenticated reachability probe of the app host; any HTTP answer counts as reachable. Resolves or throws a network error. */
  reach?: (serverUrl: string, signal?: AbortSignal, fetcher?: typeof fetch) => Promise<void>;
}

function updateAppUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/[\s\\\x00-\x1f\x7f]/.test(text)) return null;
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port && url.pathname === '/'
      ? url.origin : null;
  } catch { return null; }
}

/** Let the CLI select its current workspace; App URLs cannot be derived from workspace hosts. */
export function createDefaultUpdateServerResolver(options: Pick<UpdateTokenProviderOptions, 'resolveCli' | 'runner'> = {}): () => Promise<string | null> {
  let cached: { url: string | null; expiresAt: number } | undefined;
  let pending: Promise<string | null> | undefined;
  const discover = async (): Promise<string | null> => {
    const client = new DatabricksClient({
      resolveExecutable: options.resolveCli ?? (() => resolveDatabricksCli()),
      ...(options.runner ? { runner: options.runner } : {}),
      timeoutMs: 5000,
    });
    try {
      return await withDeadline(async (signal) => {
        if ((await client.probe()).cli !== 'ready' || signal.aborted) return null;
        const app = await client.json(['apps', 'get', 'readable-studio-updates', '--output', 'json'], signal);
        if (!app || typeof app !== 'object' || !('url' in app) || typeof app.url !== 'string' || !app.url.trim()
          || ('name' in app && app.name !== 'readable-studio-updates')) return null;
        return updateAppUrl(app.url);
      }, 10_000);
    } catch { return null; }
  };
  return () => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.url);
    pending ??= discover().then((url) => {
      cached = { url, expiresAt: Date.now() + 60_000 };
      return url;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

const defaultUpdateServer = createDefaultUpdateServerResolver();

export async function resolveUpdateConfigDefaults(config: AutoUpdateConfig, resolveServer = defaultUpdateServer): Promise<AutoUpdateConfig> {
  if (config.serverUrl) return config;
  const serverUrl = await resolveServer();
  return serverUrl ? { enabled: true, serverUrl } : config;
}

async function probeReachable(serverUrl: string, signal?: AbortSignal, fetcher?: typeof fetch): Promise<void> {
  const client = fetcher ? undefined : createUpdateHttpClient();
  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await (fetcher ?? client!.fetch)(`${serverUrl}/api/v1/health`, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout } as { signal: AbortSignal });
    await response.body?.cancel();
  } finally { await client?.destroy(); }
}

/**
 * App domains do not encode the workspace origin. Probe DEFAULT first, then
 * configured CLI profiles; accept only the workspace whose Apps list contains
 * this exact app URL. Never send a workspace bearer to an unconfirmed app.
 */
export function createUpdateTokenProvider(options: UpdateTokenProviderOptions = {}): UpdateTokenProvider {
  let resolvedCli: DatabricksExecutable | null = null;
  const resolveCli = options.resolveCli ?? ((override?: string | null) => resolveDatabricksCli(override));
  const client = new DatabricksClient({
    resolveExecutable: async (override) => (resolvedCli = await resolveCli(override)),
    ...(options.runner ? { runner: options.runner } : {}),
  });
  const credentials = new DatabricksCredentials(client, () => Date.now());
  let binding: DatabricksConnectionBinding | undefined;
  let pending: Promise<DatabricksConnectionBinding> | undefined;
  const discover = async (serverUrl: string, context: UpdateTraceContext): Promise<DatabricksConnectionBinding> => {
    const trace = context.trace ?? (() => {});
    let start = performance.now();
    start = performance.now();
    const probe = await client.probe();
    if (probe.cli !== 'ready') {
      trace({ step: 'cli', ok: false, elapsedMs: since(start), detail: probe.cli === 'missing'
        ? 'Databricks CLI not found (neither bundled nor installed)' : `Databricks CLI ${resolvedCli?.path ?? ''} is ${probe.cli}${probe.version ? ` (v${probe.version})` : ''}` });
      throw new UpdateSourceError('unreachable', undefined, 'cli-missing');
    }
    const source = probe.cliSource === 'bundled' ? 'bundled' : probe.cliSource === 'override' ? 'override' : 'installed';
    const path = resolvedCli?.path ?? '(path not reported)';
    trace({ step: 'cli', ok: true, elapsedMs: since(start), detail: `${path} (${source}, v${probe.version ?? '?'})`, cli: { path, source, version: probe.version } });
    start = performance.now();
    let profiles: { name: string; host: string }[] = [];
    try {
      const raw = await client.json(['auth', 'profiles', '--output', 'json'], context.signal) as { profiles?: { name: string; host: string }[] };
      profiles = (raw.profiles ?? []).filter((p) => typeof p.name === 'string' && typeof p.host === 'string');
    } catch (error) {
      trace({ step: 'profiles', ok: false, elapsedMs: since(start), detail: `databricks auth profiles failed (${errorCode(error)})` });
      throw tokenFailure(error);
    }
    profiles.sort((a, b) => Number(b.name === 'DEFAULT') - Number(a.name === 'DEFAULT'));
    trace({ step: 'profiles', ok: profiles.length > 0, elapsedMs: since(start),
      detail: profiles.length ? profiles.map((p) => `${p.name} (${p.host})`).join(', ') : 'no profiles in .databrickscfg' });
    let authenticated = false;
    let failure: UpdateSourceError | undefined;
    for (const profile of profiles) {
      start = performance.now();
      const label = `${profile.name} ${profile.host}`;
      try {
        const raw = await client.json(['apps', 'list', '--profile', profile.name, '--output', 'json'], context.signal) as { apps?: { url?: string }[] } | { url?: string }[];
        authenticated = true;
        const apps = Array.isArray(raw) ? raw : raw.apps ?? [];
        if (!apps.some((app) => updateAppUrl(app.url) === serverUrl)) {
          trace({ step: 'workspace', ok: true, elapsedMs: since(start), detail: `${label}: app not listed (${apps.length} apps)` });
          continue;
        }
        trace({ step: 'workspace', ok: true, elapsedMs: since(start), detail: `${label}: app found`, profile: profile.name, host: profile.host });
        return { id: profile.name, profileName: profile.name, host: profile.host, isDefault: profile.name === 'DEFAULT' };
      } catch (error) {
        const fault = tokenFailure(error, profile.host);
        const diagnostic = error instanceof DatabricksServiceError ? error.diagnostic : undefined;
        const facts = diagnostic ? [
          `category=${diagnostic.category}`, diagnostic.cause ? `cause=${diagnostic.cause}` : '',
          diagnostic.exitCode === undefined ? '' : `exit=${diagnostic.exitCode}`,
          diagnostic.elapsedMs === undefined ? '' : `elapsed=${diagnostic.elapsedMs}ms`,
          diagnostic.stdoutBytes === undefined ? '' : `stdout=${diagnostic.stdoutBytes}B`,
          diagnostic.stderrBytes === undefined ? '' : `stderr=${diagnostic.stderrBytes}B`,
          diagnostic.nativeCode ? `native=${diagnostic.nativeCode}` : '',
        ].filter(Boolean).join(', ') : '';
        trace({ step: 'workspace', ok: false, elapsedMs: since(start),
          ...(diagnostic?.httpStatus ? { httpStatus: diagnostic.httpStatus } : {}),
          detail: `Workspace lookup failed (${errorCode(error)}${facts ? `; ${facts}` : ''})` });
        if (!failure || fault.reason !== 'not-logged-in') failure = fault;
      }
    }
    if (failure && failure.reason !== 'not-logged-in') throw failure;
    if (authenticated) {
      // Before claiming "workspace not found", confirm the host is reachable at all (unauthenticated; no token is sent).
      start = performance.now();
      try { await (options.reach ?? probeReachable)(serverUrl, context.signal); }
      catch (error) {
        trace({ step: 'health', ok: false, elapsedMs: since(start), detail: `${serverUrl} is not reachable: ${networkDetail(error)}` });
        throw new UpdateSourceError('unreachable', undefined, networkFailure(error));
      }
      trace({ step: 'workspace', ok: false, elapsedMs: 0, detail: 'no signed-in profile lists this app URL' });
      throw new UpdateSourceError('app-not-accessible', undefined, 'workspace-not-found');
    }
    throw new UpdateSourceError('not-logged-in', profiles[0]?.host, 'not-logged-in');
  };
  return async (serverUrl, force = false, context = {}) => {
    if (!binding) {
      pending ??= discover(serverUrl, context);
      try { binding = await pending; }
      finally { pending = undefined; }
    }
    const confirmed = binding;
    const start = performance.now();
    try {
      const bearer = await credentials.acquireToken(confirmed, force, async () => {
        const raw = await client.json(['auth', 'profiles', '--output', 'json']) as { profiles?: { name: string; host: string }[] };
        const profile = raw.profiles?.find((entry) => entry.name === confirmed.profileName);
        if (!profile || new URL(profile.host).origin !== new URL(confirmed.host).origin) {
          binding = undefined;
          throw new DatabricksServiceError(profile ? 'DATABRICKS_UPSTREAM_UNAVAILABLE' : 'DATABRICKS_AUTH_REQUIRED', !!profile);
        }
      });
      context.trace?.({ step: 'token', ok: true, elapsedMs: since(start), detail: `profile ${confirmed.profileName}${force ? ' (refreshed)' : ''}` });
      return { token: bearer.token, host: confirmed.host };
    } catch (error) {
      context.trace?.({ step: 'token', ok: false, elapsedMs: since(start), detail: `profile ${confirmed.profileName}: ${errorCode(error)}` });
      throw tokenFailure(error, confirmed.host);
    }
  };
}
export const acquireUpdateToken: UpdateTokenProvider = (serverUrl, force) => createUpdateTokenProvider()(serverUrl, force);

export class DatabricksUpdateSource {
  private tokenTraced = false;
  private readonly token: UpdateTokenProvider;
  constructor(readonly base: string, token?: UpdateTokenProvider, private readonly fetcher?: typeof fetch,
    private readonly context: UpdateTraceContext = {}) {
    // An injected fetch also serves the default provider's reachability probe.
    this.token = token ?? createUpdateTokenProvider(fetcher ? { reach: (url, signal) => probeReachable(url, signal, fetcher) } : {});
  }

  /** Trace token acquisition once per source, and again only for a forced refresh. */
  private bearer(force: boolean) {
    const context = this.tokenTraced && !force ? (this.context.signal ? { signal: this.context.signal } : {}) : this.context;
    this.tokenTraced = true;
    return context.trace || context.signal ? this.token(this.base, force, context) : this.token(this.base, force);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    let bearer = await this.bearer(false);
    const client = this.fetcher ? undefined : createUpdateHttpClient();
    const step = path === 'health' || path === 'latest' ? path : undefined;
    const started = performance.now();
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${bearer.token}`);
      const send = () => {
        const timeout = AbortSignal.timeout(15_000);
        return (this.fetcher ?? client!.fetch)(`${this.base}/api/v1/${path}`, {
          ...init, redirect: 'error', signal: init.signal ?? (this.context.signal ? AbortSignal.any([this.context.signal, timeout]) : timeout),
          headers: Object.fromEntries(headers.entries()),
        });
      };
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        bearer = await this.bearer(true);
        headers.set('Authorization', `Bearer ${bearer.token}`);
        response = await send();
      }
      const status = response.status;
      const fault = status === 401 ? new UpdateSourceError('not-logged-in', bearer.host, 'not-logged-in')
        : status === 403 ? new UpdateSourceError('forbidden', undefined, 'forbidden')
          : status === 404 ? new UpdateSourceError('no-release', undefined, path === 'health' ? 'not-update-server' : undefined)
            // A stopped Databricks App answers from the Apps proxy with 502/503/504.
            : status === 502 || status === 503 || status === 504 ? new UpdateSourceError('unreachable', undefined, 'app-stopped')
              : !response.ok ? new UpdateSourceError('unreachable', undefined, 'invalid-response') : undefined;
      if (step) this.context.trace?.({ step, ok: !fault || (step === 'latest' && status === 404), elapsedMs: since(started), httpStatus: status,
        detail: `GET /api/v1/${path} -> ${status}${step === 'latest' && status === 404 ? ' (no release yet)' : ''}` });
      if (fault) throw fault;
      // The transport must stay alive until a streamed body has been consumed.
      if (client) {
        const body = response.body;
        if (!body) { await client.destroy(); return response; }
        const reader = body.getReader();
        return new Response(new ReadableStream({
          async pull(controller) {
            try { const chunk = await reader.read(); if (chunk.done) { controller.close(); await client.destroy(); } else controller.enqueue(chunk.value); }
            catch (error) { controller.error(error); await client.destroy(); }
          },
          async cancel() { await reader.cancel(); await client.destroy(); },
        }), { status: response.status, headers: response.headers });
      }
      return response;
    } catch (error) {
      await client?.destroy();
      if (error instanceof UpdateSourceError) throw error;
      const failure = networkFailure(error);
      if (step) this.context.trace?.({ step, ok: false, elapsedMs: since(started), detail: `GET /api/v1/${path} failed: ${networkDetail(error)}` });
      throw new UpdateSourceError('unreachable', undefined, failure);
    }
  }

  async latest(): Promise<UpdateManifest> {
    let value: UpdateManifest;
    try { value = await (await this.request('latest')).json() as UpdateManifest; }
    catch (error) { if (error instanceof UpdateSourceError) throw error; throw new UpdateSourceError('invalid-response', undefined, 'invalid-response'); }
    if (!value || compareUpdateVersions(value.version, value.version) === null
      || value.fileName !== 'Readable-Studio-win-x64-portable.zip'
      || !Number.isSafeInteger(value.size) || value.size <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.notes !== 'string' || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) throw new UpdateSourceError('invalid-response', undefined, 'invalid-response');
    return value;
  }

  async health(): Promise<void> {
    let value: Record<string, unknown> | null;
    try { value = await (await this.request('health')).json() as Record<string, unknown> | null; }
    catch (error) { if (error instanceof UpdateSourceError) throw error; throw new UpdateSourceError('invalid-response', undefined, 'invalid-response'); }
    if (!value || value.ok !== true || value.service !== 'readable-studio-update-server' || value.apiVersion !== 1) throw new UpdateSourceError('invalid-response', undefined, 'not-update-server');
  }
}
