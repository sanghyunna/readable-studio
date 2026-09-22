import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDatabase, getConversation, getTemplate, insertConversation, insertProject, insertTemplate, listConversations, listTemplates, openDatabase, upsertMessage } from '../src/db.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'summary-cost-'));
  db = openDatabase(dir);
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('omits file bodies when listing metadata for twenty 1MiB templates', () => {
  // Given: actual SQLite storage, with full detail and legacy list contracts retained.
  const content = 'x'.repeat(1024 * 1024);
  db.transaction(() => {
    for (let i = 0; i < 20; i++) insertTemplate(db, { id: `t${i}`, name: `Template ${i}`, sourceProjectId: 'p', createdAt: i, files: [{ name: 'index.html', content }] });
  })();
  const prepare = vi.spyOn(db, 'prepare');
  const parse = vi.spyOn(JSON, 'parse');
  // When
  const start = performance.now();
  const summaries = listTemplates(db, { includeFiles: false });
  const bytes = Buffer.byteLength(JSON.stringify({ templates: summaries }));
  const ms = performance.now() - start;
  const parsedBytes = parse.mock.calls.reduce((sum, [json]) => sum + Buffer.byteLength(json), 0);
  console.info(JSON.stringify({ fixture: '20 templates x 1MiB', queries: prepare.mock.calls.length, parsedBytes, bytes, ms }));
  // Then
  expect(summaries).toHaveLength(20);
  expect(summaries[0]).not.toHaveProperty('files');
  expect(summaries[0]).toEqual({ id: 't19', name: 'Template 19', sourceProjectId: 'p', createdAt: 19 });
  expect(parsedBytes).toBe(0);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(bytes).toBeLessThan(3000);
  expect(getTemplate(db, 't19')?.files).toEqual([{ name: 'index.html', content }]);
  expect(listTemplates(db)[0]).toMatchObject({ files: [{ name: 'index.html', content }] });
});

it('avoids parsing event bodies when 40 conversation summaries have complete timestamps', () => {
  // Given: each latest run carries 128KiB of event data and conflicting usage duration.
  db.transaction(() => {
    for (let i = 0; i < 40; i++) {
      insertConversation(db, { id: `c${i}`, projectId: 'p', createdAt: i, updatedAt: i });
      upsertMessage(db, `c${i}`, { id: `m${i}`, role: 'assistant', content: '', runStatus: 'succeeded', startedAt: 100, endedAt: 175, events: [{ kind: 'text', text: 'x'.repeat(128 * 1024) }, { kind: 'usage', durationMs: 999 }] });
    }
  })();
  const prepare = vi.spyOn(db, 'prepare');
  const parse = vi.spyOn(JSON, 'parse');
  // When
  const start = performance.now();
  const summaries = listConversations(db, 'p');
  const bytes = Buffer.byteLength(JSON.stringify(summaries));
  const ms = performance.now() - start;
  const parsedBytes = parse.mock.calls.reduce((sum, [json]) => sum + Buffer.byteLength(json), 0);
  console.info(JSON.stringify({ fixture: '40 conversations x 128KiB events', queries: prepare.mock.calls.length, parsedBytes, bytes, ms }));
  // Then
  expect(summaries).toHaveLength(40);
  expect(summaries[0]).toMatchObject({ id: 'c39', messageCount: 1, latestRun: { status: 'succeeded', durationMs: 75 }, totalDurationMs: 75 });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(parsedBytes).toBe(0);
});

it('avoids parsing event bodies when fetching a timestamp-complete conversation', () => {
  // Given
  insertConversation(db, { id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 });
  upsertMessage(db, 'c', { id: 'm', role: 'assistant', content: '', runStatus: 'failed', startedAt: 200, endedAt: 100, events: [{ kind: 'usage', durationMs: 999 }] });
  const parse = vi.spyOn(JSON, 'parse');
  // When
  const result = getConversation(db, 'c');
  // Then
  expect(result?.latestRun).toEqual({ status: 'failed', startedAt: 200, endedAt: 100, durationMs: 0 });
  expect(parse).not.toHaveBeenCalled();
});

it('preserves empty conversations and position-ordered legacy usage fallbacks', () => {
  // Given: timestamps disagree with message position; usage-only older run contributes to total.
  insertConversation(db, { id: 'empty', projectId: 'p', createdAt: 2, updatedAt: 2 });
  insertConversation(db, { id: 'legacy', projectId: 'p', createdAt: 1, updatedAt: 1 });
  upsertMessage(db, 'legacy', { id: 'older', role: 'assistant', content: '', runStatus: 'succeeded', startedAt: 500, endedAt: 600 });
  upsertMessage(db, 'legacy', { id: 'latest', role: 'assistant', content: '', runStatus: 'failed', events: [{ kind: 'usage', durationMs: 20 }, { kind: 'usage', durationMs: 35 }] });
  upsertMessage(db, 'legacy', { id: 'user', role: 'user', content: 'next' });
  // When
  const summaries = listConversations(db, 'p');
  // Then
  const empty = summaries.find((summary) => summary.id === 'empty');
  const legacy = summaries.find((summary) => summary.id === 'legacy');
  expect(empty).toMatchObject({ id: 'empty', messageCount: 0, latestRun: undefined });
  expect(empty).not.toHaveProperty('totalDurationMs');
  expect(legacy).toMatchObject({ id: 'legacy', messageCount: 3, latestRun: { status: 'failed', durationMs: 35 }, totalDurationMs: 135 });
  expect(getConversation(db, 'legacy')?.latestRun).toEqual(legacy?.latestRun);
});
