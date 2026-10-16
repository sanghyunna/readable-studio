import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ids, secrets, status, surfaceHarness } from '../databricks-surface-fixtures.js';
import { runDatabricksCli } from '../../src/databricks-cli.js';

let harness: Awaited<ReturnType<typeof surfaceHarness>> | undefined;
beforeEach(() => { vi.stubEnv('DATABRICKS_CONFIG_FILE', join(tmpdir(), `databricks-absent-${randomUUID()}`)); });
afterEach(async () => { await harness?.close(); harness = undefined; vi.unstubAllEnvs(); });
async function start(body: unknown = {}) {
  return fetch(`${harness!.url}/api/databricks/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: harness!.url }, body: JSON.stringify(body),
  });
}

describe('managed Databricks login contract', () => {
  it('uses the known workspace and profile without asking for input', async () => {
    harness = await surfaceHarness();
    const response = await start();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: 'started', loginId: ids.scan, host: secrets.host, profile: 'team-dev' });
    expect(harness.service.startLogin).toHaveBeenCalledExactlyOnceWith({ host: secrets.host, profile: 'team-dev' });
  });
  it('prefers DEFAULT over other discovered profiles', async () => {
    harness = await surfaceHarness();
    harness.service.status.mockResolvedValue({ ...status, profiles: [
      status.profiles[0]!, { ...status.profiles[0]!, label: 'DEFAULT', workspaceLabel: 'https://default.example' },
    ] });
    await start();
    expect(harness.service.startLogin).toHaveBeenCalledWith({ host: 'https://default.example', profile: 'DEFAULT' });
  });
  it('returns needs-input without starting a child when no host is known', async () => {
    harness = await surfaceHarness();
    harness.service.status.mockResolvedValue({ ...status, profiles: [] });
    expect(await (await start()).json()).toEqual({ state: 'needs-input' });
    expect(harness.service.startLogin).not.toHaveBeenCalled();
  });
  it('normalizes an arbitrary update workspace and preserves the supplied profile', async () => {
    harness = await surfaceHarness();
    expect((await start({ host: ' https://UPDATE.example/ ', profile: 'updates' })).status).toBe(202);
    expect(harness.service.startLogin).toHaveBeenCalledWith({ host: 'https://update.example', profile: 'updates' });
  });
  it('projects the browser URL but not arbitrary CLI or credential fields', async () => {
    harness = await surfaceHarness();
    const authUrl = 'https://workspace.example/oidc/oauth2/v2.0/authorize?state=opaque';
    harness.service.getLogin.mockResolvedValue({
      loginId: ids.scan, state: 'waiting-for-browser', createdAt: '', deadlineAt: '', completedAt: null, profileId: null, issues: [], authUrl,
    });
    const response = await fetch(`${harness.url}/api/databricks/login/${ids.scan}`);
    expect(await response.json()).toEqual({ state: 'waiting-browser', authUrl });
  });
  it('keeps successful connection identity and sanitized failure issues without localized prose', async () => {
    harness = await surfaceHarness();
    harness.service.getLogin.mockResolvedValue({
      loginId: ids.scan, state: 'authenticated', createdAt: '', deadlineAt: '', completedAt: '', profileId: 'connection-new', issues: [],
    });
    expect(await (await fetch(`${harness.url}/api/databricks/login/${ids.scan}`)).json()).toMatchObject({ state: 'succeeded', profileId: 'connection-new' });
    harness.service.getLogin.mockResolvedValue({
      loginId: ids.scan, state: 'failed', createdAt: '', deadlineAt: '', completedAt: '', profileId: null,
      authUrl: 'https://workspace.example/oidc/.well-known/oauth-authorization-server',
      issues: [{ code: 'DATABRICKS_KEYRING_UNAVAILABLE', action: 'sign-in', retryable: true }],
    });
    const body = await (await fetch(`${harness.url}/api/databricks/login/${ids.scan}`)).json();
    expect(body).toMatchObject({ state: 'failed', issues: [{ code: 'DATABRICKS_KEYRING_UNAVAILABLE' }] });
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('authUrl');
  });
  it('never reuses DEFAULT for a different host', async () => {
    harness = await surfaceHarness();
    harness.service.status.mockResolvedValue({ ...status, profiles: [{ ...status.profiles[0]!, label: 'DEFAULT', workspaceLabel: 'https://old.example' }] });
    const body = await (await start({ host: 'https://new.example' })).json();
    expect(body).not.toMatchObject({ profile: 'DEFAULT' });
  });
  it('identifies missing login jobs without reporting a model scan error', async () => {
    harness = await surfaceHarness();
    harness.service.getLogin.mockRejectedValue(new Error('missing'));
    harness.service.cancelLogin.mockRejectedValue(new Error('missing'));
    const statusResponse = await fetch(`${harness.url}/api/databricks/login/no-such-job`);
    expect(statusResponse.status).toBe(404);
    expect(await statusResponse.json()).toEqual({ error: { code: 'DATABRICKS_LOGIN_NOT_FOUND' } });
    const cancelResponse = await fetch(`${harness.url}/api/databricks/login/no-such-job/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: harness.url }, body: '{}',
    });
    expect(cancelResponse.status).toBe(404);
    expect(await cancelResponse.json()).toEqual({ error: { code: 'DATABRICKS_LOGIN_NOT_FOUND' } });
  });
  it('accepts a named CLI profile and no host through the same guarded endpoint', async () => {
    harness = await surfaceHarness();
    let output = '';
    expect(await runDatabricksCli(['login', '--profile', 'team-dev', '--json'], {
      resolveDaemonUrl: async () => harness!.url, stdout: text => { output += text; }, stderr: () => {},
    })).toEqual({ exitCode: 0 });
    expect(JSON.parse(output)).toEqual({ state: 'started', loginId: ids.scan, host: secrets.host, profile: 'team-dev' });
    expect(harness.service.startLogin).toHaveBeenCalledWith({ host: secrets.host, profile: 'team-dev' });
    expect(harness.guard).toHaveBeenCalledOnce();
  });
});
