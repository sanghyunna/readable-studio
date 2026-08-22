import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearAgentSessionsForConversation,
  closeDatabase,
  deleteMessagesAfterPosition,
  getAgentSession,
  getMessagePosition,
  getProjectCheckpoint,
  insertConversation,
  insertProject,
  insertProjectCheckpoint,
  insertProjectCheckpointRestore,
  listMessages,
  listProjectCheckpoints,
  openDatabase,
  upsertAgentSession,
  upsertMessage,
} from '../src/db.js';

describe('project checkpoint DB metadata', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'readable-db-checkpoints-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertProject(db, { id: 'proj-2', name: 'Other', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-2',
      projectId: 'proj-2',
      title: 'Other',
      createdAt: now,
      updatedAt: now,
    });
    return { db, now };
  }

  it('inserts, reads, and lists checkpoints scoped by project and conversation', () => {
    const { db, now } = seed();

    insertProjectCheckpoint(db, {
      id: 'cp-before',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'before_run',
      rootPathHash: 'root-hash-1',
      manifestPath: 'projects/proj-1/cp-before/manifest.json',
      manifestHash: 'sha256-before',
      fileCount: 2,
      totalBytes: 12,
      createdAt: now,
    });
    insertProjectCheckpoint(db, {
      id: 'cp-after',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
      rootPathHash: 'root-hash-1',
      manifestPath: 'projects/proj-1/cp-after/manifest.json',
      manifestHash: 'sha256-after',
      fileCount: 3,
      totalBytes: 20,
      createdAt: now + 1,
    });
    insertProjectCheckpoint(db, {
      id: 'cp-other',
      projectId: 'proj-2',
      conversationId: 'conv-2',
      messageId: 'assistant-other',
      runId: 'run-other',
      kind: 'after_message',
      rootPathHash: 'root-hash-2',
      manifestPath: 'projects/proj-2/cp-other/manifest.json',
      manifestHash: 'sha256-other',
      fileCount: 1,
      totalBytes: 4,
      createdAt: now + 2,
    });

    expect(getProjectCheckpoint(db, 'cp-after')).toMatchObject({
      id: 'cp-after',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
      manifestPath: 'projects/proj-1/cp-after/manifest.json',
      manifestHash: 'sha256-after',
      fileCount: 3,
      totalBytes: 20,
    });

    expect(
      listProjectCheckpoints(db, 'proj-1', { conversationId: 'conv-1' })
        .map((checkpoint) => checkpoint.id),
    ).toEqual(['cp-after', 'cp-before']);
  });

  it('records restore audit rows with target and safety checkpoint ids', () => {
    const { db, now } = seed();
    insertProjectCheckpoint(db, {
      id: 'target-cp',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
      rootPathHash: 'root-hash-1',
      manifestPath: 'projects/proj-1/target-cp/manifest.json',
      manifestHash: 'target-sha',
      fileCount: 1,
      totalBytes: 5,
      createdAt: now,
    });
    insertProjectCheckpoint(db, {
      id: 'safety-cp',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      messageId: null,
      runId: null,
      kind: 'before_restore',
      rootPathHash: 'root-hash-1',
      manifestPath: 'projects/proj-1/safety-cp/manifest.json',
      manifestHash: 'safety-sha',
      fileCount: 2,
      totalBytes: 9,
      createdAt: now + 1,
    });

    insertProjectCheckpointRestore(db, {
      id: 'restore-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: 'target-cp',
      safetyCheckpointId: 'safety-cp',
      mode: 'files_and_chat',
      conflictPolicy: 'fail',
      fileChanges: {
        added: 0,
        modified: 1,
        deleted: 1,
        unchanged: 3,
      },
      deletedMessageIds: ['user-2', 'assistant-2'],
      createdAt: now + 2,
      metadata: { agentSessionsCleared: 2 },
    });

    const restore = db
      .prepare(
        `SELECT project_id AS projectId,
                conversation_id AS conversationId,
                target_message_id AS targetMessageId,
                target_checkpoint_id AS targetCheckpointId,
                safety_checkpoint_id AS safetyCheckpointId,
                mode,
                conflict_policy AS conflictPolicy,
                file_changes_json AS fileChangesJson,
                deleted_message_ids_json AS deletedMessageIdsJson,
                metadata_json AS metadataJson
           FROM project_checkpoint_restores
          WHERE id = ?`,
      )
      .get('restore-1') as {
      projectId: string;
      conversationId: string;
      targetMessageId: string;
      targetCheckpointId: string;
      safetyCheckpointId: string;
      mode: string;
      conflictPolicy: string;
      fileChangesJson: string;
      deletedMessageIdsJson: string;
      metadataJson: string;
    };

    expect(restore).toMatchObject({
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetCheckpointId: 'target-cp',
      safetyCheckpointId: 'safety-cp',
      targetMessageId: 'assistant-1',
      mode: 'files_and_chat',
      conflictPolicy: 'fail',
    });
    expect(JSON.parse(restore.fileChangesJson)).toEqual({
      added: 0,
      modified: 1,
      deleted: 1,
      unchanged: 3,
    });
    expect(JSON.parse(restore.deletedMessageIdsJson)).toEqual(['user-2', 'assistant-2']);
    expect(JSON.parse(restore.metadataJson)).toEqual({ agentSessionsCleared: 2 });
  });
});

describe('checkpoint chat restore DB helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'readable-db-checkpoint-chat-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedMessagesAndSessions() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    for (const message of [
      { id: 'user-1', role: 'user', content: 'first' },
      { id: 'assistant-1', role: 'assistant', content: 'first answer' },
      { id: 'user-2', role: 'user', content: 'second' },
      { id: 'assistant-2', role: 'assistant', content: 'second answer' },
    ]) {
      upsertMessage(db, 'conv-1', message);
    }
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'claude', sessionId: 'sess-a' });
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'codex', sessionId: 'sess-b' });
    return db;
  }

  it('deletes messages after the target position and preserves the target message', () => {
    const db = seedMessagesAndSessions();
    const target = getMessagePosition(db, 'conv-1', 'assistant-1');
    expect(target).toBeDefined();

    const deleted = deleteMessagesAfterPosition(db, 'conv-1', target!.position);

    expect(deleted).toEqual(['user-2', 'assistant-2']);
    expect(listMessages(db, 'conv-1').map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
  });

  it('clears all resume-capable agent sessions for a rolled-back conversation', () => {
    const db = seedMessagesAndSessions();

    const cleared = clearAgentSessionsForConversation(db, 'conv-1');

    expect(cleared).toBe(2);
    expect(getAgentSession(db, 'conv-1', 'claude')).toBeNull();
    expect(getAgentSession(db, 'conv-1', 'codex')).toBeNull();
  });
});
