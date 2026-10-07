// Shared contract for the entry hub (left navigation + start surface).
//
// The hub only ever renders data the daemon already returns from
// `GET /api/rail`: folders (UI: projects) with their sessions, and standalone
// sessions (recents) with title/sessionMode/messageCount/updatedAt/state. Archive, unread,
// pinning, cross-project search, artifact lineage and session thumbnails do
// NOT exist server-side and must not be invented here.

/** Session state the hub is allowed to render, derived from `latestRun.status`. */
export type HubSessionState = 'running' | 'awaiting' | 'failed' | 'idle';

/** Which rows the left panel is currently showing. */
export type HubFilter = 'all' | 'attention' | 'running';

/**
 * Entry destinations the hub can reach from home. These mirror the entry
 * views the router already owns (`/projects`, `/tasks`, ...); the hub only
 * names them so the rail footer never has to import the entry-shell view
 * union and can stay a presentational surface.
 */
export type HubDestination =
  | 'projects'
  | 'tasks'
  | 'design-systems'
  | 'plugins'
  | 'integrations';

/** Ordering for the folder list. */
export type HubSort = 'recent' | 'name';

export interface HubSessionNode {
  id: string;
  /** The workspace (`projects` row) that owns the session's files and cwd. */
  workspaceId: string;
  /** The rail folder (UI: project) the session is listed in; `null` = recents. */
  folderId: string | null;
  title: string;
  updatedAt: number;
  state: HubSessionState;
  /** Present only when the daemon reported one; never fabricated. */
  messageCount?: number;
  sessionMode?: string;
  /** >1 only for legacy sessions that still share a workspace with siblings. */
  workspaceSessionCount: number;
}

/**
 * How much the hub actually knows about the rail tree.
 *
 * Keeps "known empty" apart from "still loading" and from "the read failed",
 * with `stale` reserved for a failure that still has cached rows to show.
 */
export type HubSessionsStatus = 'loading' | 'ready' | 'stale' | 'unavailable';

/** A user-visible folder of sessions (UI label: project). It owns no files. */
export interface HubFolderNode {
  id: string;
  name: string;
  updatedAt: number;
  sessions: HubSessionNode[];
}

/** The whole rail: folders with their sessions, then standalone sessions. */
export interface HubRailTree {
  folders: HubFolderNode[];
  /** Sessions with `folderId === null`, most recent first. */
  recents: HubSessionNode[];
}

/** The folder a new session will be created in, shown as the composer pill. */
export interface HubSelectedFolder {
  readonly id: string;
  readonly name: string;
}

/** How many sessions a folder shows before the overflow row appears. */
export const HUB_SESSION_PAGE = 5;

/** How many standalone sessions recents shows before the overflow row appears. */
export const HUB_RECENTS_PAGE = 20;

/** Sessions a human still has to act on. */
export function isAttentionState(state: HubSessionState): boolean {
  return state === 'awaiting' || state === 'failed';
}

export function matchesHubFilter(state: HubSessionState, filter: HubFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return isAttentionState(state);
  return state === 'running';
}

/**
 * Map a conversation's latest run status onto the four states the hub
 * renders. Unknown or absent runs read as idle rather than inventing a state.
 */
export function sessionStateFromRunStatus(status: string | undefined): HubSessionState {
  switch (status) {
    case 'running':
    case 'queued':
      return 'running';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/**
 * A folder rolls up the most urgent state among its sessions. `awaiting` comes
 * from the daemon's per-session state, which attributes workspace-level
 * `awaiting_input` to that workspace's sessions.
 */
export function rollupFolderState(folder: HubFolderNode): HubSessionState {
  const states = folder.sessions.map((s) => s.state);
  if (states.includes('awaiting')) return 'awaiting';
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  return 'idle';
}

/** A folder matches a filter when any of its sessions do. */
export function folderMatchesFilter(folder: HubFolderNode, filter: HubFilter): boolean {
  if (filter === 'all') return true;
  return folder.sessions.some((s) => matchesHubFilter(s.state, filter));
}

/** Orders folders only; recents are always recency-ordered. */
export function sortFolders(folders: HubFolderNode[], sort: HubSort): HubFolderNode[] {
  const next = [...folders];
  if (sort === 'name') {
    next.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return next;
  }
  next.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return next;
}
