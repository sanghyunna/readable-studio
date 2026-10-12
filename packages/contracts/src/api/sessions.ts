import type { ChatSessionMode } from './chat.js';
import type { Conversation, CreateProjectRequest, Project } from './projects.js';

// Rail sessions and session folders.
//
// A "session" is a conversation shown in the left rail. Each session runs in a
// workspace (the existing `projects` row that owns files, cwd, checkpoints and
// tabs). A "folder" (UI label: Project) only groups sessions in the
// rail; moving a session between folders changes where it is listed and
// nothing else - files, working folder, checkpoints and run history stay put.

/**
 * A user-visible grouping of sessions.
 *
 * @example
 * { "id": "f1", "name": "SGI exam prep", "createdAt": 1760000000000, "updatedAt": 1760000500000, "sessionCount": 3 }
 */
export interface SessionFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sessionCount?: number;
}

export type RailSessionState = 'running' | 'awaiting' | 'failed' | 'idle';

/**
 * One session row in the rail.
 *
 * @example
 * {
 *   "id": "c1", "workspaceId": "p1", "folderId": null, "title": "Meeting summary deck",
 *   "sessionMode": "design", "createdAt": 1760000000000, "updatedAt": 1760000900000,
 *   "messageCount": 4, "latestRun": { "status": "succeeded" }, "state": "idle",
 *   "workspaceSessionCount": 1
 * }
 */
export interface RailSession {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string | null;
  sessionMode?: ChatSessionMode;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  latestRun?: Conversation['latestRun'];
  state: RailSessionState;
  /** >1 only for legacy sessions that still share a workspace. */
  workspaceSessionCount: number;
}

export interface RailFolder extends SessionFolder {
  sessions: RailSession[];
}

/**
 * Response body for `GET /api/rail`.
 *
 * @example
 * { "folders": [{ "id": "f1", "name": "SGI", "createdAt": 1, "updatedAt": 2, "sessions": [] }], "recents": [], "generatedAt": 1760000000000 }
 */
export interface RailResponse {
  folders: RailFolder[];
  recents: RailSession[];
  /**
   * Pinned session ids, oldest pin first. A pin is a shortcut: the session
   * still appears in its folder or in recents. Only ids of existing sessions.
   */
  pinned: string[];
  generatedAt: number;
}

/**
 * Response body for `PUT /api/sessions/:id/pin` (pin) and
 * `DELETE /api/sessions/:id/pin` (unpin). Both are idempotent.
 *
 * @example
 * { "pinned": ["c1", "c7"] }
 */
export interface SessionPinsResponse {
  pinned: string[];
}

/** Response body for `GET /api/sessions?folder=<id|none>&limit=<n>`. */
export interface SessionsResponse {
  sessions: RailSession[];
}

/**
 * Request body for `POST /api/sessions`. Creates a new workspace with one
 * seeded session. `folderId` null/omitted creates a standalone session.
 *
 * @example
 * { "title": "Meeting summary deck", "folderId": "f1", "pendingPrompt": "Five-slide deck from the meeting notes" }
 */
export interface CreateSessionRequest extends Omit<CreateProjectRequest, 'name' | 'projectLocationId'> {
  title?: string;
  folderId?: string | null;
  name?: string;
}

export interface CreateSessionResponse {
  session: Conversation;
  workspace: Project;
  appliedPluginSnapshotId?: string;
}

/** Response body for `GET/PATCH /api/sessions/:id`. */
export interface SessionResponse {
  session: Conversation;
}

/**
 * Request body for `PATCH /api/sessions/:id`. `folderId: null` moves the
 * session to "No project" (recents).
 *
 * @example
 * { "folderId": null }
 */
export interface UpdateSessionRequest {
  title?: string | null;
  folderId?: string | null;
  sessionMode?: ChatSessionMode;
}

export interface FoldersResponse {
  folders: SessionFolder[];
}

export interface FolderResponse {
  folder: SessionFolder;
}

/** @example { "name": "Databricks MLOps" } */
export interface CreateFolderRequest {
  name: string;
}

/** @example { "name": "Databricks MLOps 2" } */
export interface UpdateFolderRequest {
  name: string;
}

/** Query value for `DELETE /api/folders/:id?sessions=keep|delete`; default `keep`. */
export type DeleteFolderSessionsPolicy = 'keep' | 'delete';

/** @example { "ok": true, "movedSessionIds": ["c1", "c2"], "deletedSessionIds": [] } */
export interface DeleteFolderResponse {
  ok: true;
  movedSessionIds: string[];
  deletedSessionIds: string[];
}

/**
 * SSE event on `GET /api/rail/events`.
 *
 * @example
 * { "type": "rail-changed", "reason": "session-moved", "ids": ["c1"], "at": 1760000000000 }
 */
export type RailSseEvent =
  | {
      type: 'rail-changed';
      reason:
        | 'session-created'
        | 'session-updated'
        | 'session-moved'
        | 'session-deleted'
        | 'session-pinned'
        | 'session-unpinned'
        | 'folder-created'
        | 'folder-updated'
        | 'folder-deleted';
      ids: string[];
      at: number;
    };
