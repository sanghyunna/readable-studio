import { createServer, type Server } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { serveSecretEncryption } from '@readable-studio/platform';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksScanResponse, DatabricksSetupResponse } from '@readable-studio/contracts';
import { createDatabricksService, type DatabricksService } from '../../src/databricks/service.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { registerDatabricksRoutes } from '../../src/databricks-routes.js';
import { runDatabricksCli } from '../../src/databricks-cli.js';
import { createDatabricksAgentDef } from '../../src/runtimes/defs/databricks.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { createDatabricksPiRuntime } from '../../src/runtimes/pi-databricks.js';
import { listenOnFetchCompatiblePort } from '../../src/fetch-compatible-listener.js';
import { bounded } from '../databricks-surface-fixtures.js';
import { assertNoDatabricksIdentityLeaks } from './privacy-fixture.js';

const host = 'https://setup-workspace.example';
const token = 'dapi_SESSION_SECRET_NEVER_PERSIST';
const invalidToken = 'dapi_INVALID_SECRET_NEVER_PERSIST';
const roots: string[] = [];
const servers: Server[] = [];
const encryptionHosts: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(encryptionHosts.splice(0).map((close) => close()));
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cliReady = false, encryptionAvailable?: boolean) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'databricks-setup-'));
  roots.push(dataRoot);
  // The OS key survives host restarts; the fixture uses real AES-GCM instead of launching Electron.
  const key = randomBytes(32);
  let encryptionHost: Awaited<ReturnType<typeof serveSecretEncryption>> | undefined;
  const stopEncryptionHost = async () => { await encryptionHost?.close(); encryptionHost = undefined; };
  const startEncryptionHost = async () => {
    encryptionHost = await serveSecretEncryption(dataRoot, {
      isEncryptionAvailable: () => encryptionAvailable === true,
      encryptString(value) {
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decryptString(value) {
        const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        cipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
      },
    });
  };
  if (encryptionAvailable !== undefined) await startEncryptionHost();
  encryptionHosts.push(stopEncryptionHost);
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const workspace = await bounded(listenOnFetchCompatiblePort(createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (![token, 'cli-private-bearer'].some((value) => req.headers.authorization === `Bearer ${value}`)) {
      res.writeHead(401); res.end(JSON.stringify({ message: invalidToken })); return;
    }
    if (req.url === '/api/2.0/preview/scim/v2/Me') {
      // Even a workspace echoing the credential cannot contaminate public/persisted data.
      res.end(JSON.stringify({ id: 'workspace-user', token }));
    } else if (req.url === '/api/2.0/serving-endpoints') {
      res.end(JSON.stringify({ endpoints: [{ name: 'workspace-model', task: 'llm/v1/chat' }] }));
    } else if (req.url === '/api/2.1/unity-catalog/catalogs') {
      res.end(JSON.stringify({ catalogs: [] }));
    } else { res.writeHead(404); res.end('{}'); }
  })));
  servers.push(workspace.server);
  const runner = vi.fn(async (_exe: string, args: readonly string[]) => ({
    stdout: args[0] === '--version' ? 'Databricks CLI v0.282.0' : args[1] === 'profiles'
      ? JSON.stringify({ profiles: [{ name: 'existing-authenticated', host, is_default: true }] })
      : JSON.stringify({ access_token: 'cli-private-bearer', expiry: new Date(Date.now() + 3600_000).toISOString() }),
    stderr: '', exitCode: 0,
  }));
  const clientOptions = { resolveExecutable: async () => cliReady ? 'databricks.exe' : null, runner };
  const workspaceFetch = async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe(host);
    expect(init.redirect).toBe('error');
    // Production requires HTTPS; only the injected test transport maps to our real stub server.
    const local = new URL(url);
    return fetch(`http://127.0.0.1:${workspace.port}${local.pathname}${local.search}`, init);
  };
  const service = createDatabricksService({ dataRoot, clientOptions, fetch: workspaceFetch });
  const app = express(); app.use(express.json());
  const guard = vi.fn<express.RequestHandler>((_req, _res, next) => next());
  registerDatabricksRoutes(app, { service, setClient: async () => service.status(), http: { requireLocalDaemonRequest: guard } });
  const daemon = await bounded(listenOnFetchCompatiblePort(createServer(app)));
  servers.push(daemon.server);
  const url = `http://127.0.0.1:${daemon.port}`;
  const setup = (value: string) => fetch(`${url}/api/databricks/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ mode: 'workspace-token', host, token: value }),
  });
  return { dataRoot, service, runner, requests, setup, guard, url, clientOptions, workspaceFetch, stopEncryptionHost, startEncryptionHost };
}

async function complete(service: DatabricksService, profileId: string): Promise<DatabricksScanResponse> {
  const started = await service.startScan({ profileId });
  let finish!: (scan: DatabricksScanResponse) => void;
  const finished = new Promise<DatabricksScanResponse>((resolve) => { finish = resolve; });
  // Atomic subscribe/replay also captures completion before this call.
  const unsubscribe = await service.subscribeScan(started.scanId, (event) => { if (event.type === 'done') finish(event.scan); });
  try { return await bounded(finished); }
  finally { unsubscribe(); }
}

async function persisted(dataRoot: string): Promise<Record<string, string>> {
  const directory = join(dataRoot, 'databricks');
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  return Object.fromEntries(await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => [file, await readFile(join(directory, file), 'utf8')])));
}
function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [token, invalidToken, 'cli-private-bearer']) expect(text).not.toContain(secret);
}

describe('CLI-free Databricks setup through real HTTP', () => {
  it('recovers through the storage seam after daemon and encryption-host restart, with ciphertext-only files', async () => {
    const logs = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
    const f = await fixture(false, true);
    const configured = await (await f.setup(token)).json() as DatabricksSetupResponse;
    expect(configured.status).toMatchObject({ setupRequired: false, issues: [] });
    const scan = await complete(f.service, configured.profile.id);
    const model = await f.service.enable(scan.endpoints[0]!.id, { scanId: scan.scanId, expectedRevision: scan.revision });
    const directory = join(f.dataRoot, 'databricks', 'credentials');
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.bin$/);
    const bytes = await readFile(join(directory, files[0]!));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token, 'utf16le'))).toBe(false);
    await f.stopEncryptionHost();
    const restarted = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions, fetch: f.workspaceFetch });
    // Real packaged ordering: daemon can be probed before Electron starts its provider.
    expect(await restarted.status()).toMatchObject({ setupRequired: true, auth: 'keyring-unavailable' });
    expect(await readFile(join(directory, files[0]!))).toEqual(bytes);
    await f.startEncryptionHost();
    const restored = await restarted.status();
    expect(restored).toMatchObject({ setupRequired: false, auth: 'authenticated', enabledCount: 1, issues: [] });
    expect((await restarted.resolveRuntime(model.appModelId)).apiKey).toBe(token);
    expect((await complete(restarted, configured.profile.id)).state).toBe('complete');
    expect(f.requests.filter((entry) => entry.path.endsWith('/Me'))).toHaveLength(2);
    noSecrets([configured, restored, scan, model, await restarted.probe(), await restarted.listModels(), await persisted(f.dataRoot), logs.map((log) => log.mock.calls)]);
    // clear must also work when the app has no running encryption provider.
    await f.stopEncryptionHost();
    await restarted.disconnect(configured.profile.id);
    expect(await readdir(directory)).toEqual([]);
    const disconnected = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions, fetch: f.workspaceFetch });
    expect(await disconnected.status()).toMatchObject({ setupRequired: true, profiles: [], enabledCount: 0 });
  });

  it('keeps an unavailable-encryption host memory-only and reports re-entry without secret-bearing logs', async () => {
    const warning = vi.spyOn(console, 'warn');
    const f = await fixture(false, false);
    const configured = await (await f.setup(token)).json() as DatabricksSetupResponse;
    expect(configured.status).toMatchObject({ setupRequired: false, auth: 'authenticated',
      issues: [{ code: 'DATABRICKS_KEYRING_UNAVAILABLE', action: 'sign-in', retryable: true }] });
    expect(warning).toHaveBeenCalledOnce();
    expect((await complete(f.service, configured.profile.id)).state).toBe('complete');
    await expect(readdir(join(f.dataRoot, 'databricks', 'credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions, fetch: f.workspaceFetch });
    expect(await restarted.status()).toMatchObject({ setupRequired: true, auth: 'auth-required' });
    noSecrets([configured, warning.mock.calls, await persisted(f.dataRoot)]);
  });

  it('erases persisted secrets on rejected replacement setup and on restart validation failure', async () => {
    const f = await fixture(false, true);
    const configured = await (await f.setup(token)).json() as DatabricksSetupResponse;
    const directory = join(f.dataRoot, 'databricks', 'credentials');
    expect(await readdir(directory)).toHaveLength(1);
    expect((await f.setup(invalidToken)).status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
    expect(await f.service.status()).toMatchObject({ setupRequired: true, auth: 'auth-required' });
    expect((await f.setup(token)).status).toBe(200);
    const restarted = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions,
      fetch: async () => new Response(JSON.stringify({ token }), { status: 401 }) });
    const status = await restarted.status();
    expect(status).toMatchObject({ setupRequired: true, auth: 'auth-required' });
    expect(await readdir(directory)).toEqual([]);
    noSecrets([configured, status, await persisted(f.dataRoot)]);
  });

  it('erases the saved credential when an authenticated scan or runtime later rejects it', async () => {
    const f = await fixture(false, true);
    const configured = await (await f.setup(token)).json() as DatabricksSetupResponse;
    const scan = await complete(f.service, configured.profile.id);
    const model = await f.service.enable(scan.endpoints[0]!.id, { scanId: scan.scanId, expectedRevision: scan.revision });
    const runtime = await f.service.resolveRuntime(model.appModelId);
    const relay = await createDatabricksRelay({ runtime, fetch: async () => new Response(JSON.stringify({ token }), { status: 401 }) });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [] }), signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(401);
      noSecrets(await response.json());
    } finally { await relay.close(); }
    expect(await readdir(join(f.dataRoot, 'databricks', 'credentials'))).toEqual([]);
    await expect(f.service.resolveRuntime(model.appModelId)).rejects.toMatchObject({ code: 'DATABRICKS_AUTH_REQUIRED' });
    expect((await f.setup(token)).status).toBe(200);
    const restarted = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions,
      fetch: async (url, init) => url.endsWith('/Me') ? f.workspaceFetch(url, init) : new Response('{}', { status: 401 }) });
    expect((await restarted.status()).setupRequired).toBe(false);
    const rejectedScan = await complete(restarted, configured.profile.id);
    expect(rejectedScan.issues.some((issue) => issue.code === 'DATABRICKS_AUTH_REQUIRED')).toBe(true);
    expect(await readdir(join(f.dataRoot, 'databricks', 'credentials'))).toEqual([]);
    expect((await restarted.status()).setupRequired).toBe(true);
  });
  it('keeps the bundled agent available and reports setup with no CLI, credentials, or models', async () => {
    const { service, runner } = await fixture();
    expect(await service.status()).toMatchObject({ cli: 'missing', auth: 'auth-required', setupRequired: true, profiles: [], enabledCount: 0 });
    expect(await safeProbe(createDatabricksAgentDef(() => service))).toMatchObject({
      available: true, authStatus: 'missing', models: [], modelSelectionRequired: true, modelManagement: 'databricks',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('allows workspace names in setup UI DTOs but never credentials or hosts in generated Pi files', async () => {
    const f = await fixture();
    const response = await f.setup(token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const configured = await response.json() as DatabricksSetupResponse;
    expect(configured.status).toMatchObject({ cli: 'missing', auth: 'authenticated', setupRequired: false,
      issues: [{ code: 'DATABRICKS_KEYRING_UNAVAILABLE', action: 'sign-in', retryable: true }], enabledCount: 0 });
    expect(f.requests).toEqual([{ path: '/api/2.0/preview/scim/v2/Me', authorization: `Bearer ${token}` }]);
    expect(f.guard).toHaveBeenCalledOnce();
    expect((await f.service.listModels()).models).toEqual([]);
    expect(configured.profile).toEqual(configured.status.profiles[0]);
    expect(configured.profile).toMatchObject({ workspaceLabel: host, workspaceDisplayLabel: host });
    const profileId = configured.profile.id;
    const scan = await complete(f.service, profileId);
    expect(scan.state).toBe('complete');
    expect(scan.endpoints).toHaveLength(1);
    expect(f.requests.slice(1).map((request) => request.path).sort()).toEqual(['/api/2.0/serving-endpoints', '/api/2.1/unity-catalog/catalogs']);
    const model = await f.service.enable(scan.endpoints[0]!.id, { scanId: scan.scanId, expectedRevision: scan.revision });
    expect((await f.service.resolveRuntime(model.appModelId)).apiKey).toBe(token);
    const cwd = join(f.dataRoot, 'project'); await mkdir(cwd);
    const runtime = await createDatabricksPiRuntime({ dataRoot: f.dataRoot, cwd, sessionKey: 'setup', model: model.appModelId, service: f.service });
    try {
      assertNoDatabricksIdentityLeaks({ invocation: runtime.invocation }, [token, host, 'workspace-model']);
      for (const file of ['models.json', 'settings.json']) {
        assertNoDatabricksIdentityLeaks({ [file]: await readFile(join(runtime.invocation.agentDir, file), 'utf8') }, [token, host, 'workspace-model']);
      }
    } finally { await runtime.close(); }
    noSecrets([configured, scan, model, await f.service.probe({ profileId }), await f.service.listModels(), await persisted(f.dataRoot)]);
    expect(f.runner).not.toHaveBeenCalled();
    const restart = createDatabricksService({ dataRoot: f.dataRoot, clientOptions: f.clientOptions, fetch: f.workspaceFetch });
    expect(await restart.status()).toMatchObject({ setupRequired: true, auth: 'auth-required', enabledCount: 1 });
    await expect(restart.resolveRuntime(model.appModelId)).rejects.toMatchObject({ code: 'DATABRICKS_AUTH_REQUIRED' });
    const restored = await restart.setup({ mode: 'workspace-token', host, token });
    expect(restored.status.profiles[0]!.id).toBe(profileId);
    expect(restored.status.setupRequired).toBe(false);
    await restart.disconnect(profileId);
    expect(await restart.status()).toMatchObject({ setupRequired: true, profiles: [], enabledCount: 0 });
  });

  it('rejects invalid credentials, preserves catalogue bytes, and invalidates any previous token', async () => {
    const f = await fixture();
    for (const alreadyConfigured of [false, true]) {
      if (alreadyConfigured) expect((await f.setup(token)).status).toBe(200);
      const beforeStatus = await f.service.status();
      const beforeFiles = await persisted(f.dataRoot);
      const response = await f.setup(invalidToken);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const failure = await response.json();
      expect(failure).toMatchObject({ error: { code: 'DATABRICKS_AUTH_REQUIRED', retryable: false } });
      if (alreadyConfigured) {
        expect(await f.service.status()).toMatchObject({ setupRequired: true, auth: 'auth-required' });
        expect((await complete(f.service, beforeStatus.profiles[0]!.id)).state).toBe('failed');
      } else expect(await f.service.status()).toEqual(beforeStatus);
      expect(await persisted(f.dataRoot)).toEqual(beforeFiles);
      noSecrets([failure, beforeStatus, beforeFiles]);
    }
  });

  it('discovers and prefers an already-authenticated CLI profile over token setup', async () => {
    const f = await fixture(true);
    const initial = await f.service.status();
    expect(initial).toMatchObject({ setupRequired: false, auth: 'authenticated', cli: 'ready' });
    expect(initial.profiles[0]).toMatchObject({ label: 'existing-authenticated', displayName: 'existing-authenticated',
      workspaceLabel: host, workspaceDisplayLabel: host });
    const cliProfile = initial.profiles[0]!.id;
    expect((await f.service.setup({ mode: 'cli-profile' })).profile.id).toBe(cliProfile);
    const configured = await (await f.setup(token)).json() as DatabricksSetupResponse;
    expect(configured.status.profiles).toHaveLength(2);
    expect(configured.status.profiles[0]).toMatchObject({ id: cliProfile, isDefault: true, auth: 'authenticated' });
    const result = await complete(f.service, cliProfile);
    expect(result.state).toBe('complete');
    expect(f.requests.filter((request) => request.path !== '/api/2.0/preview/scim/v2/Me').every((request) => request.authorization === 'Bearer cli-private-bearer')).toBe(true);
    const generation = await new DatabricksStore(f.dataRoot).read();
    expect(generation.bindings.find((binding) => binding.mode === 'workspace-token')).toMatchObject({ host, profileName: '' });
    noSecrets([configured, result, await persisted(f.dataRoot)]);
  });

  it('returns the newly validated workspace profile even when a CLI profile remains the default', async () => {
    const f = await fixture(true);
    const cliProfile = (await f.service.status()).profiles[0]!;
    const response = await f.setup(token);
    expect(response.status).toBe(200);
    const configured = await response.json() as DatabricksSetupResponse;
    expect(configured.status.profiles[0]!.id).toBe(cliProfile.id);
    expect(configured.profile.id).not.toBe(cliProfile.id);
    expect(configured.profile).toEqual(configured.status.profiles[1]);
    expect(configured.profile.auth).toBe('authenticated');

    const responseScan = await fetch(`${f.url}/api/databricks/scans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ profileId: configured.profile.id }),
    });
    expect(responseScan.status).toBe(202);
    const started = await responseScan.json() as DatabricksScanResponse;
    expect(started.profileId).toBe(configured.profile.id);
    let finish!: (scan: DatabricksScanResponse) => void;
    const finished = new Promise<DatabricksScanResponse>((resolve) => { finish = resolve; });
    const release = await f.service.subscribeScan(started.scanId, (event) => {
      if (event.type === 'done') finish(event.scan);
    });
    try {
      expect((await bounded(finished)).state).toBe('complete');
      expect(f.requests.slice(1).every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
      noSecrets(configured);
    } finally { release(); }
  });

  it('drives setup and scanning from the CLI over the daemon HTTP surface', async () => {
    const f = await fixture();
    let output = ''; let stderr = '';
    const dependencies = { resolveDaemonUrl: async () => f.url, readStdin: async () => token,
      stdout: (text: string) => { output += text; }, stderr: (text: string) => { stderr += text; } };
    expect(await runDatabricksCli(['setup', '--mode', 'workspace-token', '--host', host, '--token-stdin', '--json'], dependencies)).toEqual({ exitCode: 0 });
    const setup = JSON.parse(output) as DatabricksSetupResponse;
    expect(setup.status.setupRequired).toBe(false);
    noSecrets([output, stderr]);
    output = '';
    expect(await runDatabricksCli(['scan', '--profile', setup.status.profiles[0]!.id, '--json'], dependencies)).toEqual({ exitCode: 0 });
    expect(JSON.parse(output).state).toBe('complete');
    noSecrets([output, stderr, await persisted(f.dataRoot)]);
  });
});
