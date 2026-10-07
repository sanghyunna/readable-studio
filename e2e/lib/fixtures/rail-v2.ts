import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type SqliteDatabase = { close(): void; exec(sql: string): void; prepare(sql: string): { run(...parameters: unknown[]): void } };
type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;
// better-sqlite3 is a daemon runtime dependency. Requiring it keeps this
// e2e-only fixture independent from daemon-private source modules.
const Database = require('better-sqlite3') as SqliteDatabaseConstructor;

export const RAIL_V2_PROJECTS = {
  multi: 'rail-v2-multi',
  single: 'rail-v2-single',
  empty: 'rail-v2-empty',
} as const;

/** Writes the smallest committed v2-shaped database that exercises all migration branches. */
export async function writeRailV2Fixture(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'app.sqlite'));
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        skill_id TEXT,
        design_system_id TEXT,
        pending_prompt TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        events_json TEXT,
        attachments_json TEXT,
        produced_files_json TEXT,
        feedback_json TEXT,
        pre_turn_file_names_json TEXT,
        session_mode TEXT,
        run_context_json TEXT,
        applied_plugin_snapshot_json TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 2;
    `);
    const insertProject = db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    insertProject.run(RAIL_V2_PROJECTS.multi, 'Migrated folder', 1, 20);
    insertProject.run(RAIL_V2_PROJECTS.single, 'Migrated standalone', 2, 21);
    insertProject.run(RAIL_V2_PROJECTS.empty, 'Empty workspace', 3, 22);
    const insertConversation = db.prepare(
      'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertConversation.run('rail-v2-multi-a', RAIL_V2_PROJECTS.multi, 'First migrated session', 4, 23);
    insertConversation.run('rail-v2-multi-b', RAIL_V2_PROJECTS.multi, 'Second migrated session', 5, 24);
    insertConversation.run('rail-v2-single', RAIL_V2_PROJECTS.single, null, 6, 25);
  } finally {
    db.close();
  }
}
