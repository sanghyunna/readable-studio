import { afterEach, beforeEach, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendMessageAgentEvent, closeDatabase, insertConversation, insertProject, listMessages, openDatabase, upsertMessage } from '../src/db.js';
import { registerMessageHistoryRoutes } from '../src/message-history-routes.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let server: Server;
let url: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'bounded-history-'));
  db = openDatabase(dir);
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 });
  const app = express();
  registerMessageHistoryRoutes(app, db);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listen address');
  url = `http://127.0.0.1:${address.port}/api/projects/p/conversations/c/messages`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

it('caps both reachable history endpoints and reaches every row through cursors', async () => {
  // Given: a history larger than either page budget.
  for (let index = 0; index < 220; index++) upsertMessage(db, 'c', { id: `m${index}`, role: 'user', content: '한글'.repeat(400) });
  // When: traverse the actual HTTP surface, including the compatibility route.
  const legacy = await (await fetch(url)).text();
  const seen: string[] = [];
  let cursor: number | null = -1;
  do {
    const response = await fetch(`${url}/page?afterPosition=${cursor}`);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
    const page = JSON.parse(text);
    seen.push(...page.messages.map((message: { id: string }) => message.id));
    cursor = page.nextPosition;
  } while (cursor !== null);
  // Then: compatibility is capped and no oldest or newest row goes missing.
  expect(Buffer.byteLength(legacy)).toBeLessThanOrEqual(1024 * 1024);
  expect(JSON.parse(legacy).messages.length).toBeLessThanOrEqual(100);
  expect(seen).toEqual(Array.from({ length: 220 }, (_, index) => `m${index}`));
});

it('advances beyond an oversized row and transfers its exact body and metadata in bounded fragments', async () => {
  // Given: multibyte text crossing fragment boundaries, plus persisted event deltas.
  upsertMessage(db, 'c', { id: 'huge', role: 'assistant', content: '한글🙂'.repeat(100_000), events: [{ kind: 'text', text: 'start' }], attachments: [{ name: 'artifact.html', path: '/artifact.html' }] });
  appendMessageAgentEvent(db, 'huge', { kind: 'text', text: ' streamed partial' });
  upsertMessage(db, 'c', { id: 'last', role: 'user', content: 'end' });
  const before = JSON.stringify(listMessages(db, 'c'));
  // When: read the page, then each bounded transfer fragment.
  const page: { readonly nextPosition: number; readonly oversizedMessageId?: string } = JSON.parse(await (await fetch(`${url}/page`)).text());
  const fields: Record<string, unknown> = {};
  let cursor: string | null = '0:0:0';
  const chunks: Buffer[] = [];
  do {
    const text = await (await fetch(`${url}/huge/parts?cursor=${cursor}`)).text();
    expect(Buffer.byteLength(text)).toBeLessThan(45_000);
    const part = JSON.parse(text);
    if (part.data !== null) {
      chunks.push(Buffer.from(part.data, 'base64'));
      if (part.endField) {
        const raw = Buffer.concat(chunks.splice(0)).toString('utf8');
        fields[part.field] = part.encoding === 'json' ? JSON.parse(raw) : part.encoding === 'number' ? Number(raw) : raw;
      }
    }
    cursor = part.nextCursor;
  } while (cursor !== null);
  const next: { readonly messages: readonly { readonly id: string }[] } = JSON.parse(await (await fetch(`${url}/page?afterPosition=${page.nextPosition}`)).text());
  // Then: the big row doesn't wedge progress or change any persisted/export source bytes.
  expect(page.oversizedMessageId).toBe('huge');
  expect(page.nextPosition).toBe(0);
  expect(next.messages.map((message: { id: string }) => message.id)).toEqual(['last']);
  expect(fields.content).toBe('한글🙂'.repeat(100_000));
  expect(fields.event).toEqual({ kind: 'text', text: ' streamed partial' });
  expect(fields.attachments).toEqual([{ name: 'artifact.html', path: '/artifact.html' }]);
  expect(JSON.stringify(listMessages(db, 'c'))).toBe(before);
});
