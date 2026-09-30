import express from 'express';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerShortcutRoutes } from '../src/shortcut-routes.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });
async function server(token: string | null, onDesktopPoll?: () => void) {
  const app = express(); app.use(express.json());
  registerShortcutRoutes(app, token, onDesktopPoll);
  const http = createServer(app); servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

describe('shortcut API', () => {
  it('reports unsupported source mode and refuses creation without queuing', async () => {
    const base = await server(null);
    expect(await (await fetch(`${base}/api/shortcuts`)).json()).toMatchObject({ desktop: false, startMenu: false, taskbar: false, startPinned: false });
    const result = await fetch(`${base}/api/shortcuts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: 'desktop' }) });
    expect(await result.json()).toEqual({ status: 'failed', location: 'desktop', reason: 'unsupported' });
  });
  it('bridges one authorized desktop action and returns the exact typed result', async () => {
    let polled!: () => void;
    const poll = new Promise<void>((resolve) => { polled = resolve; });
    const base = await server('secret', polled);
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const next = fetch(`${base}/api/shortcuts/desktop/next`, { headers });
    await poll;
    expect(await (await fetch(`${base}/api/shortcuts`)).json()).toMatchObject({ desktop: true, startMenu: true, taskbar: false });
    const creation = fetch(`${base}/api/shortcuts`, { method: 'POST', headers, body: JSON.stringify({ location: 'startMenu' }) });
    const job = (await (await next).json() as { job: { id: string; location: string } }).job;
    expect(job.location).toBe('startMenu');
    const mismatch = await fetch(`${base}/api/shortcuts/desktop/${job.id}/result`, { method: 'POST', headers, body: JSON.stringify({ status: 'created', location: 'desktop' }) });
    expect(mismatch.status).toBe(400);
    const ack = await fetch(`${base}/api/shortcuts/desktop/${job.id}/result`, { method: 'POST', headers, body: JSON.stringify({ status: 'created', location: 'startMenu' }) });
    expect(ack.status).toBe(200);
    expect(await (await creation).json()).toEqual({ status: 'created', location: 'startMenu' });
  });
  it('rejects invalid locations and unauthenticated desktop polling', async () => {
    const base = await server('secret');
    expect((await fetch(`${base}/api/shortcuts/desktop/next`)).status).toBe(401);
    expect((await fetch(`${base}/api/shortcuts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: 'taskbar' }) })).status).toBe(400);
  });
});
