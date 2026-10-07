import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  countConversationsInWorkspace,
  deleteFolder,
  getConversation,
  getFolder,
  insertConversation,
  insertFolder,
  insertProject,
  listConversations,
  listFolders,
  listRailSessions,
  openDatabase,
  updateConversation,
  updateFolder,
} from '../src/db.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'readable-session-folders-'));
  file = path.join(dir, 'app.sqlite');
});
afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  return openDatabase(dir, { dataDir: dir });
}

// Rebuild the current schema as it was at version 2: no session_folders table
// and no conversations.folder_id column.
function writeVersion2Database(seed: (raw: Database.Database) => void): void {
  open();
  closeDatabase();
  const raw = new Database(file);
  try {
    raw.pragma('foreign_keys = OFF');
    const columns = (raw.prepare('PRAGMA table_info(conversations)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>).filter((column) => column.name !== 'folder_id');
    const definitions = columns.map((c) => `${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}` +
      `${c.notnull ? ' NOT NULL' : ''}${c.dflt_value === null ? '' : ` DEFAULT ${c.dflt_value}`}`);
    raw.exec(`
      DROP INDEX idx_conv_folder;
      CREATE TABLE conversations_v2 (${definitions.join(', ')},
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
      DROP TABLE conversations;
      ALTER TABLE conversations_v2 RENAME TO conversations;
      CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);
      DROP TABLE session_folders;
    `);
    raw.pragma('foreign_keys = ON');
    seed(raw);
    raw.pragma('user_version = 2');
  } finally {
    raw.close();
  }
}

function counts(db: Database.Database) {
  return Object.fromEntries(['projects', 'conversations', 'messages'].map((table) => [
    table, db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
  ]));
}

describe('schema 3 session folder migration', () => {
  it('backfills folders from a populated version 2 database with a pre-2 snapshot', () => {
    writeVersion2Database((raw) => {
      raw.exec(`
        INSERT INTO projects (id, name, created_at, updated_at) VALUES
          ('p0', 'Empty workspace', 10, 11),
          ('p1', 'Solo deck', 20, 21),
          ('p1-titled', 'Solo titled', 25, 26),
          ('p3', 'Databricks MLOps', 30, 31);
        INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES
          ('c1', 'p1', NULL, 20, 22),
          ('c1-titled', 'p1-titled', 'Kept title', 25, 27),
          ('c3a', 'p3', NULL, 30, 32),
          ('c3b', 'p3', 'Second', 30, 33),
          ('c3c', 'p3', 'Third', 30, 34);
        INSERT INTO messages (id, conversation_id, role, content, position, created_at) VALUES
          ('m1', 'c1', 'user', 'hello', 0, 22),
          ('m3', 'c3a', 'user', 'hi', 0, 32);
      `);
    });
    const before = (() => {
      const raw = new Database(file, { readonly: true });
      try { return counts(raw); } finally { raw.close(); }
    })();
    expect(before).toEqual({ projects: 4, conversations: 5, messages: 2 });

    const db = open();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(counts(db)).toEqual(before);

    const folders = db.prepare('SELECT * FROM session_folders').all();
    expect(folders).toEqual([
      { id: expect.any(String), name: 'Databricks MLOps', created_at: 30, updated_at: 31 },
    ]);
    const folderId = (folders[0] as { id: string }).id;
    const conversations = db
      .prepare('SELECT id, project_id, title, folder_id FROM conversations ORDER BY id')
      .all();
    expect(conversations).toEqual([
      { id: 'c1', project_id: 'p1', title: 'Solo deck', folder_id: null },
      { id: 'c1-titled', project_id: 'p1-titled', title: 'Kept title', folder_id: null },
      { id: 'c3a', project_id: 'p3', title: null, folder_id: folderId },
      { id: 'c3b', project_id: 'p3', title: 'Second', folder_id: folderId },
      { id: 'c3c', project_id: 'p3', title: 'Third', folder_id: folderId },
    ]);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'idx_conv_folder'").get()).toBeTruthy();

    expect(existsSync(`${file}.pre-2`)).toBe(true);
    const snapshot = new Database(`${file}.pre-2`, { readonly: true });
    try {
      expect(snapshot.pragma('user_version', { simple: true })).toBe(2);
      expect(counts(snapshot)).toEqual(before);
      expect(snapshot.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_folders'").get()).toBeUndefined();
      expect(snapshot.prepare('PRAGMA table_info(conversations)').all())
        .not.toContainEqual(expect.objectContaining({ name: 'folder_id' }));
    } finally {
      snapshot.close();
    }

    closeDatabase();
    const reopened = open();
    expect(reopened.prepare('SELECT COUNT(*) FROM session_folders').pluck().get()).toBe(1);
  });

  it('creates the folder table and column on a fresh database without backfilling', () => {
    const db = open();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare('PRAGMA table_info(conversations)').all())
      .toContainEqual(expect.objectContaining({ name: 'folder_id' }));
    expect(listFolders(db)).toEqual([]);
  });
});

describe('session folder helpers', () => {
  function seed() {
    const db = open();
    insertProject(db, { id: 'w1', name: 'Workspace one', createdAt: 1, updatedAt: 1 });
    insertProject(db, { id: 'w2', name: 'Workspace two', createdAt: 1, updatedAt: 1 });
    insertFolder(db, { id: 'f1', name: 'Folder one', createdAt: 5, updatedAt: 5 });
    return db;
  }

  it('inherits the folder of the most recently updated sibling when folderId is omitted', () => {
    const db = seed();
    insertConversation(db, { id: 'old', projectId: 'w1', folderId: null, createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'recent', projectId: 'w1', folderId: 'f1', createdAt: 2, updatedAt: 2 });
    expect(insertConversation(db, { id: 'fork', projectId: 'w1', createdAt: 3, updatedAt: 3 })?.folderId).toBe('f1');
    expect(insertConversation(db, { id: 'explicit', projectId: 'w1', folderId: null, createdAt: 4, updatedAt: 4 })?.folderId)
      .toBeNull();
    expect(insertConversation(db, { id: 'first', projectId: 'w2', createdAt: 5, updatedAt: 5 })?.folderId).toBeNull();
    expect(listConversations(db, 'w1').map((c) => [c.id, c.folderId])).toEqual([
      ['explicit', null], ['fork', 'f1'], ['recent', 'f1'], ['old', null],
    ]);
  });

  it('moves a session with updateConversation and keeps the folder on unrelated patches', () => {
    const db = seed();
    insertConversation(db, { id: 'c', projectId: 'w1', folderId: 'f1', createdAt: 1, updatedAt: 1 });
    expect(updateConversation(db, 'c', { title: 'Renamed' })?.folderId).toBe('f1');
    const moved = updateConversation(db, 'c', { folderId: null, updatedAt: 1 });
    expect(moved).toMatchObject({ folderId: null, title: 'Renamed', updatedAt: 1, projectId: 'w1' });
    expect(updateConversation(db, 'c', { folderId: 'f1' })?.folderId).toBe('f1');
  });

  it('lists, renames and deletes folders; deletion makes sessions standalone', () => {
    const db = seed();
    insertFolder(db, { id: 'f2', name: 'Folder two', createdAt: 6, updatedAt: 6 });
    insertConversation(db, { id: 'a', projectId: 'w1', folderId: 'f1', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'b', projectId: 'w2', folderId: 'f1', createdAt: 1, updatedAt: 1 });
    expect(listFolders(db)).toEqual([
      { id: 'f2', name: 'Folder two', createdAt: 6, updatedAt: 6, sessionCount: 0 },
      { id: 'f1', name: 'Folder one', createdAt: 5, updatedAt: 5, sessionCount: 2 },
    ]);
    expect(updateFolder(db, 'f1', { name: 'Renamed', updatedAt: 9 }))
      .toEqual({ id: 'f1', name: 'Renamed', createdAt: 5, updatedAt: 9, sessionCount: 2 });
    expect(updateFolder(db, 'missing', { name: 'x' })).toBeNull();
    expect(deleteFolder(db, 'f1')).toBe(true);
    expect(deleteFolder(db, 'f1')).toBe(false);
    expect(getFolder(db, 'f1')).toBeNull();
    expect(getConversation(db, 'a')?.folderId).toBeNull();
    expect(getConversation(db, 'b')?.folderId).toBeNull();
    expect(countConversationsInWorkspace(db, 'w1')).toBe(1);
  });

  it('lists rail sessions across workspaces newest first with placement and sharing', () => {
    const db = seed();
    insertConversation(db, { id: 'w1-a', projectId: 'w1', folderId: 'f1', createdAt: 1, updatedAt: 10 });
    insertConversation(db, { id: 'w2-a', projectId: 'w2', folderId: null, createdAt: 1, updatedAt: 30 });
    insertConversation(db, { id: 'w1-b', projectId: 'w1', folderId: null, createdAt: 1, updatedAt: 20 });
    expect(listRailSessions(db).map((s) => ({
      id: s.id, projectId: s.projectId, folderId: s.folderId,
      workspaceName: s.workspaceName, workspaceSessionCount: s.workspaceSessionCount,
    }))).toEqual([
      { id: 'w2-a', projectId: 'w2', folderId: null, workspaceName: 'Workspace two', workspaceSessionCount: 1 },
      { id: 'w1-b', projectId: 'w1', folderId: null, workspaceName: 'Workspace one', workspaceSessionCount: 2 },
      { id: 'w1-a', projectId: 'w1', folderId: 'f1', workspaceName: 'Workspace one', workspaceSessionCount: 2 },
    ]);
    expect(countConversationsInWorkspace(db, 'w1')).toBe(2);
    expect(countConversationsInWorkspace(db, 'missing')).toBe(0);
  });
});
