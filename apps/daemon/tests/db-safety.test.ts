import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  DatabaseOpenError,
  openDatabase,
  openHostedDatabaseAtPath,
  READABLE_STUDIO_SQLITE_APPLICATION_ID,
} from '../src/db.js';

const supportedVersion = 1;
let root: string;
let file: string;

beforeEach(() => {
  const base = path.resolve('../../.tmp/db-safety');
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, 'fixture-'));
  file = path.join(root, 'app.sqlite');
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function legacyFixture(): void {
  const db = new Database(file);
  try {
    db.pragma(`application_id = ${READABLE_STUDIO_SQLITE_APPLICATION_ID}`);
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT,
        design_system_id TEXT, pending_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, events_json TEXT, position INTEGER NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE preview_comments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, file_path TEXT NOT NULL, element_id TEXT NOT NULL,
        selector TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, position_json TEXT NOT NULL,
        html_hint TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(project_id, conversation_id, file_path, element_id));
      INSERT INTO projects VALUES ('project', 'Saved project', NULL, NULL, NULL, 1, 1);
      INSERT INTO conversations VALUES ('conversation', 'project', 'Saved conversation', 1, 1);
      INSERT INTO messages VALUES ('message', 'conversation', 'user', 'Saved message', NULL, 0, 1);
    `);
    const insert = db.prepare(`INSERT INTO preview_comments VALUES
      (?, 'project', 'conversation', 'index.html', ?, '#element', 'label', 'text', '{}', '', 'note', 'open', 1, 1)`);
    for (let index = 0; index < 4; index += 1) insert.run(`comment-${index}`, `element-${index}`);
  } finally {
    db.close();
  }
}

function openLocal(): Database.Database {
  return openDatabase(root, { dataDir: root });
}

function countComments(db: Database.Database): number {
  return db.prepare('SELECT count(*) FROM preview_comments').pluck().get() as number;
}

describe('database migration safety', () => {
  it.each(['local', 'hosted'] as const)('refuses a future schema through the %s open path without changing bytes', (mode) => {
    legacyFixture();
    const future = new Database(file);
    future.pragma(`user_version = ${supportedVersion + 1}`);
    future.close();
    const before = fs.readFileSync(file);
    const refusalLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failure: unknown;
    try {
      const opened = mode === 'local' ? openLocal() : openHostedDatabaseAtPath(file);
      if (mode === 'hosted') opened.close();
    } catch (error) {
      failure = error;
    }
    const record = refusalLog.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(record).toEqual([{
      type: 'readable-studio:database-open-refusal',
      code: 'SCHEMA_VERSION_NEWER', pid: process.pid,
      databaseVersion: 2, supportedVersion: 1,
    }]);
    expect(failure).toBeInstanceOf(DatabaseOpenError);
    expect(failure).toMatchObject({ code: 'SCHEMA_VERSION_NEWER', databaseVersion: 2, supportedVersion: 1 });
    expect((failure as Error).message).toMatch(/schema version 2.*supports.*1/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(`${file}.pre-2`)).toBe(false);
  });

  it('snapshots pre-migration schema and all rows, including committed WAL rows', () => {
    legacyFixture();
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare("UPDATE messages SET content = 'Committed WAL message'").run();
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    try {
      const migrated = openLocal();
      expect(migrated.pragma('user_version', { simple: true })).toBe(supportedVersion);
      expect(countComments(migrated)).toBe(4);
      const snapshot = new Database(`${file}.pre-0`, { readonly: true, fileMustExist: true });
      try {
        expect(snapshot.pragma('user_version', { simple: true })).toBe(0);
        expect(countComments(snapshot)).toBe(4);
        expect(snapshot.prepare('SELECT content FROM messages').pluck().get()).toBe('Committed WAL message');
        expect(snapshot.prepare('PRAGMA table_info(preview_comments)').all()).not.toContainEqual(expect.objectContaining({ name: 'slide_key' }));
      } finally {
        snapshot.close();
      }
    } finally {
      writer.close();
    }
  });

  it('rolls back the entire migration after an interruption immediately after dropping the comments table', () => {
    legacyFixture();
    const exec = Database.prototype.exec;
    let interrupted = false;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      const marker = 'DROP TABLE preview_comments;';
      if (sql.includes(marker)) {
        exec.call(this, sql.slice(0, sql.indexOf(marker) + marker.length));
        interrupted = true;
        throw new Error('injected migration interruption');
      }
      return exec.call(this, sql);
    });
    expect(openLocal).toThrow(DatabaseOpenError);
    expect(interrupted).toBe(true);
    vi.restoreAllMocks();
    const recovered = new Database(file, { readonly: true });
    try {
      expect(countComments(recovered)).toBe(4);
      expect(recovered.pragma('user_version', { simple: true })).toBe(0);
      expect(recovered.prepare("SELECT name FROM sqlite_schema WHERE name = 'preview_comments_next'").get()).toBeUndefined();
      expect(recovered.prepare('PRAGMA table_info(projects)').all()).not.toContainEqual(expect.objectContaining({ name: 'metadata_json' }));
    } finally {
      recovered.close();
    }
    expect(countComments(openLocal())).toBe(4);
  });

  it('fails closed when VACUUM INTO fails, leaving schema and rows unchanged', () => {
    legacyFixture();
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (/^VACUUM INTO/i.test(sql)) throw new Error('injected disk-full snapshot failure');
      return prepare.call(this, sql);
    });
    expect(openLocal).toThrow(expect.objectContaining({ code: 'PRE_MIGRATION_SNAPSHOT_FAILED' }));
    vi.restoreAllMocks();
    const db = new Database(file, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(countComments(db)).toBe(4);
      expect(db.prepare('PRAGMA table_info(projects)').all()).not.toContainEqual(expect.objectContaining({ name: 'metadata_json' }));
    } finally {
      db.close();
    }
  });

  it('never reuses a corrupt snapshot or migrates without a valid rollback point', () => {
    legacyFixture();
    fs.writeFileSync(`${file}.pre-0`, 'incomplete snapshot');
    expect(openLocal).toThrow(expect.objectContaining({ code: 'PRE_MIGRATION_SNAPSHOT_FAILED' }));
    const db = new Database(file, { readonly: true });
    try {
      expect(countComments(db)).toBe(4);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('cleans up an unpublished snapshot after a publish failure and can retry safely', () => {
    legacyFixture();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected sharing violation'); });
    expect(openLocal).toThrow(expect.objectContaining({ code: 'PRE_MIGRATION_SNAPSHOT_FAILED' }));
    expect(fs.readdirSync(root).filter((name) => name.includes('.pre-'))).toEqual([]);
    vi.restoreAllMocks();
    expect(countComments(openLocal())).toBe(4);
    expect(fs.existsSync(`${file}.pre-0`)).toBe(true);
  });

  it('bounds retained snapshots to three, always preserving the current rollback point and live DB', () => {
    legacyFixture();
    // A user can restore a version-0 DB while retaining snapshots from later builds.
    for (const version of [1, 2, 3, 4]) fs.copyFileSync(file, `${file}.pre-${version}`);
    fs.writeFileSync(`${file}.pre-unrelated`, 'not a versioned snapshot');
    expect(countComments(openLocal())).toBe(4);
    expect(fs.readdirSync(root).filter((name) => /^app\.sqlite\.pre-\d+$/.test(name)).sort())
      .toEqual(['app.sqlite.pre-0', 'app.sqlite.pre-3', 'app.sqlite.pre-4']);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(`${file}.pre-unrelated`, 'utf8')).toBe('not a versioned snapshot');
  });

  it('reuses an existing same-version snapshot and does no migration on an equal version', () => {
    legacyFixture();
    const source = new Database(file);
    source.prepare('VACUUM INTO ?').run(`${file}.pre-0`);
    source.close();
    const before = fs.readFileSync(`${file}.pre-0`);
    const prepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (/^VACUUM INTO/i.test(sql)) throw new Error('snapshot must be reused');
      return prepare.call(this, sql);
    });
    expect(countComments(openLocal())).toBe(4);
    expect(fs.readFileSync(`${file}.pre-0`)).toEqual(before);
    closeDatabase();
    spy.mockRestore();
    const exec = vi.spyOn(Database.prototype, 'exec');
    expect(countComments(openLocal())).toBe(4);
    expect(exec).not.toHaveBeenCalled();
  });
});
