import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import type { ShortcutCapabilities, ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';

type Job = { id: string; location: ShortcutLocation };
const valid = (value: unknown): value is ShortcutLocation => value === 'desktop' || value === 'startMenu';

export function registerShortcutRoutes(app: Express, token: string | null, onDesktopPoll?: () => void): void {
  let lastPoll = 0;
  const jobs: Job[] = [];
  const listeners = new Set<() => void>();
  const pending = new Map<string, { location: ShortcutLocation; finish: (result: ShortcutCreateResult) => void }>();
  const authorized = (auth: string | undefined) => {
    if (!token || !auth?.startsWith('Bearer ')) return false;
    const a = Buffer.from(auth.slice(7));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const capabilities = (): ShortcutCapabilities => token && Date.now() - lastPoll < 30_000
    ? { desktop: true, startMenu: true, taskbar: false, startPinned: false }
    : { desktop: false, startMenu: false, taskbar: false, startPinned: false,
        reason: token ? 'desktop-unavailable' : 'unsupported' };

  app.get('/api/shortcuts', (_req, res) => { res.json(capabilities()); });
  app.post('/api/shortcuts', async (req, res) => {
    const location: unknown = req.body?.location;
    if (!valid(location)) { res.status(400).json({ error: 'invalid shortcut location' }); return; }
    const availability = capabilities();
    if (!availability.desktop) {
      res.json({ status: 'failed', location, reason: availability.reason }); return;
    }
    const job = { id: randomUUID(), location };
    const result = await new Promise<ShortcutCreateResult>((resolve) => {
      const finish = (value: ShortcutCreateResult) => {
        clearTimeout(timer);
        pending.delete(job.id);
        const queued = jobs.indexOf(job);
        if (queued !== -1) jobs.splice(queued, 1);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ status: 'failed', location, reason: 'desktop-unavailable' }), 15_000);
      pending.set(job.id, { location, finish });
      jobs.push(job);
      for (const notify of listeners) notify();
    });
    res.json(result);
  });
  app.get('/api/shortcuts/desktop/next', async (req, res) => {
    if (!authorized(req.get('authorization'))) { res.sendStatus(401); return; }
    lastPoll = Date.now();
    onDesktopPoll?.();
    const next = () => jobs.shift() ?? null;
    let job = next();
    if (!job) {
      job = await new Promise<Job | null>((resolve) => {
        const notify = () => { const item = next(); if (item) finish(item); };
        const finish = (value: Job | null) => {
          clearTimeout(timer);
          listeners.delete(notify);
          res.off('close', closed);
          resolve(value);
        };
        const closed = () => finish(null);
        const timer = setTimeout(() => finish(null), 10_000);
        listeners.add(notify);
        res.on('close', closed);
      });
    }
    if (!res.destroyed) res.json({ job: job && pending.has(job.id) ? job : null });
  });
  app.post('/api/shortcuts/desktop/:id/result', (req, res) => {
    if (!authorized(req.get('authorization'))) { res.sendStatus(401); return; }
    const id = String(req.params.id);
    const request = pending.get(id);
    if (!request) { res.sendStatus(404); return; }
    const result: unknown = req.body;
    if (!result || typeof result !== 'object' || (result as ShortcutCreateResult).location !== request.location
      || !['created', 'already-existed', 'failed'].includes((result as ShortcutCreateResult).status)
      || ((result as ShortcutCreateResult).status === 'failed' && typeof (result as { reason?: unknown }).reason !== 'string')) {
      res.sendStatus(400); return;
    }
    request.finish(result as ShortcutCreateResult);
    res.json({ accepted: true });
  });
}
