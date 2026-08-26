// Shared contract for the entry hub (left navigation + start surface).
//
// The hub only ever renders data the daemon already returns: projects with
// name/updatedAt/status, and per-project conversations with
// title/sessionMode/messageCount/updatedAt/latestRun. Archive, unread,
// pinning, cross-project search, artifact lineage and session thumbnails do
// NOT exist server-side and must not be invented here.

/** Session state the hub is allowed to render, derived from `latestRun.status`. */
export type HubSessionState = 'running' | 'awaiting' | 'failed' | 'idle';

/** Which rows the left panel is currently showing. */
export type HubFilter = 'all' | 'attention' | 'running';

/** Ordering for the project list. */
export type HubSort = 'recent' | 'name';

export interface HubSessionNode {
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
  state: HubSessionState;
  /** Present only when the daemon reported one; never fabricated. */
  messageCount?: number;
  sessionMode?: string;
}

export interface HubProjectNode {
  id: string;
  name: string;
  updatedAt: number;
  sessions: HubSessionNode[];
  /**
   * Project-level state from `project.status.value`. This is the ONLY place
   * `awaiting_input` exists - `Conversation.latestRun.status` is a
   * `ChatRunStatus`, which has no awaiting member - so the "needs you" filter
   * must consult it rather than inferring from sessions alone.
   */
  state?: HubSessionState;
}

/** How many sessions a project shows before the overflow row appears. */
export const HUB_SESSION_PAGE = 5;

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

/** Map `ProjectStatusInfo.value` onto the four states the hub renders. */
export function projectStateFromStatus(status: string | undefined): HubSessionState {
  switch (status) {
    case 'running':
    case 'queued':
      return 'running';
    case 'awaiting_input':
      return 'awaiting';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/**
 * A project rolls up the most urgent state among its own status and its
 * sessions. Project status wins for `awaiting`, which sessions cannot express.
 */
export function rollupProjectState(project: HubProjectNode): HubSessionState {
  const states = [project.state ?? 'idle', ...project.sessions.map((s) => s.state)];
  if (states.includes('awaiting')) return 'awaiting';
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  return 'idle';
}

/** A project matches a filter when its rollup or any of its sessions do. */
export function projectMatchesFilter(project: HubProjectNode, filter: HubFilter): boolean {
  if (filter === 'all') return true;
  if (matchesHubFilter(rollupProjectState(project), filter)) return true;
  return project.sessions.some((s) => matchesHubFilter(s.state, filter));
}

export function sortProjects(projects: HubProjectNode[], sort: HubSort): HubProjectNode[] {
  const next = [...projects];
  if (sort === 'name') {
    next.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return next;
  }
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}
