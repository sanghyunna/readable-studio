import type http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, insertProjectCheckpoint, openDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';

describe('session routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const dataDir = process.env.READABLE_DATA_DIR;
  if (!dataDir) throw new Error('isolated READABLE_DATA_DIR required');
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { server: http.Server; url: string };
    server = started.server;
    baseUrl = started.url;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const json = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${url}`, body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const createFolder = async (name: string) => (await json('POST', '/api/folders', { name })).body.folder as { id: string };
  const createSession = async (body: Record<string, unknown>) => {
    const res = await json('POST', '/api/sessions', body);
    expect(res.status).toBe(200);
    return res.body as { session: { id: string; projectId: string; folderId: string | null; title: string }; workspace: { id: string; name: string } };
  };

  it('creates a standalone session and a session inside a folder, placed accordingly in the rail', async () => {
    const folder = await createFolder('Rail placement');
    const standalone = await createSession({ title: 'Standalone deck' });
    const inside = await createSession({ title: 'Folder deck', folderId: folder.id });

    expect(standalone.session.title).toBe('Standalone deck');
    expect(standalone.session.folderId).toBeNull();
    expect(standalone.workspace.name).toBe('Standalone deck');
    expect(standalone.session.projectId).toBe(standalone.workspace.id);
    expect(inside.session.folderId).toBe(folder.id);

    const rail = (await json('GET', '/api/rail')).body;
    expect(rail.recents.map((s: any) => s.id)).toContain(standalone.session.id);
    expect(rail.recents.map((s: any) => s.id)).not.toContain(inside.session.id);
    const railFolder = rail.folders.find((f: any) => f.id === folder.id);
    expect(railFolder.sessions.map((s: any) => s.id)).toEqual([inside.session.id]);
    expect(railFolder.sessions[0]).toMatchObject({ workspaceId: inside.workspace.id, state: 'idle', workspaceSessionCount: 1 });

    const recents = (await json('GET', '/api/sessions?folder=none')).body.sessions.map((s: any) => s.id);
    expect(recents).toContain(standalone.session.id);
    expect(recents).not.toContain(inside.session.id);
    const inFolder = (await json('GET', `/api/sessions?folder=${folder.id}`)).body.sessions.map((s: any) => s.id);
    expect(inFolder).toEqual([inside.session.id]);
    expect((await json('GET', '/api/sessions?limit=1')).body.sessions).toHaveLength(1);
  });

  it('rejects an unknown folder on create and on move', async () => {
    expect((await json('POST', '/api/sessions', { title: 'x', folderId: 'missing-folder' })).status).toBe(404);
    const created = await createSession({ title: 'Move target check' });
    expect((await json('PATCH', `/api/sessions/${created.session.id}`, { folderId: 'missing-folder' })).status).toBe(404);
    expect((await json('GET', '/api/sessions/missing-session')).status).toBe(404);
  });

  it('moves a session folder -> none -> folder without touching its files or checkpoints', async () => {
    const folder = await createFolder('Move round trip');
    const created = await createSession({ title: 'Round trip', folderId: folder.id });
    const workspaceId = created.workspace.id;
    const workspaceDir = path.join(dataDir, 'projects', workspaceId);
    mkdirSync(path.join(workspaceDir, 'nested'), { recursive: true });
    writeFileSync(path.join(workspaceDir, 'index.html'), '<h1>deck</h1>');
    writeFileSync(path.join(workspaceDir, 'nested', 'notes.md'), '# notes');
    const db = openDatabase('', { dataDir });
    insertProjectCheckpoint(db, {
      id: `cp-${workspaceId}`, projectId: workspaceId, conversationId: created.session.id, kind: 'pre_run',
      rootPathHash: 'root', manifestHash: 'manifest', manifestPath: 'manifest.json', fileCount: 2, totalBytes: 20,
      createdAt: 1_760_000_000_000,
    } as any);
    const snapshot = async () => {
      const files = await fetch(`${baseUrl}/api/projects/${workspaceId}/files`);
      const checkpoints = await fetch(
        `${baseUrl}/api/projects/${workspaceId}/checkpoints?conversationId=${encodeURIComponent(created.session.id)}`,
      );
      expect(files.status).toBe(200);
      expect(checkpoints.status).toBe(200);
      return { files: await files.text(), checkpoints: await checkpoints.text() };
    };
    const before = await snapshot();
    expect(before.files).toContain('notes.md');
    expect(before.checkpoints).toContain(`cp-${workspaceId}`);
    const updatedAtBefore = (await json('GET', `/api/sessions/${created.session.id}`)).body.session.updatedAt;

    const out = await json('PATCH', `/api/sessions/${created.session.id}`, { folderId: null });
    expect(out.status).toBe(200);
    expect(out.body.session.folderId).toBeNull();
    expect((await json('GET', '/api/rail')).body.recents.map((s: any) => s.id)).toContain(created.session.id);
    const back = await json('PATCH', `/api/sessions/${created.session.id}`, { folderId: folder.id });
    expect(back.body.session.folderId).toBe(folder.id);

    const after = await snapshot();
    expect(after.files).toBe(before.files);
    expect(after.checkpoints).toBe(before.checkpoints);
    expect(back.body.session.projectId).toBe(workspaceId);
    expect(back.body.session.updatedAt).toBe(updatedAtBefore);
  });

  it('mirrors a rename to the workspace name only when the workspace has one session', async () => {
    const solo = await createSession({ title: 'Solo before' });
    await json('PATCH', `/api/sessions/${solo.session.id}`, { title: 'Solo after' });
    expect((await json('GET', `/api/projects/${solo.workspace.id}`)).body.project.name).toBe('Solo after');

    const shared = await createSession({ title: 'Shared workspace' });
    const sibling = (await json('POST', `/api/projects/${shared.workspace.id}/conversations`, { title: 'Sibling' })).body.conversation;
    const renamed = await json('PATCH', `/api/sessions/${sibling.id}`, { title: 'Sibling renamed' });
    expect(renamed.body.session.title).toBe('Sibling renamed');
    expect((await json('GET', `/api/projects/${shared.workspace.id}`)).body.project.name).toBe('Shared workspace');
  });

  it('deletes an emptied managed workspace and its directory', async () => {
    const created = await createSession({ title: 'Delete me' });
    const workspaceDir = path.join(dataDir, 'projects', created.workspace.id);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(workspaceDir, 'index.html'), 'x');

    expect((await json('DELETE', `/api/sessions/${created.session.id}`)).body).toEqual({ ok: true });
    expect((await json('GET', `/api/projects/${created.workspace.id}`)).status).toBe(404);
    expect(existsSync(workspaceDir)).toBe(false);
    expect((await json('DELETE', `/api/sessions/${created.session.id}`)).status).toBe(404);
  });

  it('keeps a workspace that still has sessions', async () => {
    const created = await createSession({ title: 'Keep workspace' });
    const sibling = (await json('POST', `/api/projects/${created.workspace.id}/conversations`, { title: 'Sibling' })).body.conversation;
    await json('DELETE', `/api/sessions/${created.session.id}`);
    expect((await json('GET', `/api/projects/${created.workspace.id}`)).status).toBe(200);
    expect((await json('GET', `/api/sessions/${sibling.id}`)).status).toBe(200);
  });

  it('never deletes an imported folder when its last session is deleted', async () => {
    const userDir = mkdtempSync(path.join(os.tmpdir(), 'rs-session-import-'));
    tempDirs.push(userDir);
    writeFileSync(path.join(userDir, 'index.html'), '<p>mine</p>');
    const folder = await createFolder('Imports');
    const imported = await json('POST', '/api/import/folder', { baseDir: userDir, folderId: folder.id });
    expect(imported.status).toBe(200);
    const conversationId = imported.body.conversationId as string;
    expect((await json('GET', `/api/sessions/${conversationId}`)).body.session.folderId).toBe(folder.id);

    await json('DELETE', `/api/sessions/${conversationId}`);
    expect(existsSync(path.join(userDir, 'index.html'))).toBe(true);
    expect((await json('GET', `/api/projects/${imported.body.project.id}`)).status).toBe(200);
  });

  it('lifecycle create emits once and honors omitted versus null', async () => {
    const { railEvents } = await import('../src/rail-events.js');
    const folder = await createFolder('Lifecycle');
    const seeded = await createSession({ title: 'Lifecycle', folderId: folder.id });
    const route = `/api/projects/${seeded.workspace.id}/conversations`;
    const events: unknown[] = [];
    const unsubscribe = railEvents.subscribe((event) => events.push(event));
    try {
      for (const body of [{}, { folderId: null }, { folderId: folder.id }]) {
        events.length = 0;
        const created = await json('POST', route, body);
        expect(created.status).toBe(200);
        expect(created.body.conversation.folderId).toBe(
          'folderId' in body ? body.folderId : folder.id,
        );
        expect(events).toEqual([
          expect.objectContaining({
            reason: 'session-created',
            ids: [created.body.conversation.id],
          }),
        ]);
        expect((await json('DELETE', `${route}/${created.body.conversation.id}`)).status).toBe(200);
      }
      events.length = 0;
      expect((await json('POST', route, { folderId: 'missing-folder' })).status).toBe(404);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it.each([true, false])('lifecycle authoritative last-delete and one replacement (%s)', async (grouped) => {
    const folderId = grouped ? (await createFolder('Reseed')).id : null;
    const seeded = await createSession({ title: 'Reseed', folderId });
    const route = `/api/projects/${seeded.workspace.id}/conversations`;
    const selection = { agentId: 'codex', agentModels: {} };
    expect((await json('PATCH', `${route}/${seeded.session.id}`, {
      sessionMode: 'chat', selection,
    })).status).toBe(200);
    const before = (await json('GET', `/api/projects/${seeded.workspace.id}`)).body;
    expect(before).toMatchObject({
      project: { id: seeded.workspace.id },
      resolvedDir: expect.any(String),
    });
    const removed = await json('DELETE', `${route}/${seeded.session.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.conversation).toMatchObject({
      id: seeded.session.id, folderId, sessionMode: 'chat', selection,
    });
    const snapshot = removed.body.conversation;
    const fresh = await json('POST', route, {
      folderId: snapshot.folderId,
      sessionMode: snapshot.sessionMode,
      selection: snapshot.selection,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.conversation).toMatchObject({
      projectId: seeded.workspace.id, folderId, sessionMode: 'chat', selection,
    });
    expect((await json('GET', route)).body.conversations.map((row: { id: string }) => row.id))
      .toEqual([fresh.body.conversation.id]);
    expect((await json('GET', `/api/projects/${seeded.workspace.id}`)).body).toEqual(before);
  });

  it('accepts folderId on the workspace conversation PATCH', async () => {
    const folder = await createFolder('Conversation patch');
    const created = await createSession({ title: 'Via conversation route' });
    const patched = await json(
      'PATCH',
      `/api/projects/${created.workspace.id}/conversations/${created.session.id}`,
      { folderId: folder.id },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.conversation.folderId).toBe(folder.id);
    expect(
      (await json('PATCH', `/api/projects/${created.workspace.id}/conversations/${created.session.id}`, { folderId: 'nope' })).status,
    ).toBe(404);
  });
});
