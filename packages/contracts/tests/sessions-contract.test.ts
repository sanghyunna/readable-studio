import { describe, expect, it } from 'vitest';

import type {
  Conversation,
  CreateSessionRequest,
  DeleteFolderResponse,
  DeleteFolderSessionsPolicy,
  ImportFolderRequest,
  RailResponse,
  RailSession,
  RailSseEvent,
  UpdateSessionRequest,
} from '../src/index.js';

describe('rail session contracts', () => {
  it('lets a session move to no folder with an explicit null', () => {
    const move: UpdateSessionRequest = { folderId: null };
    const session: Conversation = {
      id: 'c1', projectId: 'p1', title: null, folderId: null, createdAt: 1, updatedAt: 1,
    };
    expect(move.folderId).toBeNull();
    expect(session.folderId).toBeNull();
  });

  it('keeps folderId optional on conversations and folder imports', () => {
    const legacy: Conversation = { id: 'c1', projectId: 'p1', title: 't', createdAt: 1, updatedAt: 1 };
    const imported: ImportFolderRequest = { baseDir: 'C:/work', folderId: 'f1' };
    expect(legacy).not.toHaveProperty('folderId');
    expect(imported.folderId).toBe('f1');
  });

  it('creates sessions without a workspace name or project location', () => {
    const request: CreateSessionRequest = { title: 'Deck', folderId: 'f1', pendingPrompt: 'make it' };
    // @ts-expect-error Sessions always live in the default projects root.
    const located: CreateSessionRequest = { projectLocationId: 'other' };
    expect(request.folderId).toBe('f1');
    expect(located).toHaveProperty('projectLocationId', 'other');
  });

  it('splits the rail into folders and recents', () => {
    const session: RailSession = {
      id: 'c1', workspaceId: 'p1', folderId: 'f1', title: 'Deck', createdAt: 1, updatedAt: 2,
      messageCount: 3, state: 'running', workspaceSessionCount: 1,
    };
    const rail: RailResponse = {
      folders: [{ id: 'f1', name: 'Folder', createdAt: 1, updatedAt: 2, sessions: [session] }],
      recents: [],
      generatedAt: 3,
    };
    expect(rail.folders[0]?.sessions[0]?.folderId).toBe('f1');
  });

  it('pins the folder delete policy and SSE reason values', () => {
    const policies: DeleteFolderSessionsPolicy[] = ['keep', 'delete'];
    const response: DeleteFolderResponse = { ok: true, movedSessionIds: ['c1'], deletedSessionIds: [] };
    const event: RailSseEvent = { type: 'rail-changed', reason: 'session-moved', ids: ['c1'], at: 1 };
    // @ts-expect-error Unknown reasons are rejected.
    const bad: RailSseEvent = { type: 'rail-changed', reason: 'session-archived', ids: [], at: 1 };
    expect(policies).toEqual(['keep', 'delete']);
    expect(response.ok).toBe(true);
    expect(event.reason).toBe('session-moved');
    expect(bad.type).toBe('rail-changed');
  });
});
