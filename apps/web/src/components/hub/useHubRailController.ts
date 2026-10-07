// The hub rail's controller: every piece of state the left rail owns, with no
// JSX attached.
//
// This is the boundary between "who owns the rail's state" and "who renders
// it". AppInner owns ONE instance outside the keyed surface and every rail
// consumer reads it through `useHubRail()`. Nothing in here assumes it lives
// inside the hub's DOM: the daemon reads, the open-work / rail-width
// persistence, the keyboard bindings and the undo window are all keyed off
// `window`, not off a component ancestor.
//
// The rail is a tree of folders (UI: projects) and standalone sessions
// (recents), read in one request from `GET /api/rail` and refetched on mount,
// on `RUNS_CHANGED_EVENT`, on the `rail-changed` SSE and after the rail's own
// mutations. A folder groups sessions and nothing more: moving a session only
// changes where it is listed.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import type { DeleteFolderSessionsPolicy, RailResponse, RailSession } from '@readable-studio/contracts';

import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT } from '../../providers/daemon';
import {
  createFolder as createFolderRequest,
  deleteFolder as deleteFolderRequest,
  deleteSession as deleteSessionRequest,
  fetchRail,
  moveSession as moveSessionRequest,
  renameFolder as renameFolderRequest,
  renameSession as renameSessionRequest,
  subscribeRailEvents,
} from '../../state/rail';
import type { HubPaletteEntry } from './HubCommandPalette';
import type { HubOpenWorkItem } from './HubOpenWork';
import type {
  HubFolderNode,
  HubRailTree,
  HubSelectedFolder,
  HubSessionNode,
  HubSessionsStatus,
} from './types';

const OPEN_WORK_STORAGE_KEY = 'readable-studio:hub-open-work';
/**
 * The rail's Ctrl/Cmd+I shortcut is owned by the hub's keyboard layer, which
 * dispatches this event rather than reaching into inspector state directly.
 */
const HUB_INSPECTOR_TOGGLE_EVENT = 'readable:hub-inspector-toggle';
// Collapsing the rail is a durable preference, not a per-tab one: a user who
// works in the narrow rail expects it still narrow tomorrow.
const RAIL_COLLAPSED_STORAGE_KEY = 'readable-studio:hub-rail-collapsed';
const RAIL_WIDTH_STORAGE_KEY = 'readable-studio:hub-rail-width';
export const HUB_RAIL_WIDTH_DEFAULT = 292;
export const HUB_RAIL_WIDTH_MIN = 262;
export const HUB_RAIL_WIDTH_MAX = 420;
// The mockup's breakpoint. Below it the rail is ALWAYS the icon rail, so the
// stored preference is irrelevant until the window widens again.
const NARROW_RAIL_QUERY = '(max-width: 900px)';
/** A burst of `rail-changed` events (e.g. a folder delete) costs one refetch. */
const RAIL_EVENT_COALESCE_MS = 150;

function loadRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === 'true';
}

export function clampHubRailWidth(width: number): number {
  return Math.min(HUB_RAIL_WIDTH_MAX, Math.max(HUB_RAIL_WIDTH_MIN, Math.round(width)));
}

function loadRailWidth(): number {
  if (typeof window === 'undefined') return HUB_RAIL_WIDTH_DEFAULT;
  const stored = Number.parseFloat(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY) ?? '');
  return Number.isFinite(stored) ? clampHubRailWidth(stored) : HUB_RAIL_WIDTH_DEFAULT;
}

/** The narrow-rail media query, or `null` where no viewport is available. */
function narrowRailQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(NARROW_RAIL_QUERY);
}

function loadOpenWorkIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(OPEN_WORK_STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function toSessionNode(session: RailSession, untitled: string): HubSessionNode {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    folderId: session.folderId,
    title: session.title ?? untitled,
    updatedAt: session.updatedAt,
    state: session.state,
    messageCount: session.messageCount,
    ...(session.sessionMode === undefined ? {} : { sessionMode: session.sessionMode }),
    workspaceSessionCount: session.workspaceSessionCount,
  };
}

function toRailTree(rail: RailResponse, untitled: string): HubRailTree {
  return {
    folders: rail.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      updatedAt: folder.updatedAt,
      sessions: folder.sessions.map((session) => toSessionNode(session, untitled)),
    })),
    recents: rail.recents.map((session) => toSessionNode(session, untitled)),
  };
}

const byRecency = (a: HubSessionNode, b: HubSessionNode) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Place `session` under `folderId` (or recents), removing it from where it was. */
function placeSession(tree: HubRailTree, session: HubSessionNode, folderId: string | null): HubRailTree {
  const moved: HubSessionNode = { ...session, folderId };
  const without = (sessions: HubSessionNode[]) => sessions.filter((s) => s.id !== session.id);
  return {
    folders: tree.folders.map((folder) => ({
      ...folder,
      sessions: folder.id === folderId
        ? [...without(folder.sessions), moved].sort(byRecency)
        : without(folder.sessions),
    })),
    recents: folderId === null
      ? [...without(tree.recents), moved].sort(byRecency)
      : without(tree.recents),
  };
}

function mapSessions(tree: HubRailTree, map: (session: HubSessionNode) => HubSessionNode): HubRailTree {
  return {
    folders: tree.folders.map((folder) => ({ ...folder, sessions: folder.sessions.map(map) })),
    recents: tree.recents.map(map),
  };
}

const EMPTY_TREE: HubRailTree = { folders: [], recents: [] };

export type HubPendingSessionDeletion = {
  readonly session: HubSessionNode;
  readonly wasOpen: boolean;
  readonly wasPeeked: boolean;
};

/** Where a session is listed: a folder, or "No project" (`id: null`). */
export interface HubRailLocation {
  readonly id: string | null;
  /** The folder name, or the localized "No project" label. */
  readonly name: string;
}

/** A session together with the folder it is listed in. */
export interface HubRailSessionEntry {
  /** `null` for a standalone session listed in recents. */
  readonly folder: HubFolderNode | null;
  /** Display location; `project.name` is the folder name or "No project". */
  readonly project: HubRailLocation;
  readonly session: HubSessionNode;
}

/** A creation command chosen from the palette, handed to the composer. */
export type HubCommandChip = { readonly id: string; readonly nonce: number };

export type HubNavigateDestination =
  | 'home'
  | 'projects'
  | 'tasks'
  | 'design-systems'
  | 'plugins'
  | 'integrations';

/** Everything the controller needs from whoever owns it. */
export interface HubRailControllerInputs {
  currentSessionId: string | null;
  /** Open an existing session directly in its workspace. */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /**
   * Land on the Hub. The controller follows it with the `new-session` command
   * chip, which the Hub composer consumes by focusing its editor - so the
   * owner only navigates; it never focuses.
   */
  onNewProject: () => void;
  onNavigateDestination?: ((destination: HubNavigateDestination) => void) | undefined;
  /**
   * Hold the rail read. While `true` no `GET /api/rail` is issued and an
   * in-flight read is aborted so it releases the browser's request slot;
   * the cached tree stays on screen. Flipping back to `false` reads afresh.
   * The owner uses this to keep the rail from competing with a workspace that
   * is loading its own conversation.
   */
  pauseSessionReads?: boolean | undefined;
  /**
   * A creation command was chosen from the palette. The chip itself is held
   * on the controller until the composer consumes it; this is the owner's
   * chance to bring the composer on screen when the palette ran elsewhere.
   */
  onCommandChip?: ((chip: HubCommandChip) => void) | undefined;
}

/**
 * The rail's public surface. `HubRail` renders from it; the hub's start
 * surface reads the parts it depends on (`running`, `commandChip`,
 * `selectedFolder`, the inspector, the undo toast, the palette).
 */
export interface HubRailController {
  readonly currentSessionId: string | null;

  readonly railCollapsed: boolean;
  /** Viewport-forced collapse; not a preference and never persisted. */
  readonly narrow: boolean;
  readonly railWidth: number;
  readonly railResizing: boolean;
  readonly toggleRail: () => void;
  readonly beginRailResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly setRailWidth: (width: number) => void;

  readonly searchRef: RefObject<HTMLInputElement>;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly expandRailForSearch: () => void;

  /** The whole rail tree from `GET /api/rail`, minus sessions pending deletion. */
  readonly allTree: HubRailTree;
  /** `allTree` narrowed by the search query. */
  readonly tree: HubRailTree;
  /** One status for the whole rail; a failure renders one retry row. */
  readonly railStatus: HubSessionsStatus;
  /** Re-read `GET /api/rail` (the `hub.retrySessions` action). */
  readonly retrySessions: () => void;
  readonly running: HubRailSessionEntry | null;
  readonly announcement: string;

  readonly openWork: HubOpenWorkItem[];
  readonly openSession: (session: HubSessionNode) => void;
  readonly openOpenWork: (item: HubOpenWorkItem) => void;
  readonly closeOpenWork: (item: HubOpenWorkItem) => void;

  readonly peeked: HubRailSessionEntry | null;
  readonly peekSession: (session: HubSessionNode) => void;
  readonly openPeekedSession: (session: HubSessionNode) => void;
  readonly closeInspector: () => void;

  /**
   * The folder the next composer submit creates its session in (the composer
   * pill). Not persisted; cleared automatically when the folder disappears.
   */
  readonly selectedFolder: HubSelectedFolder | null;
  readonly selectFolder: (folder: HubSelectedFolder) => void;
  readonly clearSelectedFolder: () => void;
  /**
   * Go to the Hub composer with the caret in it (chip `new-session`). Without
   * a folder it clears the selection (standalone session); with one it
   * selects that folder first (folder `+`, folder menu, palette, Ctrl+Shift+N).
   */
  readonly newSession: (folder?: HubSelectedFolder) => void;

  /** `PATCH /api/sessions/:id { folderId }`; `null` = "No project". */
  readonly moveSession: (session: HubSessionNode, folderId: string | null) => Promise<boolean>;
  readonly renameSession: (session: HubSessionNode, title: string) => void;
  /** Removes the row now; the DELETE fires when the undo window closes. */
  readonly deleteSession: (session: HubSessionNode) => void;
  readonly createFolder: (name: string) => Promise<HubFolderNode | null>;
  readonly renameFolder: (folder: HubFolderNode, name: string) => Promise<boolean>;
  readonly deleteFolder: (folder: HubFolderNode, sessions?: DeleteFolderSessionsPolicy) => Promise<boolean>;

  readonly pendingSessionDeletion: HubPendingSessionDeletion | null;
  readonly undoPendingSessionDeletion: () => void;
  readonly commitPendingSessionDeletion: () => void;

  readonly paletteOpen: boolean;
  readonly paletteEntries: HubPaletteEntry[];
  readonly openPalette: () => void;
  readonly closePalette: () => void;
  /**
   * The pending creation command, held until the composer has applied it.
   * Route-survivable: a chip chosen on another surface waits here for the
   * hub's composer to mount and consume it.
   */
  readonly commandChip: HubCommandChip | null;
  /** Clear `commandChip` once applied; a stale nonce is ignored. */
  readonly consumeCommandChip: (nonce: number) => void;
}

export function useHubRailController({
  currentSessionId,
  onOpenSession,
  onNewProject,
  onNavigateDestination,
  pauseSessionReads = false,
  onCommandChip,
}: HubRailControllerInputs): HubRailController {
  const t = useT();
  const [railTree, setRailTree] = useState<HubRailTree>(EMPTY_TREE);
  const [railStatus, setRailStatus] = useState<HubSessionsStatus>('loading');
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState('');
  // A newer read (or a local mutation) supersedes an older in-flight read, so
  // a slow response can never overwrite fresher state.
  const railGenerationRef = useRef(0);
  const railReadControllerRef = useRef<AbortController | null>(null);
  const railLoadedRef = useRef(false);
  const pauseRef = useRef(pauseSessionReads);
  pauseRef.current = pauseSessionReads;
  const [selectedFolderState, setSelectedFolderState] = useState<HubSelectedFolder | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandChip, setCommandChip] = useState<HubCommandChip | null>(null);
  const commandChipNonceRef = useRef(0);
  const paletteReturnRef = useRef<HTMLElement | null>(null);
  // Open work is client-side: which sessions the user is holding open. The
  // daemon has no concept of an open tab, so this must not be inferred from it.
  const [openWorkIds, setOpenWorkIds] = useState<string[]>(loadOpenWorkIds);
  const openWorkIdsRef = useRef(openWorkIds);
  const updateOpenWorkIds = useCallback((update: (current: string[]) => string[]) => {
    const next = update(openWorkIdsRef.current);
    openWorkIdsRef.current = next;
    window.sessionStorage.setItem(OPEN_WORK_STORAGE_KEY, JSON.stringify(next));
    setOpenWorkIds(next);
  }, []);
  // The stored preference and the rendered state are deliberately separate:
  // below the narrow breakpoint the rail is forced collapsed WITHOUT rewriting
  // the preference, so widening the window restores what the user chose.
  const [railCollapsedPreference, setRailCollapsedPreference] = useState(loadRailCollapsed);
  const [railWidth, setRailWidthState] = useState(loadRailWidth);
  const [railResizing, setRailResizing] = useState(false);
  const railResizeCleanupRef = useRef<(() => void) | null>(null);
  const [narrow, setNarrow] = useState(() => narrowRailQuery()?.matches ?? false);
  const railCollapsed = railCollapsedPreference || narrow;
  const [peekedSessionId, setPeekedSessionId] = useState<string | null>(null);
  const [removedSessionIds, setRemovedSessionIds] = useState<string[]>([]);
  const [pendingSessionDeletion, setPendingSessionDeletion] = useState<HubPendingSessionDeletion | null>(null);
  const pendingSessionDeletionRef = useRef<HubPendingSessionDeletion | null>(null);
  const mountedRef = useRef(true);
  // Read through a ref so the fetch does not re-run when `t` changes
  // identity, while still rendering the translated fallback label.
  const untitledLabel = useRef(t('hub.untitledSession'));
  untitledLabel.current = t('hub.untitledSession');

  useEffect(() => {
    const query = narrowRailQuery();
    if (!query) return undefined;
    // Resizing between the initial read and this effect would otherwise leave
    // a stale value on screen until the next crossing of the breakpoint.
    setNarrow(query.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setRailWidth = useCallback((width: number) => {
    const next = clampHubRailWidth(width);
    setRailWidthState(next);
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(next));
  }, []);

  const beginRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (railCollapsed || narrow) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;
    setRailResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setRailWidth(startWidth + moveEvent.clientX - startX);
    };
    const finish = () => {
      setRailResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      railResizeCleanupRef.current = null;
    };
    railResizeCleanupRef.current?.();
    railResizeCleanupRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  }, [narrow, railCollapsed, railWidth, setRailWidth]);

  useEffect(() => () => railResizeCleanupRef.current?.(), []);

  const toggleRail = useCallback(() => {
    setRailCollapsedPreference((current) => {
      const next = !current;
      window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, String(next));
      setAnnouncement(t(next ? 'entry.navCollapse' : 'entry.navExpand'));
      return next;
    });
  }, [t]);

  // Clicking search while the rail is COLLAPSED used to leave the rail folded,
  // so the text box stayed clipped to the glyph width and the user could not
  // see what they were typing. Searching is an explicit request to use the
  // rail, so it expands it and keeps focus in the field.
  //
  // `narrow` is the viewport-forced collapse; it is not a user preference and
  // cannot be overridden here, so the field is left alone in that case.
  const searchRef = useRef<HTMLInputElement | null>(null);
  const expandRailForSearch = useCallback(() => {
    if (narrow || !railCollapsedPreference) return;
    setRailCollapsedPreference(false);
    window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, 'false');
    setAnnouncement(t('entry.navExpand'));
    // The width transition runs on the next frame; re-assert focus after it is
    // scheduled so the caret lands in the now-full-width field.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [narrow, railCollapsedPreference, t]);

  useEffect(() => {
    // Ctrl/Cmd+B is a global binding, but it must not steal the character from
    // someone typing into the composer or a rename field, and it is inert while
    // the viewport forces the collapsed rail.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'b') return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if (narrow) return;
      event.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [narrow, toggleRail]);

  // Supersede any in-flight read: its response would predate a mutation or a
  // newer read and must not land.
  const invalidateRailRead = useCallback(() => {
    railGenerationRef.current += 1;
    railReadControllerRef.current?.abort();
    railReadControllerRef.current = null;
  }, []);

  const loadRail = useCallback(async (): Promise<void> => {
    if (pauseRef.current) return;
    invalidateRailRead();
    const generation = railGenerationRef.current;
    const controller = new AbortController();
    railReadControllerRef.current = controller;
    const result = await fetchRail({ signal: controller.signal });
    if (railGenerationRef.current !== generation || !mountedRef.current) return;
    railReadControllerRef.current = null;
    if (result.ok) {
      railLoadedRef.current = true;
      setRailTree(toRailTree(result.rail, untitledLabel.current));
      setRailStatus('ready');
      return;
    }
    if (result.aborted) return;
    // A failed read keeps the last good tree and marks it stale; with nothing
    // cached it says the sessions are unavailable rather than claiming none.
    setRailStatus(railLoadedRef.current ? 'stale' : 'unavailable');
  }, [invalidateRailRead]);

  useEffect(() => {
    // The owner is holding reads back; the previous run's cleanup already
    // aborted anything in flight, and releasing the hold re-runs this effect.
    if (pauseSessionReads) return undefined;
    const load = () => { void loadRail(); };
    load();
    window.addEventListener(RUNS_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(RUNS_CHANGED_EVENT, load);
      invalidateRailRead();
    };
  }, [invalidateRailRead, loadRail, pauseSessionReads]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeRailEvents(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void loadRail();
      }, RAIL_EVENT_COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [loadRail]);

  /** Apply an optimistic patch, run the request, then reconcile with the daemon. */
  const mutateRail = useCallback(
    async <T,>(patch: ((tree: HubRailTree) => HubRailTree) | null, request: () => Promise<T>): Promise<T> => {
      invalidateRailRead();
      if (patch) setRailTree(patch);
      const result = await request();
      if (mountedRef.current) void loadRail();
      return result;
    },
    [invalidateRailRead, loadRail],
  );

  const retrySessions = useCallback(() => {
    if (pauseSessionReads) return;
    if (!railLoadedRef.current) setRailStatus('loading');
    void loadRail();
  }, [loadRail, pauseSessionReads]);

  // A deleted session must leave the list immediately, before the DELETE
  // fires at the end of the undo window.
  const allTree = useMemo<HubRailTree>(() => {
    if (removedSessionIds.length === 0) return railTree;
    const keep = (session: HubSessionNode) => !removedSessionIds.includes(session.id);
    return {
      folders: railTree.folders.map((folder) => ({ ...folder, sessions: folder.sessions.filter(keep) })),
      recents: railTree.recents.filter(keep),
    };
  }, [railTree, removedSessionIds]);

  // Search narrows the same rows the tree already renders instead of opening a
  // second result list. A folder name match keeps all of its sessions.
  const tree = useMemo<HubRailTree>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allTree;
    const matches = (session: HubSessionNode) => session.title.toLowerCase().includes(needle);
    return {
      folders: allTree.folders
        .map((folder) => (folder.name.toLowerCase().includes(needle)
          ? folder
          : { ...folder, sessions: folder.sessions.filter(matches) }))
        .filter((folder) => folder.sessions.length > 0 || folder.name.toLowerCase().includes(needle)),
      recents: allTree.recents.filter(matches),
    };
  }, [allTree, query]);

  const noProjectLabel = t('hub.moveNoProject');
  const sessionIndex = useMemo(() => {
    const map = new Map<string, HubRailSessionEntry>();
    for (const folder of allTree.folders) {
      const project = { id: folder.id, name: folder.name };
      for (const session of folder.sessions) map.set(session.id, { folder, project, session });
    }
    const none = { id: null, name: noProjectLabel };
    for (const session of allTree.recents) map.set(session.id, { folder: null, project: none, session });
    return map;
  }, [allTree, noProjectLabel]);
  const sessionIndexRef = useRef(sessionIndex);
  useLayoutEffect(() => {
    sessionIndexRef.current = sessionIndex;
  }, [sessionIndex]);

  // The selection follows the live tree: a renamed folder renames the pill,
  // and a folder that no longer exists (deleted here or elsewhere) clears it.
  const selectedFolder = useMemo<HubSelectedFolder | null>(() => {
    if (!selectedFolderState) return null;
    if (railStatus === 'loading' || railStatus === 'unavailable') return selectedFolderState;
    const live = railTree.folders.find((folder) => folder.id === selectedFolderState.id);
    if (!live) return null;
    return live.name === selectedFolderState.name
      ? selectedFolderState
      : { id: live.id, name: live.name };
  }, [railStatus, railTree.folders, selectedFolderState]);

  const selectFolder = useCallback((folder: HubSelectedFolder) => {
    setSelectedFolderState((current) =>
      current?.id === folder.id && current.name === folder.name
        ? current
        : { id: folder.id, name: folder.name });
  }, []);

  const clearSelectedFolder = useCallback(() => setSelectedFolderState(null), []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    const target = paletteReturnRef.current;
    paletteReturnRef.current = null;
    window.requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
    });
  }, []);

  const openPalette = useCallback(() => {
    if (paletteOpen) return;
    paletteReturnRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPaletteOpen(true);
  }, [paletteOpen]);

  const issueCommandChip = useCallback((id: string) => {
    const chip: HubCommandChip = { id, nonce: ++commandChipNonceRef.current };
    setCommandChip(chip);
    onCommandChip?.(chip);
  }, [onCommandChip]);

  // "New session" everywhere (rail row, Ctrl/Cmd+N, folder `+`, Projects
  // empty state): set the composer's folder context, navigate to the Hub, then
  // hand the composer a chip it answers by taking focus. Issuing the chip on
  // an already-open Hub still focuses; nothing here is a no-op.
  const newSession = useCallback((folder?: HubSelectedFolder) => {
    if (folder) selectFolder(folder);
    else clearSelectedFolder();
    onNewProject();
    // Not `issueCommandChip`: the owner already navigated above, so the chip
    // must not also fire the palette's "go home" hook (a second navigation and
    // a spurious nav analytics click).
    setCommandChip({ id: 'new-session', nonce: ++commandChipNonceRef.current });
  }, [clearSelectedFolder, onNewProject, selectFolder]);

  const consumeCommandChip = useCallback((nonce: number) => {
    setCommandChip((current) => (current?.nonce === nonce ? null : current));
  }, []);

  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const primary = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLocaleLowerCase();
      if (primary && !event.shiftKey && key === 'k') {
        event.preventDefault();
        openPalette();
      } else if (primary && event.shiftKey && key === 'n') {
        // A new session next to the current one: select its folder and go to
        // the composer. A standalone current session starts a standalone one.
        event.preventDefault();
        const current = currentSessionIdRef.current;
        const folder = current ? sessionIndexRef.current.get(current)?.folder : null;
        newSession(folder ?? undefined);
      } else if (primary && !event.shiftKey && key === 'n') {
        event.preventDefault();
        newSession();
      } else if (primary && !event.shiftKey && key === 'i') {
        event.preventDefault();
        // Todo 11 owns the inspector. This event is its stable integration seam.
        window.dispatchEvent(new CustomEvent(HUB_INSPECTOR_TOGGLE_EVENT));
      } else if (event.key === 'Escape' && paletteOpen) {
        event.preventDefault();
        closePalette();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [closePalette, newSession, openPalette, paletteOpen]);

  const paletteEntries = useMemo<HubPaletteEntry[]>(() => {
    // Choosing a folder makes it the composer's context; a folder has no
    // workspace of its own to open.
    const folderEntries = allTree.folders.map((folder) => ({
      id: `folder-${folder.id}`,
      group: t('hub.projects'),
      title: folder.name,
      kind: 'project' as const,
      activate: () => newSession(folder),
    }));
    const sessionEntries = [...sessionIndex.values()].map(({ project, session }) => ({
      id: `session-${session.id}`,
      group: t('hub.treeLabel'),
      title: session.title,
      meta: project.name,
      kind: 'session' as const,
      activate: () => onOpenSession(session.workspaceId, session.id),
    }));
    const destinations = [
      ['home', t('entry.navHome')],
      ['projects', t('entry.navProjects')],
      ['tasks', t('entry.navTasks')],
      ['design-systems', t('entry.navDesignSystems')],
      ['plugins', t('entry.navPlugins')],
      ['integrations', t('entry.navIntegrations')],
    ] as const;
    const creationCommands = [
      ['prototype', t('homeHero.chip.prototype')],
      ['deck', t('homeHero.chip.deck')],
      ['report', t('homeHero.chip.report')],
      ['create-plugin', t('homeHero.chip.createPlugin')],
      ['figma', t('homeHero.chip.figma')],
      ['template', t('homeHero.chip.template')],
      ['continue', t('homeHero.continueWithoutPrompt')],
    ] as const;
    return [
      ...creationCommands.map(([chipId, title]) => ({
        id: `command-create-${chipId}`,
        group: t('hub.paletteCreate'),
        title,
        kind: 'command' as const,
        activate: () => issueCommandChip(chipId),
      })),
      ...folderEntries,
      ...sessionEntries,
      ...destinations.map(([destination, title]) => ({
        id: `destination-${destination}`,
        group: t('hub.paletteNavigate'),
        title,
        kind: 'destination' as const,
        activate: () => onNavigateDestination?.(destination),
      })),
    ];
  }, [allTree.folders, issueCommandChip, newSession, onNavigateDestination, onOpenSession, sessionIndex, t]);

  const running = useMemo(
    () => [...sessionIndex.values()].find((entry) => entry.session.state === 'running') ?? null,
    [sessionIndex],
  );

  const openSession = useCallback(
    (session: HubSessionNode) => {
      setAnnouncement(t('hub.liveWorking', { project: '', session: session.title }));
      updateOpenWorkIds((prev) =>
        prev.includes(session.id) ? prev : [session.id, ...prev],
      );
      onOpenSession(session.workspaceId, session.id);
    },
    [onOpenSession, t, updateOpenWorkIds],
  );

  const openWork = useMemo<HubOpenWorkItem[]>(
    () =>
      openWorkIds.flatMap((id) => {
        const entry = sessionIndex.get(id);
        if (!entry) return [];
        return [
          {
            sessionId: entry.session.id,
            projectId: entry.session.workspaceId,
            title: entry.session.title,
            projectName: entry.project.name,
          },
        ];
      }),
    [openWorkIds, sessionIndex],
  );

  const openOpenWork = useCallback(
    (item: HubOpenWorkItem) => {
      const entry = sessionIndex.get(item.sessionId);
      if (entry) openSession(entry.session);
    },
    [openSession, sessionIndex],
  );

  const closeOpenWork = useCallback(
    (item: HubOpenWorkItem) => {
      updateOpenWorkIds((prev) => prev.filter((id) => id !== item.sessionId));
      setAnnouncement(t('hub.closedOpenWork', { name: item.title }));
    },
    [t, updateOpenWorkIds],
  );

  const peeked = peekedSessionId ? (sessionIndex.get(peekedSessionId) ?? null) : null;

  const peekSession = useCallback((session: HubSessionNode) => {
    setPeekedSessionId(session.id);
  }, []);

  const openPeekedSession = useCallback(
    (session: HubSessionNode) => {
      setPeekedSessionId(null);
      openSession(session);
    },
    [openSession],
  );

  const closeInspector = useCallback(() => {
    const current = peeked;
    setPeekedSessionId(null);
    // Peeking is a rail interaction, so dismissing it belongs back on the row
    // that opened it rather than at the top of the document.
    if (!current) return;
    document
      .querySelector<HTMLElement>(`[data-testid="hub-session-${current.session.id}"]`)
      ?.focus();
  }, [peeked]);

  // The rail's Ctrl/Cmd+I shortcut is dispatched as an event rather than wired
  // directly, so the shortcut owner does not need to reach into inspector
  // state. All three entry points - the peek button, Space on a focused row,
  // and this shortcut - converge on the same `peekedSessionId`.
  useEffect(() => {
    const toggleInspector = () => {
      setPeekedSessionId((current) => {
        if (current) return null;
        // Prefer whatever the keyboard is already on, then the open session,
        // so the shortcut inspects what the user is looking at.
        const focusedId = document.activeElement?.getAttribute('data-session-id') ?? null;
        const target = focusedId ?? currentSessionId;
        return target && sessionIndex.has(target) ? target : null;
      });
    };
    window.addEventListener(HUB_INSPECTOR_TOGGLE_EVENT, toggleInspector);
    return () => window.removeEventListener(HUB_INSPECTOR_TOGGLE_EVENT, toggleInspector);
  }, [currentSessionId, sessionIndex]);

  const moveSession = useCallback(
    async (session: HubSessionNode, folderId: string | null): Promise<boolean> => {
      if (session.folderId === folderId) return true;
      const target = folderId === null
        ? noProjectLabel
        : (railTree.folders.find((folder) => folder.id === folderId)?.name ?? noProjectLabel);
      const moved = await mutateRail(
        (tree) => placeSession(tree, session, folderId),
        () => moveSessionRequest(session.id, folderId),
      );
      if (moved && mountedRef.current) {
        setAnnouncement(t('hub.sessionMoved', { name: session.title, target }));
      }
      return moved !== null;
    },
    [mutateRail, noProjectLabel, railTree.folders, t],
  );

  const renameSession = useCallback((session: HubSessionNode, title: string) => {
    void mutateRail(
      (tree) => mapSessions(tree, (candidate) =>
        candidate.id === session.id ? { ...candidate, title } : candidate),
      () => renameSessionRequest(session.id, title),
    );
  }, [mutateRail]);

  const restorePendingSession = useCallback(
    (pending: HubPendingSessionDeletion) => {
      setRemovedSessionIds((prev) => prev.filter((id) => id !== pending.session.id));
      if (pending.wasOpen) {
        updateOpenWorkIds((prev) => prev.includes(pending.session.id) ? prev : [...prev, pending.session.id]);
      }
      if (pending.wasPeeked) setPeekedSessionId(pending.session.id);
    },
    [updateOpenWorkIds],
  );

  const commitPendingSessionDeletion = useCallback(() => {
    const pending = pendingSessionDeletionRef.current;
    if (!pending) return;
    pendingSessionDeletionRef.current = null;
    setPendingSessionDeletion(null);
    void deleteSessionRequest(pending.session.id).then((ok) => {
      if (!ok && mountedRef.current) restorePendingSession(pending);
    });
  }, [restorePendingSession]);

  const undoPendingSessionDeletion = useCallback(() => {
    const pending = pendingSessionDeletionRef.current;
    if (!pending) return;
    pendingSessionDeletionRef.current = null;
    setPendingSessionDeletion(null);
    restorePendingSession(pending);
  }, [restorePendingSession]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pending = pendingSessionDeletionRef.current;
      pendingSessionDeletionRef.current = null;
      if (pending) {
        void deleteSessionRequest(pending.session.id);
      }
    };
  }, []);

  const deleteSession = useCallback(
    (session: HubSessionNode) => {
      commitPendingSessionDeletion();
      const pending = {
        session,
        wasOpen: openWorkIdsRef.current.includes(session.id),
        wasPeeked: peekedSessionId === session.id,
      } satisfies HubPendingSessionDeletion;
      setRemovedSessionIds((prev) => (prev.includes(session.id) ? prev : [...prev, session.id]));
      updateOpenWorkIds((prev) => prev.filter((id) => id !== session.id));
      setPeekedSessionId((prev) => (prev === session.id ? null : prev));
      pendingSessionDeletionRef.current = pending;
      setPendingSessionDeletion(pending);
      setAnnouncement(t('hub.sessionDeleted', { name: session.title }));
    },
    [commitPendingSessionDeletion, peekedSessionId, t, updateOpenWorkIds],
  );

  const createFolder = useCallback(async (name: string): Promise<HubFolderNode | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const created = await mutateRail(null, () => createFolderRequest(trimmed));
    if (!created) return null;
    const node: HubFolderNode = { id: created.id, name: created.name, updatedAt: created.updatedAt, sessions: [] };
    // Show the new folder at once; the reconcile read started above confirms it.
    if (mountedRef.current) {
      setRailTree((tree) => tree.folders.some((folder) => folder.id === node.id)
        ? tree
        : { ...tree, folders: [node, ...tree.folders] });
    }
    return node;
  }, [mutateRail]);

  const renameFolder = useCallback(async (folder: HubFolderNode, name: string): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name) return false;
    const renamed = await mutateRail(
      (tree) => ({
        ...tree,
        folders: tree.folders.map((candidate) =>
          candidate.id === folder.id ? { ...candidate, name: trimmed } : candidate),
      }),
      () => renameFolderRequest(folder.id, trimmed),
    );
    return renamed !== null;
  }, [mutateRail]);

  const deleteFolder = useCallback(
    async (folder: HubFolderNode, sessions: DeleteFolderSessionsPolicy = 'keep'): Promise<boolean> => {
      const ids = new Set(folder.sessions.map((session) => session.id));
      setSelectedFolderState((current) => (current?.id === folder.id ? null : current));
      if (sessions === 'delete') {
        updateOpenWorkIds((prev) => prev.filter((id) => !ids.has(id)));
        setPeekedSessionId((prev) => (prev && ids.has(prev) ? null : prev));
      }
      const result = await mutateRail(
        (tree) => {
          const target = tree.folders.find((candidate) => candidate.id === folder.id);
          const kept = sessions === 'keep'
            ? (target?.sessions ?? []).map((session) => ({ ...session, folderId: null }))
            : [];
          return {
            folders: tree.folders.filter((candidate) => candidate.id !== folder.id),
            recents: [...tree.recents, ...kept].sort(byRecency),
          };
        },
        () => deleteFolderRequest(folder.id, sessions),
      );
      return result !== null;
    },
    [mutateRail, updateOpenWorkIds],
  );

  return {
    currentSessionId,
    railCollapsed,
    narrow,
    railWidth,
    railResizing,
    toggleRail,
    beginRailResize,
    setRailWidth,
    searchRef,
    query,
    setQuery,
    expandRailForSearch,
    allTree,
    tree,
    railStatus,
    retrySessions,
    running,
    announcement,
    openWork,
    openSession,
    openOpenWork,
    closeOpenWork,
    peeked,
    peekSession,
    openPeekedSession,
    closeInspector,
    selectedFolder,
    selectFolder,
    clearSelectedFolder,
    newSession,
    moveSession,
    renameSession,
    deleteSession,
    createFolder,
    renameFolder,
    deleteFolder,
    pendingSessionDeletion,
    undoPendingSessionDeletion,
    commitPendingSessionDeletion,
    paletteOpen,
    paletteEntries,
    openPalette,
    closePalette,
    commandChip,
    consumeCommandChip,
  };
}
