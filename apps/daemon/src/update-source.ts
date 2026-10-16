import type { UpdateManifest, UpdateUnavailableReason } from '@readable-studio/contracts';
import { compareUpdateVersions } from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError } from './databricks/client.js';
import { DatabricksCredentials, type DatabricksConnectionBinding } from './databricks/credentials.js';
import { createUpdateHttpClient } from './update-http.js';

export class UpdateSourceError extends Error {
  constructor(readonly reason: UpdateUnavailableReason, readonly host?: string) { super(reason); }
}
export type UpdateTokenProvider = (serverUrl: string, force?: boolean) => Promise<{ token: string; host: string }>;

function tokenFailure(error: unknown, host?: string): UpdateSourceError {
  return new UpdateSourceError(error instanceof DatabricksServiceError && error.code === 'DATABRICKS_AUTH_REQUIRED'
    ? 'not-logged-in' : error instanceof DatabricksServiceError && error.code === 'DATABRICKS_PERMISSION_DENIED'
      ? 'forbidden' : 'unreachable', host);
}

/**
 * App domains do not encode the workspace origin. Probe DEFAULT first, then
 * configured CLI profiles; accept only the workspace whose Apps list contains
 * this exact app URL. Never send a workspace bearer to an unconfirmed app.
 */
function createUpdateTokenProvider(): UpdateTokenProvider {
  const client = new DatabricksClient();
  const credentials = new DatabricksCredentials(client, () => Date.now());
  let binding: DatabricksConnectionBinding | undefined;
  let pending: Promise<DatabricksConnectionBinding> | undefined;
  const discover = async (serverUrl: string): Promise<DatabricksConnectionBinding> => {
    const probe = await client.probe();
    if (probe.cli !== 'ready') throw new UpdateSourceError('unreachable');
    let profiles: { name: string; host: string }[] = [];
    try {
      const raw = await client.json(['auth', 'profiles', '--output', 'json']) as { profiles?: { name: string; host: string }[] };
      profiles = (raw.profiles ?? []).filter((p) => typeof p.name === 'string' && typeof p.host === 'string');
    } catch (error) { throw tokenFailure(error); }
    profiles.sort((a, b) => Number(b.name === 'DEFAULT') - Number(a.name === 'DEFAULT'));
    let authenticated = false;
    let failure: UpdateSourceError | undefined;
    for (const profile of profiles) {
      try {
        const raw = await client.json(['apps', 'list', '--profile', profile.name, '--output', 'json']) as { apps?: { url?: string }[] } | { url?: string }[];
        authenticated = true;
        const apps = Array.isArray(raw) ? raw : raw.apps ?? [];
        if (!apps.some((app) => app.url?.replace(/\/+$/, '') === serverUrl)) continue;
        return { id: profile.name, profileName: profile.name, host: profile.host, isDefault: profile.name === 'DEFAULT' };
      } catch (error) {
        const fault = tokenFailure(error, profile.host);
        if (!failure || fault.reason !== 'not-logged-in') failure = fault;
      }
    }
    if (failure && failure.reason !== 'not-logged-in') throw failure;
    throw new UpdateSourceError(authenticated ? 'app-not-accessible' : 'not-logged-in', authenticated ? undefined : profiles[0]?.host);
  };
  return async (serverUrl, force = false) => {
    if (!binding) {
      pending ??= discover(serverUrl);
      try { binding = await pending; }
      finally { pending = undefined; }
    }
    const confirmed = binding;
    try {
      const bearer = await credentials.acquireToken(confirmed, force, async () => {
        const raw = await client.json(['auth', 'profiles', '--output', 'json']) as { profiles?: { name: string; host: string }[] };
        const profile = raw.profiles?.find((entry) => entry.name === confirmed.profileName);
        if (!profile || new URL(profile.host).origin !== new URL(confirmed.host).origin) {
          binding = undefined;
          throw new DatabricksServiceError(profile ? 'DATABRICKS_UPSTREAM_UNAVAILABLE' : 'DATABRICKS_AUTH_REQUIRED', !!profile);
        }
      });
      return { token: bearer.token, host: confirmed.host };
    } catch (error) { throw tokenFailure(error, confirmed.host); }
  };
}
export const acquireUpdateToken: UpdateTokenProvider = (serverUrl, force) => createUpdateTokenProvider()(serverUrl, force);

export class DatabricksUpdateSource {
  constructor(readonly base: string, private readonly token: UpdateTokenProvider = createUpdateTokenProvider(), private readonly fetcher?: typeof fetch) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    let bearer = await this.token(this.base);
    const client = this.fetcher ? undefined : createUpdateHttpClient();
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${bearer.token}`);
      const send = () => (this.fetcher ?? client!.fetch)(`${this.base}/api/v1/${path}`, {
        ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000),
        headers: Object.fromEntries(headers.entries()),
      });
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        bearer = await this.token(this.base, true);
        headers.set('Authorization', `Bearer ${bearer.token}`);
        response = await send();
      }
      if (response.status === 401) throw new UpdateSourceError('not-logged-in', bearer.host);
      if (response.status === 403) throw new UpdateSourceError('forbidden');
      if (response.status === 404) throw new UpdateSourceError('no-release');
      if (!response.ok) throw new UpdateSourceError('unreachable');
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
      throw new UpdateSourceError('unreachable');
    }
  }

  async latest(): Promise<UpdateManifest> {
    let value: UpdateManifest;
    try { value = await (await this.request('latest')).json() as UpdateManifest; }
    catch (error) { if (error instanceof UpdateSourceError) throw error; throw new UpdateSourceError('invalid-response'); }
    if (!value || compareUpdateVersions(value.version, value.version) === null
      || value.fileName !== 'Readable-Studio-win-x64-portable.zip'
      || !Number.isSafeInteger(value.size) || value.size <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.notes !== 'string' || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) throw new UpdateSourceError('invalid-response');
    return value;
  }

  async health(): Promise<void> {
    const value = await (await this.request('health')).json() as Record<string, unknown>;
    if (!value || value.ok !== true || value.service !== 'readable-studio-update-server' || value.apiVersion !== 1) throw new UpdateSourceError('invalid-response');
  }
}
