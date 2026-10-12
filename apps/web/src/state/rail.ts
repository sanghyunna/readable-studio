// Daemon client for the left rail: the session/folder tree (`GET /api/rail`),
// its change stream (`GET /api/rail/events`), and the rail's own mutations.
//
// A "folder" is what the UI calls a project: it only groups sessions. Moving a
// session changes where it is listed; its workspace (files, cwd, checkpoints)
// never changes.

import type {
  Conversation,
  DeleteFolderResponse,
  DeleteFolderSessionsPolicy,
  FolderResponse,
  RailResponse,
  RailSseEvent,
  SessionFolder,
  SessionResponse,
} from '@readable-studio/contracts';

export type RailReadResult =
  | { ok: true; rail: RailResponse }
  | { ok: false; aborted: boolean };

export async function fetchRail(options: { signal?: AbortSignal } = {}): Promise<RailReadResult> {
  try {
    const resp = await fetch('/api/rail', { signal: options.signal });
    if (!resp.ok) return { ok: false, aborted: false };
    const body = (await resp.json()) as Record<string, unknown> | null;
    if (
      !Array.isArray(body?.folders) ||
      !Array.isArray(body?.recents) ||
      !Array.isArray(body?.pinned) ||
      !body.folders.every((f) => f && Array.isArray((f as Record<string, unknown>).sessions))
    ) {
      return { ok: false, aborted: false };
    }
    return { ok: true, rail: body as unknown as RailResponse };
  } catch {
    return { ok: false, aborted: options.signal?.aborted ?? false };
  }
}

export interface RailEventsOptions {
  /** Test seam: substitute a mock EventSource constructor. */
  EventSourceCtor?: typeof EventSource;
}

/**
 * Subscribe to `rail-changed`. The browser's EventSource reconnects on its
 * own; the caller refetches the whole tree per event, so a missed event during
 * a reconnect is covered by the next one or by `RUNS_CHANGED_EVENT`.
 */
export function subscribeRailEvents(
  onChange: (event: RailSseEvent) => void,
  options: RailEventsOptions = {},
): () => void {
  const Ctor = options.EventSourceCtor
    ?? (typeof EventSource === 'undefined' ? null : EventSource);
  if (!Ctor) return () => undefined;
  const source = new Ctor('/api/rail/events');
  const listener = (evt: Event) => {
    try {
      onChange(JSON.parse((evt as MessageEvent).data) as RailSseEvent);
    } catch (err) {
      // A malformed payload still means "something changed".
      console.warn('[rail-events] malformed rail-changed payload', err);
      onChange({ type: 'rail-changed', reason: 'session-updated', ids: [], at: Date.now() });
    }
  };
  source.addEventListener('rail-changed', listener);
  return () => {
    source.removeEventListener('rail-changed', listener);
    source.close();
  };
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

const sessionUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
const folderUrl = (id: string) => `/api/folders/${encodeURIComponent(id)}`;

export async function setSessionPinned(sessionId: string, pinned: boolean): Promise<{ pinned: string[] } | null> {
  return sendJson<{ pinned: string[] }>(`${sessionUrl(sessionId)}/pin`, pinned ? 'PUT' : 'DELETE');
}

/** `PATCH /api/sessions/:id { folderId }`; `null` = "No project". */
export async function moveSession(sessionId: string, folderId: string | null): Promise<Conversation | null> {
  const json = await sendJson<SessionResponse>(sessionUrl(sessionId), 'PATCH', { folderId });
  return json?.session ?? null;
}

export async function renameSession(sessionId: string, title: string): Promise<Conversation | null> {
  const json = await sendJson<SessionResponse>(sessionUrl(sessionId), 'PATCH', { title });
  return json?.session ?? null;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  return (await sendJson<{ ok: true }>(sessionUrl(sessionId), 'DELETE')) !== null;
}

export async function createFolder(name: string): Promise<SessionFolder | null> {
  const json = await sendJson<FolderResponse>('/api/folders', 'POST', { name });
  return json?.folder ?? null;
}

export async function renameFolder(folderId: string, name: string): Promise<SessionFolder | null> {
  const json = await sendJson<FolderResponse>(folderUrl(folderId), 'PATCH', { name });
  return json?.folder ?? null;
}

export async function deleteFolder(
  folderId: string,
  sessions: DeleteFolderSessionsPolicy = 'keep',
): Promise<DeleteFolderResponse | null> {
  return sendJson<DeleteFolderResponse>(
    `${folderUrl(folderId)}?sessions=${sessions}`,
    'DELETE',
  );
}
