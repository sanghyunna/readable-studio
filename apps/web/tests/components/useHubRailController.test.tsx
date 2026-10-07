// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RailResponse, RailSession } from '@readable-studio/contracts';
import { useHubRailController } from '../../src/components/hub/useHubRailController';
import { RUNS_CHANGED_EVENT } from '../../src/providers/daemon';

type FetchCall = { url: string; method: string; body: unknown };

function railSession(id: string, folderId: string | null, updatedAt: number, title: string | null = id): RailSession {
  return {
    id, workspaceId: `w-${id}`, folderId, title,
    createdAt: 1, updatedAt, messageCount: 2, state: 'idle', workspaceSessionCount: 1,
  };
}

function railBody(overrides: Partial<RailResponse> = {}): RailResponse {
  return {
    folders: [{
      id: 'f1', name: 'Alpha', createdAt: 1, updatedAt: 5,
      sessions: [railSession('s1', 'f1', 10)],
    }],
    recents: [railSession('s2', null, 20), railSession('s3', null, 15, null)],
    generatedAt: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

let calls: FetchCall[] = [];
let railResponses: Array<RailResponse | Promise<Response>> = [];
let mutationResponse: (call: FetchCall) => Promise<Response>;

beforeEach(() => {
  calls = [];
  railResponses = [];
  mutationResponse = async () => jsonResponse({});
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const call = {
      url: input,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (call.method === 'GET' && call.url === '/api/rail') {
      const next = railResponses.length > 1 ? railResponses.shift() : railResponses[0];
      if (next === undefined) return new Promise<Response>(() => undefined);
      return next instanceof Promise ? next : jsonResponse(next);
    }
    return mutationResponse(call);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

const railReads = () => calls.filter((call) => call.method === 'GET' && call.url === '/api/rail').length;

function mountController(inputs: { currentSessionId?: string | null } = {}) {
  const onNewProject = vi.fn();
  const onOpenSession = vi.fn();
  const hook = renderHook(() => useHubRailController({
    currentSessionId: inputs.currentSessionId ?? null,
    onOpenSession,
    onNewProject,
  }));
  return { ...hook, onNewProject, onOpenSession };
}

async function mountLoaded(inputs: { currentSessionId?: string | null } = {}) {
  const mounted = mountController(inputs);
  await waitFor(() => expect(mounted.result.current.railStatus).toBe('ready'));
  return mounted;
}

it('does not commit derived loading state when mounted', () => {
  // Given: the rail read has not completed.
  let commits = 0;
  // When: the controller mounts.
  const { result } = renderHook(() => {
    const rail = useHubRailController({
      currentSessionId: null, onOpenSession: vi.fn(), onNewProject: vi.fn(),
    });
    useLayoutEffect(() => { commits += 1; });
    return rail;
  });
  // Then: loading is already correct in the first commit.
  expect(result.current.railStatus).toBe('loading');
  expect(result.current.allTree).toEqual({ folders: [], recents: [] });
  expect(commits).toBe(1);
});

it('splits GET /api/rail into folders with their sessions and standalone recents', async () => {
  // Given: the daemon returns one folder and two standalone sessions.
  railResponses = [railBody()];
  // When: the controller loads.
  const { result } = await mountLoaded();
  // Then: folder sessions stay under the folder and only standalone sessions are recents.
  const tree = result.current.allTree;
  expect(tree.folders.map((folder) => [folder.id, folder.name, folder.sessions.map((s) => s.id)]))
    .toEqual([['f1', 'Alpha', ['s1']]]);
  expect(tree.recents.map((session) => [session.id, session.folderId, session.workspaceId]))
    .toEqual([['s2', null, 'w-s2'], ['s3', null, 'w-s3']]);
  expect(tree.recents[1]?.title).toBe('Untitled session');
  expect(calls[0]).toEqual({ url: '/api/rail', method: 'GET', body: undefined });
});

it('marks the whole rail unavailable when the first read fails and recovers on retry', async () => {
  // Given: the first rail read fails.
  railResponses = [Promise.resolve(jsonResponse({}, false)), railBody()];
  const { result } = mountController();
  await waitFor(() => expect(result.current.railStatus).toBe('unavailable'));
  // When: the user retries.
  act(() => result.current.retrySessions());
  // Then: the rail is read again and becomes ready.
  await waitFor(() => expect(result.current.railStatus).toBe('ready'));
  expect(result.current.allTree.folders).toHaveLength(1);
});

it('moves a session with PATCH /api/sessions/:id and shows it in the target at once', async () => {
  // Given: a loaded rail and a PATCH the daemon has not answered yet.
  railResponses = [railBody()];
  const { result } = await mountLoaded();
  let resolvePatch: (response: Response) => void = () => undefined;
  mutationResponse = () => new Promise((resolve) => { resolvePatch = resolve; });
  const session = result.current.allTree.recents[0];
  if (!session) throw new Error('fixture recents missing');

  // When: a standalone session is moved into the folder.
  let moved: Promise<boolean> = Promise.resolve(false);
  act(() => { moved = result.current.moveSession(session, 'f1'); });

  // Then: the PATCH carries only the folder id and the row moves optimistically.
  expect(calls.at(-1)).toEqual({ url: '/api/sessions/s2', method: 'PATCH', body: { folderId: 'f1' } });
  expect(result.current.allTree.folders[0]?.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
  expect(result.current.allTree.recents.map((s) => s.id)).toEqual(['s3']);

  const readsBefore = railReads();
  await act(async () => {
    resolvePatch(jsonResponse({ session: { id: 's2' } }));
    await expect(moved).resolves.toBe(true);
  });
  expect(result.current.announcement).toBe('Moved s2 to Alpha');
  expect(railReads()).toBe(readsBefore + 1);
});

it('moves a folder session to "No project" with folderId null', async () => {
  // Given: a loaded rail.
  railResponses = [railBody()];
  const { result } = await mountLoaded();
  const session = result.current.allTree.folders[0]?.sessions[0];
  if (!session) throw new Error('fixture folder session missing');
  mutationResponse = async () => jsonResponse({ session: { id: 's1' } });
  // When: the folder session is moved out.
  await act(async () => { await result.current.moveSession(session, null); });
  // Then: it is patched to null.
  expect(calls.find((call) => call.method === 'PATCH')).toEqual({
    url: '/api/sessions/s1', method: 'PATCH', body: { folderId: null },
  });
});

it('selects and clears the composer folder, and drops a selection whose folder disappeared', async () => {
  // Given: a loaded rail whose next read no longer has the folder.
  railResponses = [railBody(), railBody({ folders: [] })];
  const { result } = await mountLoaded();
  // When/Then: selecting and clearing round-trips.
  act(() => result.current.selectFolder({ id: 'f1', name: 'Alpha' }));
  expect(result.current.selectedFolder).toEqual({ id: 'f1', name: 'Alpha' });
  act(() => result.current.clearSelectedFolder());
  expect(result.current.selectedFolder).toBeNull();

  // When: the folder is selected again and then vanishes on the next refresh.
  act(() => result.current.selectFolder({ id: 'f1', name: 'Alpha' }));
  act(() => { window.dispatchEvent(new Event(RUNS_CHANGED_EVENT)); });
  // Then: the selection cannot point at a folder that no longer exists.
  await waitFor(() => expect(result.current.allTree.folders).toEqual([]));
  expect(result.current.selectedFolder).toBeNull();
});

it('newSession clears the folder, navigates home and issues the new-session chip', async () => {
  // Given: a selected folder.
  railResponses = [railBody()];
  const { result, onNewProject } = await mountLoaded();
  act(() => result.current.selectFolder({ id: 'f1', name: 'Alpha' }));
  // When: the rail's new-session row is used.
  act(() => result.current.newSession());
  // Then: the next session is standalone and the composer is asked to focus.
  expect(result.current.selectedFolder).toBeNull();
  expect(onNewProject).toHaveBeenCalledTimes(1);
  expect(result.current.commandChip?.id).toBe('new-session');
  // When: a folder's + is used instead.
  act(() => result.current.newSession({ id: 'f1', name: 'Alpha' }));
  // Then: the folder becomes the composer context.
  expect(result.current.selectedFolder).toEqual({ id: 'f1', name: 'Alpha' });
  expect(onNewProject).toHaveBeenCalledTimes(2);
});

it('Ctrl+Shift+N selects the current session folder and goes to the composer', async () => {
  // Given: the open session lives in folder f1.
  railResponses = [railBody()];
  const { result, onNewProject } = await mountLoaded({ currentSessionId: 's1' });
  // When: the shortcut fires.
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true }));
  });
  // Then: no session is created; the composer opens with the folder selected.
  expect(result.current.selectedFolder).toEqual({ id: 'f1', name: 'Alpha' });
  expect(onNewProject).toHaveBeenCalledTimes(1);
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
});

it('refetches the rail on a rail-changed server event', async () => {
  // Given: a rail subscribed to /api/rail/events.
  const sources: FakeEventSource[] = [];
  class FakeEventSource extends EventTarget {
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { /* no connection to close */ }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  railResponses = [railBody(), railBody({ recents: [] })];
  const { result } = await mountLoaded();
  expect(sources.map((source) => source.url)).toEqual(['/api/rail/events']);
  // When: the daemon reports a change.
  act(() => {
    sources[0]?.dispatchEvent(new MessageEvent('rail-changed', {
      data: JSON.stringify({ type: 'rail-changed', reason: 'session-moved', ids: ['s2'], at: 1 }),
    }));
  });
  // Then: the tree is re-read.
  await waitFor(() => expect(result.current.allTree.recents).toEqual([]));
  expect(railReads()).toBe(2);
});

it('renames a session through PATCH /api/sessions/:id', async () => {
  railResponses = [railBody()];
  const { result } = await mountLoaded();
  const session = result.current.allTree.recents[0];
  if (!session) throw new Error('fixture recents missing');
  act(() => result.current.renameSession(session, 'Renamed'));
  expect(result.current.allTree.recents[0]?.title).toBe('Renamed');
  expect(calls.find((call) => call.method === 'PATCH')).toEqual({
    url: '/api/sessions/s2', method: 'PATCH', body: { title: 'Renamed' },
  });
});

it('creates, renames and deletes folders through /api/folders', async () => {
  // Given: a loaded rail with a selected folder.
  railResponses = [railBody()];
  const { result } = await mountLoaded();
  mutationResponse = async (call) => call.method === 'DELETE'
    ? jsonResponse({ ok: true, movedSessionIds: ['s1'], deletedSessionIds: [] })
    : jsonResponse({ folder: { id: 'f2', name: 'Beta', createdAt: 1, updatedAt: 30 } });
  act(() => result.current.selectFolder({ id: 'f1', name: 'Alpha' }));

  // When: a folder is created.
  let created: Awaited<ReturnType<typeof result.current.createFolder>> = null;
  await act(async () => { created = await result.current.createFolder('  Beta  '); });
  // Then: the trimmed name is posted.
  expect(created).toMatchObject({ id: 'f2', name: 'Beta' });
  expect(calls.find((call) => call.method === 'POST')).toEqual({
    url: '/api/folders', method: 'POST', body: { name: 'Beta' },
  });

  // When: the original folder is deleted keeping its sessions.
  const folder = result.current.allTree.folders.find((candidate) => candidate.id === 'f1');
  if (!folder) throw new Error('fixture folder missing');
  let deleting: Promise<boolean> = Promise.resolve(false);
  act(() => { deleting = result.current.deleteFolder(folder, 'keep'); });
  // Then: its sessions land in recents at once and the selection clears.
  expect(result.current.allTree.recents.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  expect(result.current.selectedFolder).toBeNull();
  await act(async () => { await expect(deleting).resolves.toBe(true); });
  expect(calls.find((call) => call.method === 'DELETE')?.url).toBe('/api/folders/f1?sessions=keep');
});

it('lists folders and sessions in the palette with the folder as session meta', async () => {
  railResponses = [railBody()];
  const { result, onOpenSession } = await mountLoaded();
  const entries = result.current.paletteEntries;
  expect(entries.find((entry) => entry.id === 'folder-f1')?.title).toBe('Alpha');
  expect(entries.find((entry) => entry.id === 'session-s1')?.meta).toBe('Alpha');
  expect(entries.find((entry) => entry.id === 'session-s2')?.meta).toBe('No project');
  // Choosing a folder selects it as composer context.
  act(() => entries.find((entry) => entry.id === 'folder-f1')?.activate());
  expect(result.current.selectedFolder).toEqual({ id: 'f1', name: 'Alpha' });
  // Choosing a session opens it in its workspace.
  act(() => entries.find((entry) => entry.id === 'session-s2')?.activate());
  expect(onOpenSession).toHaveBeenCalledWith('w-s2', 's2');
});
