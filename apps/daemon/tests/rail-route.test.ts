import type http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RailSseEvent } from '@readable-studio/contracts';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';

describe('rail route and rail events', () => {
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

  /** Opens the stream; the subscription is live once the response headers arrive. */
  async function openRailEvents() {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/rail/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: RailSseEvent[] = [];
    async function next(match: (event: RailSseEvent) => boolean, timeoutMs = 5000): Promise<RailSseEvent> {
      const deadline = setTimeout(() => controller.abort(), timeoutMs);
      try {
        for (;;) {
          // Consume the match so a repeated reason waits for its own event.
          const index = events.findIndex(match);
          if (index >= 0) return events.splice(index, 1)[0]!;
          const chunk = await reader.read();
          if (chunk.done) throw new Error('rail event stream ended');
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (frame.includes('event: rail-changed') && data) events.push(JSON.parse(data.slice(6)));
            boundary = buffer.indexOf('\n\n');
          }
        }
      } finally {
        clearTimeout(deadline);
      }
    }
    return { next, close: () => controller.abort() };
  }

  it('returns folders with their sessions and standalone recents', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Rail tree' })).body.folder;
    const inFolder = (await json('POST', '/api/sessions', { title: 'In folder', folderId: folder.id })).body.session;
    const standalone = (await json('POST', '/api/sessions', { title: 'Standalone' })).body.session;

    const rail = (await json('GET', '/api/rail')).body;
    expect(typeof rail.generatedAt).toBe('number');
    const railFolder = rail.folders.find((f: any) => f.id === folder.id);
    expect(railFolder).toMatchObject({ name: 'Rail tree', sessionCount: 1 });
    expect(railFolder.sessions.map((s: any) => s.id)).toEqual([inFolder.id]);
    expect(rail.recents.map((s: any) => s.id)).toContain(standalone.id);
    expect(rail.recents.every((s: any) => s.folderId === null)).toBe(true);
    expect(rail.pinned).toEqual([]);
  });

  it('pins shortcuts in insertion order, idempotently, without moving sessions', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Pinned project' })).body.folder;
    const first = (await json('POST', '/api/sessions', { title: 'First pin', folderId: folder.id })).body.session;
    const second = (await json('POST', '/api/sessions', { title: 'Second pin' })).body.session;
    expect(await json('PUT', `/api/sessions/${second.id}/pin`)).toEqual({ status: 200, body: { pinned: [second.id] } });
    expect((await json('PUT', `/api/sessions/${first.id}/pin`)).body).toEqual({ pinned: [second.id, first.id] });
    expect((await json('PUT', `/api/sessions/${second.id}/pin`)).body).toEqual({ pinned: [second.id, first.id] });
    const rail = (await json('GET', '/api/rail')).body;
    expect(rail.pinned).toEqual([second.id, first.id]);
    expect(rail.folders.find((f: any) => f.id === folder.id).sessions.map((s: any) => s.id)).toContain(first.id);
    expect(rail.recents.map((s: any) => s.id)).toContain(second.id);
    expect((await json('DELETE', `/api/sessions/${second.id}/pin`)).body).toEqual({ pinned: [first.id] });
    expect((await json('DELETE', `/api/sessions/${second.id}/pin`)).body).toEqual({ pinned: [first.id] });
    expect((await json('DELETE', '/api/sessions/missing/pin')).status).toBe(200);
    await json('DELETE', `/api/sessions/${first.id}/pin`);
  });

  it('rejects a missing session pin with the session error code', async () => {
    expect(await json('PUT', '/api/sessions/missing/pin')).toMatchObject({
      status: 404, body: { error: { code: 'CONVERSATION_NOT_FOUND' } },
    });
  });

  it('keeps pins on move and rename, and prunes session and folder deletions', async () => {
    const folder = (await json('POST', '/api/folders', { name: 'Pin lifecycle' })).body.folder;
    const session = (await json('POST', '/api/sessions', { title: 'Keep pin' })).body.session;
    await json('PUT', `/api/sessions/${session.id}/pin`);
    await json('PATCH', `/api/sessions/${session.id}`, { folderId: folder.id });
    await json('PATCH', `/api/sessions/${session.id}`, { title: 'Renamed pin' });
    expect((await json('GET', '/api/rail')).body.pinned).toEqual([session.id]);
    await json('DELETE', `/api/sessions/${session.id}`);
    expect((await json('GET', '/api/rail')).body.pinned).toEqual([]);
    const inFolder = (await json('POST', '/api/sessions', { title: 'Delete with folder', folderId: folder.id })).body.session;
    await json('PUT', `/api/sessions/${inFolder.id}/pin`);
    await json('DELETE', `/api/folders/${folder.id}?sessions=delete`);
    expect((await json('GET', '/api/rail')).body.pinned).toEqual([]);
    const config = JSON.parse(await readFile(path.join(process.env.READABLE_DATA_DIR!, 'app-config.json'), 'utf8'));
    expect(config.pinnedSessionIds).toEqual([]);
  });

  it('filters stale pins from rail and cleans them through unpin', async () => {
    const session = (await json('POST', '/api/sessions', { title: 'Existing pin' })).body.session;
    const file = path.join(process.env.READABLE_DATA_DIR!, 'app-config.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...config, pinnedSessionIds: ['deleted-session', session.id] }));
    expect((await json('GET', '/api/rail')).body.pinned).toEqual([session.id]);
    expect((await json('DELETE', '/api/sessions/deleted-session/pin')).body).toEqual({ pinned: [session.id] });
    await json('DELETE', `/api/sessions/${session.id}/pin`);
  });

  it('emits SSE pin and unpin events, including idempotent requests', async () => {
    const session = (await json('POST', '/api/sessions', { title: 'Pin events' })).body.session;
    const stream = await openRailEvents();
    try {
      for (const method of ['PUT', 'PUT', 'DELETE', 'DELETE']) {
        await json(method, `/api/sessions/${session.id}/pin`);
        const reason = method === 'PUT' ? 'session-pinned' : 'session-unpinned';
        expect(await stream.next((event) => event.reason === reason && event.ids.includes(session.id)))
          .toMatchObject({ type: 'rail-changed', reason, ids: [session.id] });
      }
    } finally {
      stream.close();
    }
  });

  it('emits rail-changed for every session and folder mutation', async () => {
    const stream = await openRailEvents();
    try {
      const folder = (await json('POST', '/api/folders', { name: 'Events' })).body.folder;
      await stream.next((e) => e.reason === 'folder-created' && e.ids.includes(folder.id));

      await json('PATCH', `/api/folders/${folder.id}`, { name: 'Events 2' });
      await stream.next((e) => e.reason === 'folder-updated' && e.ids.includes(folder.id));

      const created = (await json('POST', '/api/sessions', { title: 'Evented' })).body;
      const sessionId = created.session.id as string;
      await stream.next((e) => e.reason === 'session-created' && e.ids.includes(sessionId));

      await json('PATCH', `/api/sessions/${sessionId}`, { folderId: folder.id });
      await stream.next((e) => e.reason === 'session-moved' && e.ids.includes(sessionId));

      await json('PATCH', `/api/sessions/${sessionId}`, { title: 'Evented renamed' });
      await stream.next((e) => e.reason === 'session-updated' && e.ids.includes(sessionId));

      await json('PATCH', `/api/projects/${created.workspace.id}/conversations/${sessionId}`, { folderId: null });
      const moved = await stream.next((e) => e.reason === 'session-moved' && e.ids.includes(sessionId));
      expect(moved.type).toBe('rail-changed');

      await json('DELETE', `/api/sessions/${sessionId}`);
      await stream.next((e) => e.reason === 'session-deleted' && e.ids.includes(sessionId));

      await json('DELETE', `/api/folders/${folder.id}`);
      await stream.next((e) => e.reason === 'folder-deleted' && e.ids.includes(folder.id));
    } finally {
      stream.close();
    }
  });
});
