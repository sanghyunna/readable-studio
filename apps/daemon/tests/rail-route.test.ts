import type http from 'node:http';
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
