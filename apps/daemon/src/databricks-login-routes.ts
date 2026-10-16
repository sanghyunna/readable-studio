import type { Express, RequestHandler } from 'express';
import type { DatabricksManagedLoginRequest, DatabricksManagedLoginStart, DatabricksManagedLoginStatus, DatabricksLoginResponse } from '@readable-studio/contracts';
import type { DatabricksService } from './databricks/service.js';
import { databricksWorkspaceOrigin, databricksLoginProfile, issueFor } from './databricks/client.js';

export function managedLoginStatus(job: DatabricksLoginResponse): DatabricksManagedLoginStatus {
  const state = job.state === 'authenticated' ? 'succeeded' : job.state === 'timed-out' ? 'timeout'
    : job.state === 'starting' || job.state === 'waiting-for-browser' ? 'waiting-browser' : job.state;
  return { state, ...(state === 'waiting-browser' && job.authUrl ? { authUrl: job.authUrl } : {}),
    ...(state === 'succeeded' && job.profileId ? { profileId: job.profileId } : {}),
    ...(job.issues.length ? { issues: job.issues.map(({ code, action, retryable }) => ({ code, action, retryable })) } : {}) };
}

export function managedLoginInput(value: unknown): DatabricksManagedLoginRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid login request');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['host', 'profile'].includes(key))
    || body.profile !== undefined && (typeof body.profile !== 'string' || !/^[\p{L}\p{N}_. -]{1,128}$/u.test(body.profile))) throw new Error('Invalid login request');
  return { ...(body.host === undefined ? {} : { host: databricksWorkspaceOrigin(typeof body.host === 'string' ? body.host.trim() : body.host) }),
    ...(body.profile === undefined ? {} : { profile: body.profile as string }) };
}

export function registerDatabricksLoginRoutes(app: Express, service: Omit<DatabricksService, 'resolveRuntime'>, guards: RequestHandler[]): void {
  app.post('/api/databricks/login', ...guards, async (req, res) => {
    let body: DatabricksManagedLoginRequest;
    try { body = managedLoginInput(req.body ?? {}); }
    catch { res.status(400).json({ error: { code: 'BAD_REQUEST' } }); return; }
    try {
      const status = await service.status();
      const known = status.profiles.find(profile => body.profile ? profile.label === body.profile : body.host ? profile.workspaceLabel === body.host : profile.label === 'DEFAULT')
        ?? (!body.host && !body.profile ? status.profiles.find(profile => profile.isDefault) ?? status.profiles[0] : undefined);
      const host = body.host ?? known?.workspaceLabel;
      if (!host) { res.json({ state: 'needs-input' } satisfies DatabricksManagedLoginStart); return; }
      const requested = body.profile ?? known?.label;
      const collision = status.profiles.some(entry => entry.label === requested && entry.workspaceLabel !== host);
      const profile = await databricksLoginProfile(host, collision ? undefined : requested);
      const job = await service.startLogin({ host, profile });
      res.status(202).json({ state: 'started', loginId: job.loginId, host, profile } satisfies DatabricksManagedLoginStart);
    } catch (error) { res.status(503).json({ error: issueFor(error) }); }
  });
  app.get('/api/databricks/login/:loginId', ...guards, async (req, res) => {
    try {
      if (typeof req.params.loginId !== 'string') throw new Error('Invalid login ID');
      res.json(managedLoginStatus(await service.getLogin(req.params.loginId)));
    }
    catch { res.status(404).json({ error: { code: 'DATABRICKS_LOGIN_NOT_FOUND' } }); }
  });
  app.post('/api/databricks/login/:loginId/cancel', ...guards, async (req, res) => {
    try {
      if (typeof req.params.loginId !== 'string') throw new Error('Invalid login ID');
      res.json(managedLoginStatus(await service.cancelLogin(req.params.loginId)));
    }
    catch { res.status(404).json({ error: { code: 'DATABRICKS_LOGIN_NOT_FOUND' } }); }
  });
}
