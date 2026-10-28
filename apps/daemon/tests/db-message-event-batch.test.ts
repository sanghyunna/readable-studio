import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendMessageAgentEvent,
  batchMessageAgentEvents,
  clearAgentSession,
  closeDatabase,
  getAgentSession,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  upsertAgentSession,
  upsertMessage,
} from '../src/db.js';
import { persistRunEventsPerStdoutChunk } from '../src/server.js';
import { readWalCommits } from './helpers/wal-commits.js';

type Db = ReturnType<typeof openDatabase>;

// Covers every dedupe branch: repeats, timestamped repeats, invalid events, a missing message.
const SCRIPT: Array<[string, Record<string, unknown> | null]> = [
  ['m', { kind: 'status', label: 'starting', detail: 'bin' }],
  ['m', { kind: 'status', label: 'starting', detail: 'bin' }],
  ['m', { kind: 'text', text: 'a' }],
  ['m', { kind: 'text', text: 'a' }],
  ['m', { kind: 'text', text: 'b' }],
  ['m', { kind: 'thinking', text: 'hm' }],
  ['m', { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
  ['m', { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }],
  ['m', { kind: 'text', text: 'x', timestamp: 5 }],
  ['m', { kind: 'text', text: 'x', timestamp: 5 }],
  ['m', { kind: 'text', text: 'x', timestamp: 6 }],
  ['m', { kind: '' }],
  ['m', null],
  ['missing', { kind: 'text', text: 'lost' }],
  ['m', { kind: 'usage', inputTokens: 1, outputTokens: 2 }],
];

function seed(db: Db, ids: string[]) {
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'c', projectId: 'p', title: 'c', createdAt: 1, updatedAt: 1 });
  for (const id of ids) {
    upsertMessage(db, 'c', { id, role: 'assistant', content: '', runStatus: 'running', events: [] });
  }
}

function deltaRows(db: Db, messageId: string) {
  return db.prepare('SELECT event_json AS eventJson FROM message_event_deltas WHERE message_id = ? ORDER BY sequence')
    .all(messageId) as Array<{ eventJson: string }>;
}

describe('message event batches', () => {
  let tempDir: string;
  let dbFile: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'readable-event-batch-'));
    dbFile = path.join(tempDir, 'app.sqlite');
    db = openDatabase(tempDir, { dataDir: tempDir });
    vi.spyOn(Date, 'now').mockReturnValue(1234);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists exactly the rows, order and return values of the per-event path', () => {
    seed(db, ['m']);
    const unbatched = SCRIPT.map(([id, event]) => appendMessageAgentEvent(db, id, event as never));
    const expectedRows = deltaRows(db, 'm');
    const expectedMessage = listMessages(db, 'c')[0];
    db.prepare('DELETE FROM message_event_deltas').run();

    const batched = batchMessageAgentEvents(db, () => SCRIPT.map(([id, event]) => appendMessageAgentEvent(db, id, event as never)), () => {});

    expect(batched).toEqual(unbatched);
    expect(unbatched).toEqual([true, false, true, false, true, true, true, true, true, false, true, null, null, null, true]);
    expect(deltaRows(db, 'm')).toEqual(expectedRows);
    expect(listMessages(db, 'c')[0]).toEqual(expectedMessage);
    expect(expectedMessage?.content).toBe('abxx');
  });

  it('commits N deltas emitted by one stdout chunk once instead of N times', () => {
    seed(db, ['m']);
    const appendBurst = (prefix: string) => {
      for (let i = 0; i < 40; i++) appendMessageAgentEvent(db, 'm', { kind: 'text', text: `${prefix}${i}` });
    };
    const before = readWalCommits(dbFile).commits;
    appendBurst('u');
    const unbatched = readWalCommits(dbFile).commits - before;

    const stdout = new PassThrough();
    persistRunEventsPerStdoutChunk(db, stdout);
    stdout.on('data', () => appendBurst('a'));
    // A nested unit joins the outer batch instead of committing on its own.
    stdout.on('data', () => batchMessageAgentEvents(db, () => appendBurst('b'), () => {}));
    stdout.emit('data', 'chunk');
    const batched = readWalCommits(dbFile).commits - before - unbatched;

    expect({ unbatched, batched }).toEqual({ unbatched: 40, batched: 1 });
    expect(readWalCommits(dbFile).wrapped).toBe(false);
    expect(deltaRows(db, 'm')).toHaveLength(120);
  });

  it('opens no transaction for a chunk that persists nothing', () => {
    seed(db, ['m']);
    const before = readWalCommits(dbFile).commits;
    batchMessageAgentEvents(db, () => {
      expect(appendMessageAgentEvent(db, 'missing', { kind: 'text', text: 'x' })).toBeNull();
      expect(db.inTransaction).toBe(false);
    }, () => {});
    expect(readWalCommits(dbFile).commits).toBe(before);
  });

  it('shows rows to same-connection reads inside the unit and commits them before returning', () => {
    seed(db, ['m']);
    const other = new Database(dbFile, { readonly: true });
    try {
      batchMessageAgentEvents(db, () => {
        appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'one' });
        expect(listMessages(db, 'c')[0]?.content).toBe('one');
        expect(other.prepare('SELECT COUNT(*) AS n FROM message_event_deltas').get()).toEqual({ n: 0 });
      }, () => {});
      expect(db.inTransaction).toBe(false);
      expect(other.prepare('SELECT COUNT(*) AS n FROM message_event_deltas').get()).toEqual({ n: 1 });
    } finally {
      other.close();
    }
  });

  it('still commits rows persisted before the unit throws and rethrows the same error', () => {
    seed(db, ['m']);
    const failure = new Error('parser blew up');
    expect(() => batchMessageAgentEvents(db, () => {
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'kept' });
      throw failure;
    }, () => {})).toThrow(failure);
    expect(db.inTransaction).toBe(false);
    expect(listMessages(db, 'c')[0]?.content).toBe('kept');
  });

  it('re-inserts rows one commit each when COMMIT fails', () => {
    seed(db, ['m']);
    const lost = vi.fn();
    const before = readWalCommits(dbFile).commits;
    batchMessageAgentEvents(db, () => {
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'one' });
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'two' });
      // A deferred FK violation is a deterministic way to make COMMIT fail.
      db.pragma('defer_foreign_keys = ON');
      db.prepare('INSERT INTO message_event_deltas (message_id, event_json) VALUES (?, ?)').run('ghost', '{}');
    }, lost);
    expect(db.inTransaction).toBe(false);
    expect(lost).not.toHaveBeenCalled();
    expect(readWalCommits(dbFile).commits - before).toBe(2);
    expect(deltaRows(db, 'm').map((row) => JSON.parse(row.eventJson).text)).toEqual(['one', 'two']);
    expect(deltaRows(db, 'ghost')).toEqual([]);
  });

  it('keeps clearAgentSession inside a unit its own autocommit, also when the batch COMMIT then fails', () => {
    // A Pi resume error clears the stored session from inside the stdout chunk.
    seed(db, ['m']);
    upsertAgentSession(db, { conversationId: 'c', agentId: 'pi', sessionId: 'stale' });
    const other = new Database(dbFile, { readonly: true });
    const count = (table: string) => (other.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const lost = vi.fn();
    const before = readWalCommits(dbFile).commits;
    try {
      batchMessageAgentEvents(db, () => {
        appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'one' });
        clearAgentSession(db, 'c', 'pi');
        // Per-event path: 'one' and then the delete are each committed by now.
        expect(db.inTransaction).toBe(false);
        expect({ deltas: count('message_event_deltas'), sessions: count('agent_sessions') }).toEqual({ deltas: 1, sessions: 0 });
        appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'two' });
        db.pragma('defer_foreign_keys = ON');
        db.prepare('INSERT INTO message_event_deltas (message_id, event_json) VALUES (?, ?)').run('ghost', '{}');
      }, lost);
    } finally {
      other.close();
    }
    expect(lost).not.toHaveBeenCalled();
    expect(getAgentSession(db, 'c', 'pi')).toBeNull();
    expect(deltaRows(db, 'm').map((row) => JSON.parse(row.eventJson).text)).toEqual(['one', 'two']);
    // 'one', the delete, then 'two' replayed after its batch COMMIT failed.
    expect(readWalCommits(dbFile).commits - before).toBe(3);
  });

  it('reports a failed ROLLBACK instead of throwing out of the stdout emit, without duplicating rows', () => {
    seed(db, ['m']);
    const statementProto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Database.Statement;
    const run = statementProto.run;
    const rollbackFailure = new Error('rollback failed');
    vi.spyOn(statementProto, 'run').mockImplementation(function (this: Database.Statement, ...args: unknown[]) {
      if (this.source === 'ROLLBACK') throw rollbackFailure;
      return run.apply(this, args);
    });
    const stdout = new PassThrough();
    persistRunEventsPerStdoutChunk(db, stdout);
    stdout.on('data', () => {
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'one' });
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'two' });
      db.pragma('defer_foreign_keys = ON');
      db.prepare('INSERT INTO message_event_deltas (message_id, event_json) VALUES (?, ?)').run('ghost', '{}');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => stdout.emit('data', 'chunk')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[runs] message event persistence failed', rollbackFailure);
    // The transaction is still open, so its rows were not lost and are not re-inserted.
    expect(db.inTransaction).toBe(true);
    expect(deltaRows(db, 'm')).toHaveLength(2);
    vi.mocked(statementProto.run).mockRestore();
    db.exec('ROLLBACK');
  });

  it('restores rows SQLite rolled back mid-unit before deduping the next event', () => {
    seed(db, ['m']);
    batchMessageAgentEvents(db, () => {
      appendMessageAgentEvent(db, 'm', { kind: 'status', label: 'running' });
      db.exec('ROLLBACK'); // what SQLite does on SQLITE_FULL / SQLITE_IOERR
      expect(appendMessageAgentEvent(db, 'm', { kind: 'status', label: 'running' })).toBe(false);
      appendMessageAgentEvent(db, 'm', { kind: 'text', text: 'after' });
    }, () => {});
    expect(db.inTransaction).toBe(false);
    expect(deltaRows(db, 'm').map((row) => JSON.parse(row.eventJson))).toEqual([
      { kind: 'status', label: 'running' },
      { kind: 'text', text: 'after', timestamp: 1234 },
    ]);
  });
});
