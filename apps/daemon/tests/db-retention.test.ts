import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendMessageAgentEvent, closeDatabase, insertConversation, insertProject, listMessages, listMessagePage, openDatabase, upsertMessage } from '../src/db.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'daemon-retention-'));
  db = openDatabase(dir);
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 });
  upsertMessage(db, 'c', { id: 'm', role: 'assistant', content: 'legacy', events: [{ kind: 'text', text: 'legacy' }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

it('serializes linear event bytes when the event count doubles', () => {
  // Given: real SQLite and a counter of actual serialization work, not elapsed time.
  const stringify = JSON.stringify;
  let bytes = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
    const result = stringify(value);
    bytes += result?.length ?? 0;
    return result;
  });
  // When: append equal-sized events in two equal batches.
  for (let i = 0; i < 100; i++) appendMessageAgentEvent(db, 'm', { kind: 'text', text: `${i.toString().padStart(4, '0')} xyz` });
  const first = bytes;
  for (let i = 100; i < 200; i++) appendMessageAgentEvent(db, 'm', { kind: 'text', text: `${i.toString().padStart(4, '0')} xyz` });
  const second = bytes - first;
  spy.mockRestore();
  // Then: cumulative work is linear, rather than the second batch costing ~3x.
  expect(second).toBeLessThanOrEqual(first * 1.1);
});

it('preserves legacy raw bytes and exposes ordered incremental content to SQL readers after reopen', () => {
  // Given: a legacy snapshot with deliberately noncanonical JSON whitespace.
  const legacy = '[ { "kind": "text", "text": "legacy" } ]';
  db.prepare('UPDATE messages SET events_json = ? WHERE id = ?').run(legacy, 'm');
  // When: append and reopen the database.
  appendMessageAgentEvent(db, 'm', { kind: 'text', text: '\n한글\u0000' });
  closeDatabase();
  db = openDatabase(dir);
  // Then: all existing consumers, including raw SQL export, see the complete data.
  const message = listMessages(db, 'c')[0];
  expect(message?.content).toBe('legacy\n한글\u0000');
  expect(message?.events).toEqual([{ kind: 'text', text: 'legacy' }, { kind: 'text', text: '\n한글\u0000' }]);
  expect(db.prepare('SELECT content, events_json FROM messages WHERE id = ?').get('m')).toEqual({ content: message?.content, events_json: JSON.stringify(message?.events) });
  expect(db.prepare('SELECT events_json FROM message_snapshots WHERE id = ?').pluck().get('m')).toBe(legacy);
});

it('bounds history pages by rows and bytes without skipping an oversized message', () => {
  // Given: enough rows to exceed the row budget, then a single oversized row.
  for (let i = 0; i < 12; i++) upsertMessage(db, 'c', { id: `m${i}`, role: 'user', content: '한글'.repeat(100) });
  upsertMessage(db, 'c', { id: 'huge', role: 'user', content: 'x'.repeat(2_000_000) });
  // When: read a bounded page and continue from its cursor.
  const page = listMessagePage(db, 'c', { afterPosition: -1, maxRows: 5, maxBytes: 8192 });
  const oversized = listMessagePage(db, 'c', { afterPosition: 12, maxRows: 5, maxBytes: 8192 });
  // Then: the envelope is bounded and oversized data is explicit, never silently omitted.
  expect(page.messages.length).toBeGreaterThan(0);
  expect(page.messages.length).toBeLessThanOrEqual(5);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
  expect(page.nextPosition).toBeGreaterThanOrEqual(0);
  expect(oversized.messages).toEqual([]);
  expect(oversized.oversizedMessageId).toBe('huge');
  expect(oversized.nextPosition).not.toBe(12);
  expect(listMessages(db, 'c').at(-1)?.content).toHaveLength(2_000_000);
});

it('replaces an incremental snapshot without duplicating streamed events', () => {
  // Given: a partial stream.
  appendMessageAgentEvent(db, 'm', { kind: 'text', text: ' partial' });
  const saved = listMessages(db, 'c')[0];
  expect(saved).toBeDefined();
  // When: the UI persists its full snapshot and more text arrives.
  upsertMessage(db, 'c', { ...saved, id: 'm' });
  appendMessageAgentEvent(db, 'm', { kind: 'text', text: ' done' });
  // Then: partial and final content retain their exact ordering once each.
  expect(listMessages(db, 'c')[0]?.content).toBe('legacy partial done');
  expect(listMessages(db, 'c')[0]?.events).toHaveLength(3);
});
