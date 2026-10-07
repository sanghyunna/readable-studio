import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';

describe('folder routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { server: http.Server; url: string };
    server = started.server;
    baseUrl = started.url;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  const json = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${url}`, body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };

  it('creates, lists and renames folders with trimmed, bounded names', async () => {
    const created = await json('POST', '/api/folders', { name: '  SGI prep  ' });
    expect(created.status).toBe(200);
    expect(created.body.folder).toMatchObject({ name: 'SGI prep', sessionCount: 0 });
    expect((await json('POST', '/api/folders', { name: '   ' })).status).toBe(400);
    expect((await json('POST', '/api/folders', { name: 'x'.repeat(121) })).status).toBe(400);

    const listed = (await json('GET', '/api/folders')).body.folders.map((f: any) => f.id);
    expect(listed).toContain(created.body.folder.id);

    const renamed = await json('PATCH', `/api/folders/${created.body.folder.id}`, { name: 'SGI exam' });
    expect(renamed.body.folder.name).toBe('SGI exam');
    expect((await json('PATCH', '/api/folders/missing', { name: 'x' })).status).toBe(404);
  });

  it('deletes a folder keeping its sessions as standalone by default', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Keep policy' })).body.folder;
    const session = (await json('POST', '/api/sessions', { title: 'Kept', folderId: folder.id })).body.session;

    const deleted = await json('DELETE', `/api/folders/${folder.id}`);
    expect(deleted.body).toEqual({ ok: true, movedSessionIds: [session.id], deletedSessionIds: [] });
    expect((await json('GET', `/api/sessions/${session.id}`)).body.session.folderId).toBeNull();
    expect((await json('GET', '/api/folders')).body.folders.map((f: any) => f.id)).not.toContain(folder.id);
  });

  it('deletes a folder and its sessions with sessions=delete', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Delete policy' })).body.folder;
    const created = (await json('POST', '/api/sessions', { title: 'Gone', folderId: folder.id })).body;

    const deleted = await json('DELETE', `/api/folders/${folder.id}?sessions=delete`);
    expect(deleted.body).toEqual({ ok: true, movedSessionIds: [], deletedSessionIds: [created.session.id] });
    expect((await json('GET', `/api/sessions/${created.session.id}`)).status).toBe(404);
    expect((await json('GET', `/api/projects/${created.workspace.id}`)).status).toBe(404);
  });

  it('rejects an unknown policy and an unknown folder', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Policy check' })).body.folder;
    expect((await json('DELETE', `/api/folders/${folder.id}?sessions=archive`)).status).toBe(400);
    expect((await json('DELETE', '/api/folders/missing')).status).toBe(404);
  });
});
