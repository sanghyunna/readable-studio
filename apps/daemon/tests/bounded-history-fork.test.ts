import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as storage from '../src/db.js';

let root = '';
afterEach(() => { storage.closeDatabase(); if (root) rmSync(root, { recursive: true, force: true }); });

it('copies a long prefix losslessly without selecting message bodies into JavaScript', () => {
  // Given: multiple batches, Unicode, embedded NULs and streamed text deltas.
  root = mkdtempSync(path.join(tmpdir(), 'bounded-fork-'));
  const db = storage.openDatabase(root);
  storage.insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
  for (const id of ['source', 'fork']) storage.insertConversation(db, { id, projectId: 'p', createdAt: 1, updatedAt: 1 });
  for (let i = 0; i < 205; i++) {
    storage.upsertMessage(db, 'source', { id: `m${i}`, role: 'assistant', content: `한글\u0000😀${i}`.repeat(200), runId: 'old', runStatus: 'running' });
    storage.appendMessageAgentEvent(db, `m${i}`, { kind: 'text', text: `tail-${i}` });
  }
  const prepare = vi.spyOn(db, 'prepare');
  // When: copy through an inclusive fork point.
  storage.copyMessagePrefix(db, { sourceConversationId: 'source', targetConversationId: 'fork', throughPosition: 202 });
  const queries = prepare.mock.calls.map(([sql]) => sql);
  prepare.mockRestore();
  // Then: only bounded ID metadata is read; SQL copies raw snapshots and deltas.
  expect(queries.filter(sql => /^SELECT/i.test(sql)).every(sql => /SELECT id, position[\s\S]*LIMIT \?/i.test(sql))).toBe(true);
  const original = storage.listMessages(db, 'source', [-1, 202]);
  const copied = storage.listMessages(db, 'fork');
  expect(copied.map(m => ({ content: m.content, events: m.events }))).toEqual(original.map(m => ({ content: m.content, events: m.events })));
  expect(copied).toHaveLength(203);
  expect(copied.every(m => !m.runId && !m.runStatus && !m.lastRunEventId)).toBe(true);
});
