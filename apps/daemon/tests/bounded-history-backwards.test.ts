import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, insertConversation, insertProject, listMessagePage, openDatabase, upsertMessage } from '../src/db.js';

let dir: string;
afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
it('prepends older pages until the oldest message is reached without omissions', () => {
  // Given: a history larger than one reverse page.
  dir = mkdtempSync(path.join(tmpdir(), 'history-backwards-'));
  const db = openDatabase(dir);
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 });
  for (let index = 0; index < 13; index++) upsertMessage(db, 'c', { id: `m${index}`, role: 'user', content: `${index}` });
  // When: consume newest first, then prepend each older page.
  let cursor: number | null = Number.MAX_SAFE_INTEGER;
  let ids: string[] = [];
  for (let pages = 0; cursor !== null && pages < 10; pages++) {
    const page = listMessagePage(db, 'c', { afterPosition: -1, beforePosition: cursor, maxRows: 5, maxBytes: 1024 * 1024 });
    ids = [...page.messages.map(message => message.id), ...ids];
    cursor = page.nextPosition;
  }
  // Then: chronological order and the oldest message survive every prepend.
  expect(cursor).toBeNull();
  expect(ids).toEqual(Array.from({ length: 13 }, (_, index) => `m${index}`));
});
