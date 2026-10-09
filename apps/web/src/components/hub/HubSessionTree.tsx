// Left-panel navigation for the entry hub.
//
// This is the single navigation model for the entry surface: a `프로젝트`
// section of folders that expand into their sessions in place, then a `최근`
// section of standalone sessions. Activating a session hands off directly to
// the workspace; a folder has no workspace of its own - clicking it toggles
// the disclosure and makes it the composer's context. Follows the ARIA tree
// pattern - one tab stop (roving tabindex), arrow-key traversal, and a group
// per folder.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { createPortal } from 'react-dom';
import { Button } from '@readable-studio/components';
import type { DeleteFolderSessionsPolicy } from '@readable-studio/contracts';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { HubMenu, type HubMenuItem } from './HubMenu';
import { initialGlyph } from './initialGlyph';
import { relativeTimeShort } from './relativeTime';
import {
  HUB_RECENTS_PAGE,
  HUB_SESSION_PAGE,
  folderMatchesFilter,
  matchesHubFilter,
  rollupFolderState,
  sortFolders,
  type HubFilter,
  type HubFolderNode,
  type HubRailTree,
  type HubSessionNode,
  type HubSessionState,
  type HubSessionsStatus,
  type HubSort,
} from './types';

/** The drag payload type a session row carries; nothing else is accepted. */
export const HUB_SESSION_DRAG_TYPE = 'application/x-readable-session';

interface Props {
  tree: HubRailTree;
  /** Move destinations are never narrowed by the rail search. */
  moveFolders?: HubFolderNode[];
  /** Open one folder when this tree is used in the compact hub rail, preferring live work. */
  compactByDefault?: boolean;
  /** Content placed after the shared filters and before the folder tree. */
  openWork?: ReactNode;
  /**
   * The rail is showing glyphs only. Sessions are not rendered inline, so a
   * folder's sessions and the recents are reached through shared-row flyouts.
   */
  collapsed?: boolean;
  /**
   * The owner already narrowed `tree` by a search query. An empty tree then
   * means "nothing matched", not "nothing exists".
   */
  searching?: boolean;
  /**
   * One status for the whole rail. `loading` and `unavailable` with an empty
   * tree mean "unknown", not "nothing exists"; `stale`/`unavailable` render a
   * single retry row.
   */
  railStatus?: HubSessionsStatus;
  /** Clears the rail-owned search query alongside this tree's status filter. */
  onClearFilter?: () => void;
  currentSessionId: string | null;
  /** The folder currently chosen as the composer's context, if any. */
  selectedFolderId?: string | null;
  onOpenSession: (session: HubSessionNode) => void;
  /** Go to the composer; with a folder it becomes the composer's context. */
  onNewSession?: (folder?: HubFolderNode) => void;
  /** Folder row click / Enter: make it the composer's context. */
  onSelectFolder?: (folder: HubFolderNode) => void;
  /** Esc on the selected folder row clears the context. */
  onClearSelectedFolder?: () => void;
  /** Re-reads the whole rail. */
  onRetrySessions?: () => void;
  /** Open the inspector for a session without navigating to it. */
  onPeekSession?: (session: HubSessionNode) => void;
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (folder: HubFolderNode, name: string) => void;
  onDeleteFolder?: (folder: HubFolderNode, sessions: DeleteFolderSessionsPolicy) => void;
  onRenameSession?: (session: HubSessionNode, title: string) => void;
  onDeleteSession?: (session: HubSessionNode) => void;
  /** `null` = "No project" (recents). */
  onMoveSession?: (session: HubSessionNode, folderId: string | null) => void;
}

interface FlatRow {
  key: string;
  kind: 'folder' | 'session' | 'more';
  /** `null` for rows in the recents section. */
  folder: HubFolderNode | null;
  /** The rendered folder state, including compact-by-default policy. */
  open?: boolean;
  session?: HubSessionNode;
}

interface MenuState {
  rowKey: string;
  anchor: HTMLElement;
  /** Set when the menu was opened from a right-click, so it hangs off the pointer. */
  point?: { x: number; y: number };
  /** The `이동 ▸` drill-down lives inside the same menu as a second page. */
  page: 'root' | 'move';
}

interface ConfirmAction {
  label: string;
  testId: string;
  danger?: boolean;
  run: () => void;
}

/**
 * A queued destructive action. Folder delete is confirmed through the same
 * `modal-confirm` alertdialog the projects grid already uses, so the rail
 * cannot become the one place a folder vanishes on a single click.
 */
interface ConfirmState {
  title: string;
  message: string;
  rowKey: string;
  /** The first action is the default (focused); the cancel button is implicit. */
  actions: ConfirmAction[];
}

// Hovering must not fire a flyout the pointer only crossed on its way
// somewhere else, and it must not lag behind a deliberate hover either.
const FLYOUT_HOVER_DELAY_MS = 180;
const COMPACT_SESSION_QUERY = '(max-height: 760px) and (max-width: 900px)';
const COMPACT_SESSION_PAGE = 4;
const RECENTS_KEY = 'recents';
const RECENTS_MORE_KEY = 'm:recents';
const CREATE_KEY = 'create';
const FOLDER_COLLAPSED_KEY = 'readable-studio:hub-folder-collapsed';

function loadFolderCollapsed(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(FOLDER_COLLAPSED_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, state]) => typeof state === 'boolean'));
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------------------
 * Session-surface handoff: Hub session tree -> workspace.
 *
 * The Hub and the workspace are separate routes, so a session-tree action that
 * must open a surface INSIDE the workspace has to survive one navigation. That
 * handoff used to be a single GLOBAL sessionStorage key holding a bare request,
 * and every property the message lacked turned into the same user-visible bug:
 *
 *   "워크스페이스 탭에 가끔 채팅 내용이 들어가는데, 거기 대체 그게 왜 들어가냐고."
 *
 *   - UNADDRESSED. One global key was offered to whichever project mounted
 *     next. The reader compared ids and returned null on a mismatch WITHOUT
 *     removing the entry, so a navigation that landed anywhere else left the
 *     request ARMED indefinitely; a later ordinary visit to the original project
 *     then opened a chat tab with no contemporaneous click. That is the 가끔.
 *   - IMMORTAL. sessionStorage survives reloads, so an unconsumed request
 *     outlived the navigation that created it without bound.
 *   - SINGLE-SLOT. Queuing one request silently destroyed a pending other.
 *
 * A cross-route handoff is a one-shot addressed message with a deadline, so
 * that is what it is now - rather than yet another guard bolted onto the
 * reader, which is what let the previous protocol look correct:
 *
 *   1. ADDRESSED. The key is scoped to the destination project, so a workspace
 *      can only ever read its OWN project's request. Delivery to the wrong
 *      project is impossible by construction instead of resting on a runtime id
 *      comparison a future reader can forget to write.
 *   2. ONE-SHOT. Reading DRAINS the whole mailbox, not just the matching entry.
 *      There is exactly one navigation in flight at a time, so the first
 *      workspace to mount after the click resolves it - and a request that
 *      reached the wrong project is thereby disarmed instead of lying in wait.
 *   3. PERISHABLE. The envelope carries a producer-authored deadline. A handoff
 *      is one route transition long; anything older is not this navigation and
 *      is dropped when read and again when it would be applied.
 *
 * `FileWorkspace` is the only reader and honours the same deadline at apply
 * time - see the handoff effect there. Both halves of the protocol are stated
 * in these two places and nowhere else.
 * ------------------------------------------------------------------------- */

export const HUB_SESSION_SURFACE_REQUEST_KEY = 'readable-studio:session-surface-request';

/**
 * How long a queued request stays deliverable. This spans one route transition
 * plus the workspace's tab hydration, so it is generous by an order of
 * magnitude - it is a backstop against a request that is never collected, not a
 * performance budget. What it must NOT span is the gap to a later, unrelated
 * visit, which is exactly the window the old protocol left wide open.
 */
export const HUB_SESSION_SURFACE_TTL_MS = 30_000;

export type HubSessionSurfaceRequest =
  | { projectId: string; kind: 'terminal' }
  | { projectId: string; kind: 'side-chat'; conversationId: string };

/** A request plus the deadline its producer stamped on it. */
interface HubSessionSurfaceDelivery {
  request: HubSessionSurfaceRequest;
  /** Epoch ms after which this request is no longer this navigation's. */
  expiresAt: number;
}

/** The mailbox slot addressed to one project. */
function hubSessionSurfaceKey(projectId: string): string {
  return `${HUB_SESSION_SURFACE_REQUEST_KEY}:${projectId}`;
}

/** Every slot currently in the mailbox, including the legacy unaddressed one. */
function hubSessionSurfaceKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key && key.startsWith(HUB_SESSION_SURFACE_REQUEST_KEY)) keys.push(key);
  }
  return keys;
}

export function queueHubSessionSurface(request: HubSessionSurfaceRequest): void {
  const delivery: HubSessionSurfaceDelivery = {
    request,
    expiresAt: Date.now() + HUB_SESSION_SURFACE_TTL_MS,
  };
  window.sessionStorage.setItem(hubSessionSurfaceKey(request.projectId), JSON.stringify(delivery));
}

export function consumeHubSessionSurface(projectId: string): HubSessionSurfaceDelivery | null {
  const raw = window.sessionStorage.getItem(hubSessionSurfaceKey(projectId));

  // Draining happens FIRST and unconditionally, so every path below - match,
  // mismatch, malformed, expired - leaves an empty mailbox. A request is spent
  // by the attempt to collect it; nothing survives to fire at a later time.
  // Slots addressed to other projects go too: the navigation they belonged to
  // has resolved (here, evidently, rather than where it was aimed), and an
  // upgrade from the pre-addressing build can leave the legacy key behind.
  for (const key of hubSessionSurfaceKeys()) window.sessionStorage.removeItem(key);

  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const envelope = value as Record<string, unknown>;

  const expiresAt = envelope.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (Date.now() > expiresAt) return null;

  const candidate = envelope.request;
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;

  // The key already addresses this project; a payload that disagrees with its
  // own envelope is corrupt (or hand-written) and is refused rather than
  // re-pointed at whoever happened to open it.
  if (record.projectId !== projectId) return null;

  if (record.kind === 'terminal') {
    return { request: { projectId, kind: 'terminal' }, expiresAt };
  }
  if (record.kind === 'side-chat' && typeof record.conversationId === 'string') {
    return {
      request: { projectId, kind: 'side-chat', conversationId: record.conversationId },
      expiresAt,
    };
  }
  return null;
}

type StateLabelKey = 'hub.stateRunning' | 'hub.stateAwaiting' | 'hub.stateFailed';

function stateLabelKey(state: HubSessionState): StateLabelKey | null {
  if (state === 'running') return 'hub.stateRunning';
  if (state === 'awaiting') return 'hub.stateAwaiting';
  if (state === 'failed') return 'hub.stateFailed';
  return null;
}

const byRecency = (a: HubSessionNode, b: HubSessionNode) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Only a session row's own payload is accepted; file drops stay with the composer. */
function hasSessionDrag(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(HUB_SESSION_DRAG_TYPE);
}

export function HubSessionTree({
  tree,
  moveFolders = tree.folders,
  compactByDefault = false,
  openWork,
  collapsed: railCollapsed = false,
  searching = false,
  railStatus = 'ready',
  onClearFilter,
  currentSessionId,
  selectedFolderId = null,
  onOpenSession,
  onNewSession,
  onSelectFolder,
  onClearSelectedFolder,
  onRetrySessions,
  onPeekSession,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRenameSession,
  onDeleteSession,
  onMoveSession,
}: Props) {
  const t = useT();
  const [filter, setFilter] = useState<HubFilter>('all');
  const [sort, setSort] = useState<HubSort>('recent');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadFolderCollapsed);
  const [expandedOverflow, setExpandedOverflow] = useState<Record<string, boolean>>({});
  // Mark navigation handled only once its session arrives in the asynchronous rail read.
  const revealedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentSessionId === null) {
      revealedSessionRef.current = null;
      return;
    }
    if (revealedSessionRef.current === currentSessionId) return;
    const folder = moveFolders.find((candidate) => candidate.sessions.some((session) => session.id === currentSessionId));
    if (!folder && !tree.recents.some((session) => session.id === currentSessionId)) return;
    revealedSessionRef.current = currentSessionId;
    if (folder) {
      setCollapsed((prev) => ({ ...prev, [folder.id]: false }));
      setExpandedOverflow((prev) => ({ ...prev, [folder.id]: true }));
    }
  }, [currentSessionId, moveFolders, tree.recents]);

  useEffect(() => {
    // Search narrows tree.folders; prune only against the complete move destinations.
    if (railStatus !== 'ready') return;
    const ids = new Set(moveFolders.map((folder) => folder.id));
    const next = Object.fromEntries(Object.entries(collapsed).filter(([id]) => ids.has(id)));
    window.localStorage.setItem(FOLDER_COLLAPSED_KEY, JSON.stringify(next));
    if (Object.keys(next).length !== Object.keys(collapsed).length) setCollapsed(next);
  }, [collapsed, moveFolders, railStatus]);
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The collapsed rail's session flyout. Its reused rows own their normal
  // overflow menu, with a separate anchor above this flyout.
  const [flyout, setFlyout] = useState<{ folderId: string; anchor: HTMLElement } | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [compactSessionPage, setCompactSessionPage] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT_SESSION_QUERY).matches,
  );
  // Rename happens in place: a modal for one field is heavier than the edit.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Folder creation is an inline row in edit mode, never a modal.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmState | null>(null);
  // Which drop target the dragged session is over: a folder id, or `recents`.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const confirmId = useId();
  const confirmRef = useRef<HTMLDivElement>(null);
  const defaultActionRef = useRef<HTMLButtonElement>(null);
  const typeAheadRef = useRef('');
  const typeAheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row activated out of existence (the overflow row) hands focus to a row
  // that only mounts on the next render, so the target is claimed by whichever
  // ref callback registers it rather than by an effect that may run first.
  const pendingFocusRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation lives above the shell, not inside the rail's filtered,
  // scrolling containing block. Keep its keyboard scope there too, including
  // focus moved programmatically by another shell control.
  useEffect(() => {
    if (!confirming) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    defaultActionRef.current?.focus();
    const onFocus = (event: FocusEvent) => {
      if (!confirmRef.current?.contains(event.target as Node)) defaultActionRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setConfirming(null);
      } else if (event.key === 'Tab') {
        const buttons = confirmRef.current?.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      // A completed deletion can remove the origin in the same commit.
      const target = rowRefs.current.get(confirming.rowKey) ?? rowRefs.current.values().next().value;
      target?.focus();
    };
  }, [confirming]);

  const cancelHoverFlyout = useCallback(() => {
    if (hoverTimerRef.current === null) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  // A pending hover that fires after the rail expands would open a flyout with
  // no rail to anchor it to, and an unmounted timer would set state on a dead
  // component.
  useEffect(() => cancelHoverFlyout, [cancelHoverFlyout]);

  useEffect(() => {
    if (railCollapsed) return;
    cancelHoverFlyout();
    setFlyout(null);
  }, [railCollapsed, cancelHoverFlyout]);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_SESSION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompactSessionPage(event.matches);
    setCompactSessionPage(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const ordered = useMemo(() => sortFolders(tree.folders, sort), [tree.folders, sort]);
  const sessionPageSize = compactSessionPage ? COMPACT_SESSION_PAGE : HUB_SESSION_PAGE;
  // Compact mode has room for one expanded folder. That slot must follow live
  // work rather than incidental folder recency: the Hub's live strip can point
  // at a running session in an older folder, and collapsing that same folder
  // leaves its session and overflow rows mounted under `hidden` with no visible
  // route to them. Explicit disclosure choices in `collapsed` still win.
  const defaultOpenFolderId = compactByDefault
    ? (ordered.find((folder) => folder.sessions.some((session) => session.state === 'running'))
        ?.id ?? ordered[0]?.id)
    : undefined;

  const visible = useMemo(() => {
    return ordered
      .map((folder) => {
        const matching = [...folder.sessions]
          .sort(byRecency)
          .filter((session) => matchesHubFilter(session.state, filter));
        const capped =
          filter === 'all' && !expandedOverflow[folder.id]
            ? matching.slice(0, sessionPageSize)
            : matching;
        return {
          folder,
          sessions: capped,
          hiddenCount: matching.length - capped.length,
          // A filtered view always reveals its matches, so only the unfiltered
          // list is allowed to stay collapsed.
          open:
            filter !== 'all'
              ? true
              : collapsed[folder.id] === undefined
                ? !compactByDefault || folder.id === defaultOpenFolderId
                : !collapsed[folder.id],
          empty: matching.length === 0,
          selfMatches: folderMatchesFilter(folder, filter),
        };
      })
      .filter((entry) => (filter === 'all' ? true : !entry.empty || entry.selfMatches));
  }, [
    ordered,
    filter,
    collapsed,
    expandedOverflow,
    sessionPageSize,
    compactByDefault,
    defaultOpenFolderId,
  ]);

  // Recents are always recency-ordered; the sort control orders folders only.
  const recents = useMemo(() => {
    const matching = tree.recents.filter((session) => session.folderId === null)
      .sort(byRecency)
      .filter((session) => matchesHubFilter(session.state, filter));
    const capped = filter === 'all' && !expandedOverflow[RECENTS_KEY]
      ? matching.slice(0, HUB_RECENTS_PAGE)
      : matching;
    return { sessions: capped, hiddenCount: matching.length - capped.length };
  }, [tree.recents, filter, expandedOverflow]);

  const rows = useMemo<FlatRow[]>(() => {
    const next: FlatRow[] = [];
    for (const entry of visible) {
      next.push({ key: `p:${entry.folder.id}`, kind: 'folder', folder: entry.folder, open: entry.open });
      // Session rows are hidden in the collapsed rail, so leaving them in the
      // row model would send arrow-key focus to invisible rows.
      if (railCollapsed) continue;
      if (!entry.open) continue;
      for (const session of entry.sessions) {
        next.push({ key: `s:${session.id}`, kind: 'session', folder: entry.folder, session });
      }
      if (entry.hiddenCount > 0) {
        next.push({ key: `m:${entry.folder.id}`, kind: 'more', folder: entry.folder });
      }
    }
    if (railCollapsed) {
      const folder = flyout ? visible.find((entry) => entry.folder.id === flyout.folderId)?.folder : null;
      const sessions = flyout?.folderId === RECENTS_KEY ? tree.recents : folder?.sessions ?? [];
      for (const session of [...sessions].sort(byRecency)) {
        next.push({ key: `s:${session.id}`, kind: 'session', folder: folder ?? null, session });
      }
      return next;
    }
    for (const session of recents.sessions) {
      next.push({ key: `s:${session.id}`, kind: 'session', folder: null, session });
    }
    if (recents.hiddenCount > 0) next.push({ key: RECENTS_MORE_KEY, kind: 'more', folder: null });
    return next;
  }, [visible, recents, railCollapsed, flyout, tree.recents]);

  useEffect(() => {
    if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length, cursor]);

  // A row removed underneath an open menu would leave the menu anchored to a
  // detached node and its focus-restore target gone.
  useEffect(() => {
    if (menu && !rows.some((row) => row.key === menu.rowKey)) setMenu(null);
    if (renaming && !rows.some((row) => row.key === renaming)) setRenaming(null);
    if (flyout && flyout.folderId !== RECENTS_KEY && !rows.some((row) => row.key === `p:${flyout.folderId}`)) setFlyout(null);
    // A confirmation whose subject is already gone would delete nothing and
    // strand focus on a detached row.
    if (confirming && !rows.some((row) => row.key === confirming.rowKey)) setConfirming(null);
  }, [rows, menu, renaming, flyout, confirming]);

  useEffect(() => () => {
    if (typeAheadTimerRef.current) clearTimeout(typeAheadTimerRef.current);
  }, []);

  // One destructive path for the whole tree: the row menu, the context menu and
  // the Delete key all queue the same confirmation instead of each growing its
  // own idea of what "safe" means. A folder with no sessions has nothing to
  // ask about and deletes at once.
  const confirmDeleteFolder = useCallback(
    (folder: HubFolderNode) => {
      if (!onDeleteFolder) return;
      if (folder.sessions.length === 0) {
        onDeleteFolder(folder, 'keep');
        return;
      }
      setConfirming({
        title: t('hub.deleteFolderTitle'),
        message: t('hub.deleteFolderBody', { count: String(folder.sessions.length) }),
        rowKey: `p:${folder.id}`,
        actions: [
          {
            label: t('hub.deleteFolderKeep'),
            testId: 'hub-delete-confirm-cta',
            run: () => onDeleteFolder(folder, 'keep'),
          },
          {
            label: t('hub.deleteFolderAll'),
            testId: 'hub-delete-folder-all',
            danger: true,
            run: () => onDeleteFolder(folder, 'delete'),
          },
        ],
      });
    },
    [onDeleteFolder, t],
  );

  // Sessions are NOT confirmed here on purpose: the hub already deletes a
  // session optimistically behind an undoable toast, and stacking a modal on
  // top of an undo would be friction without added safety. Folders have no
  // undo, so they get the dialog.
  const deleteSession = useCallback(
    (session: HubSessionNode) => {
      onDeleteSession?.(session);
    },
    [onDeleteSession],
  );

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setCursor(index);
      rowRefs.current.get(row.key)?.focus();
    },
    [rows],
  );

  const revealOverflow = useCallback(
    (row: FlatRow) => {
      // The "more" row disappears once its sessions render, so hand focus to
      // the first newly revealed session rather than letting it fall to body.
      // Index against the rows the current filter actually shows.
      const key = row.folder ? row.folder.id : RECENTS_KEY;
      const source = row.folder ? row.folder.sessions : tree.recents;
      const page = row.folder ? sessionPageSize : HUB_RECENTS_PAGE;
      const shown = [...source].sort(byRecency).filter((s) => matchesHubFilter(s.state, filter));
      const firstHidden = shown[page]?.id;
      setExpandedOverflow((prev) => ({ ...prev, [key]: true }));
      if (firstHidden) pendingFocusRef.current = `s:${firstHidden}`;
    },
    [filter, sessionPageSize, tree.recents],
  );

  const activate = useCallback(
    (row: FlatRow) => {
      if (row.kind === 'session' && row.session) {
        onOpenSession(row.session);
        return;
      }
      if (row.kind === 'more') {
        revealOverflow(row);
        return;
      }
      if (!row.folder) return;
      if (railCollapsed) {
        // There is nothing to expand into: the sessions group is not rendered
        // in the collapsed rail, so activating a folder offers them directly.
        const anchor = rowRefs.current.get(row.key);
        if (anchor) {
          setFlyout((prev) =>
            prev?.folderId === row.folder?.id ? null : { folderId: row.folder!.id, anchor },
          );
        }
        onSelectFolder?.(row.folder);
        return;
      }
      // The folder row is the tree's disclosure control AND the composer's
      // context picker. Toggle the state the user can actually see: compact
      // mode closes non-leading folders without writing that default to
      // `collapsed`.
      setCollapsed((prev) => ({ ...prev, [row.folder!.id]: row.open === true }));
      onSelectFolder?.(row.folder);
    },
    [onOpenSession, onSelectFolder, railCollapsed, revealOverflow],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, fallbackIndex: number) => {
      // Descendant controls own their keys and native button activation. Only
      // the focused treeitem may run tree navigation or row shortcuts.
      if (event.target !== event.currentTarget) return;
      // Resolve the row from the focused element so keyboard traversal stays
      // correct even when focus arrived without going through onClick.
      const focusedKey = event.currentTarget.dataset.rowKey;
      const resolved = focusedKey ? rows.findIndex((candidate) => candidate.key === focusedKey) : -1;
      const index = resolved >= 0 ? resolved : fallbackIndex;
      const row = rows[index];
      if (!row) return;
      // A session group lives INSIDE its folder treeitem for ARIA ownership, so
      // an unstopped key would run this handler again on the ancestor row and
      // act twice - Space on a session would also collapse its folder.
      event.stopPropagation();
      switch (event.key) {
        case 'F2': {
          if (row.kind === 'more') break;
          const canRename = row.kind === 'folder' ? onRenameFolder : onRenameSession;
          if (!canRename) break;
          event.preventDefault();
          setRenaming(row.key);
          break;
        }
        case 'Delete':
          if (row.kind === 'more') break;
          event.preventDefault();
          if (row.kind === 'folder' && row.folder) {
            confirmDeleteFolder(row.folder);
          } else if (row.session) {
            deleteSession(row.session);
            focusRow(Math.min(index + 1, rows.length - 1));
          }
          break;
        case 'F10':
        case 'ContextMenu': {
          // The keyboard route into the context menu: Shift+F10 and the menu
          // key are what the platform already trains people to press, so a
          // right-click-only feature does not lock out keyboard users.
          if (row.kind === 'more') break;
          if (event.key === 'F10' && !event.shiftKey) break;
          event.preventDefault();
          const anchor = rowRefs.current.get(row.key);
          if (!anchor) break;
          setMenu({ rowKey: row.key, anchor, page: 'root' });
          break;
        }
        case 'Escape':
          // Esc on the selected folder row drops it as the composer context.
          if (row.kind === 'folder' && row.folder && row.folder.id === selectedFolderId) {
            event.preventDefault();
            onClearSelectedFolder?.();
          }
          break;
        case 'ArrowDown':
          event.preventDefault();
          focusRow(Math.min(index + 1, rows.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusRow(Math.max(index - 1, 0));
          break;
        case 'Home':
          event.preventDefault();
          focusRow(0);
          break;
        case 'End':
          event.preventDefault();
          focusRow(rows.length - 1);
          break;
        case 'ArrowRight':
          if (row.kind !== 'folder' || !row.folder) break;
          event.preventDefault();
          if (collapsed[row.folder.id]) {
            setCollapsed((prev) => ({ ...prev, [row.folder!.id]: false }));
          } else {
            focusRow(Math.min(index + 1, rows.length - 1));
          }
          break;
        case 'ArrowLeft': {
          event.preventDefault();
          if (row.kind === 'folder' && row.folder && !collapsed[row.folder.id]) {
            setCollapsed((prev) => ({ ...prev, [row.folder!.id]: true }));
            break;
          }
          if (!row.folder) break;
          const parent = rows.findIndex(
            (candidate) => candidate.kind === 'folder' && candidate.folder?.id === row.folder?.id,
          );
          if (parent >= 0) focusRow(parent);
          break;
        }
        case 'Enter':
          event.preventDefault();
          activate(row);
          break;
        case ' ':
          event.preventDefault();
          // Space peeks a session rather than opening it - the whole point of
          // the inspector is inspecting without leaving the rail. Folders have
          // nothing to peek, so Space keeps toggling them.
          if (row.kind === 'session' && row.session && onPeekSession) {
            onPeekSession(row.session);
            break;
          }
          activate(row);
          break;
        default:
          if (
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            typeAheadRef.current += event.key.toLocaleLowerCase();
            if (typeAheadTimerRef.current) clearTimeout(typeAheadTimerRef.current);
            typeAheadTimerRef.current = setTimeout(() => {
              typeAheadRef.current = '';
            }, 800);
            const match = rows.findIndex((candidate) => {
              const name = candidate.session?.title ?? candidate.folder?.name ?? '';
              return candidate.kind !== 'more'
                && name.toLocaleLowerCase().startsWith(typeAheadRef.current);
            });
            if (match >= 0) focusRow(match);
          }
          break;
      }
    },
    [
      rows,
      focusRow,
      collapsed,
      activate,
      onPeekSession,
      onRenameFolder,
      onRenameSession,
      onClearSelectedFolder,
      selectedFolderId,
      confirmDeleteFolder,
      deleteSession,
    ],
  );

  // Right-click must open the menu at the pointer WITHOUT running the row's
  // normal activation - a context menu that also navigated away would be
  // useless.
  const openContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, rowKey: string, index: number) => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = rowRefs.current.get(rowKey) ?? (event.currentTarget as HTMLElement);
      if (index >= 0) setCursor(index);
      setMenu({ rowKey, anchor, point: { x: event.clientX, y: event.clientY }, page: 'root' });
    },
    [],
  );

  // Counts count SESSIONS across both sections, not folders.
  const counts = useMemo(() => {
    const all = [...tree.folders.flatMap((folder) => folder.sessions), ...tree.recents];
    return {
      attention: all.filter((s) => matchesHubFilter(s.state, 'attention')).length,
      running: all.filter((s) => matchesHubFilter(s.state, 'running')).length,
    };
  }, [tree]);

  // The results count is what the list is actually showing once a filter or
  // search narrows the view: matching sessions in both sections.
  const resultCount = useMemo(
    () => visible.reduce((total, entry) => total + entry.sessions.length, 0) + recents.sessions.length,
    [visible, recents],
  );

  const syncCursorToFocus = useCallback(
    (key: string) => {
      const index = rows.findIndex((row) => row.key === key);
      if (index >= 0) setCursor(index);
    },
    [rows],
  );

  const registerRow = (key: string) => (node: HTMLDivElement | null) => {
    if (!node) {
      rowRefs.current.delete(key);
      return;
    }
    rowRefs.current.set(key, node);
    if (pendingFocusRef.current === key) {
      pendingFocusRef.current = null;
      node.focus();
    }
  };

  const indexOfKey = (key: string) => rows.findIndex((row) => row.key === key);

  const menuRow = menu ? (rows.find((row) => row.key === menu.rowKey) ?? null) : null;

  // HubMenu dismisses before invoking an action. Keep this page's anchor in
  // the closure so the action can replace the dismissed page in the same turn.
  const openMovePage = useCallback(() => {
    if (menu) setMenu({ ...menu, page: 'move' });
  }, [menu]);
  const openRootPage = useCallback(() => {
    if (menu) setMenu({ ...menu, page: 'root' });
  }, [menu]);

  useEffect(() => {
    if (menu?.page !== 'move') return;
    // HubMenu's shared item contract has no disabled field. Mark only the
    // current-location radio inert; all positioning and navigation stay there.
    const current = document.querySelector<HTMLButtonElement>('[data-testid="hub-row-menu"] [aria-checked="true"]');
    if (current) {
      current.disabled = true;
      current.setAttribute('aria-disabled', 'true');
    }
  }, [menu]);

  const menuItems = useMemo<HubMenuItem[]>(() => {
    if (!menuRow || !menu) return [];
    if (menuRow.kind === 'folder' && menuRow.folder) {
      const folder = menuRow.folder;
      const items: HubMenuItem[] = [];
      if (onNewSession) {
        items.push({
          kind: 'action',
          id: 'new-session',
          label: t('hub.newSession'),
          icon: 'plus',
          onSelect: () => onNewSession(folder),
        });
      }
      if (onRenameFolder) {
        items.push({
          kind: 'action',
          id: 'rename',
          label: t('hub.menuRename'),
          icon: 'pencil',
          shortcut: 'F2',
          onSelect: () => setRenaming(menuRow.key),
        });
      }
      if (onDeleteFolder) {
        items.push({
          kind: 'action',
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash',
          shortcut: 'Del',
          danger: true,
          onSelect: () => confirmDeleteFolder(folder),
        });
      }
      return items;
    }
    const session = menuRow.session;
    if (!session) return [];
    if (menu.page === 'move' && onMoveSession) {
      // The drill-down: "No project" plus every folder, as radios with the
      // current location checked. Selecting the current location is a no-op.
      const targets: Array<{ id: string | null; name: string }> = [
        { id: null, name: t('hub.moveNoProject') },
        ...moveFolders.map((folder) => ({ id: folder.id, name: folder.name })),
      ];
      const back: HubMenuItem = {
        kind: 'action',
        id: 'back',
        label: t('hub.menuBack'),
        icon: 'arrow-left',
        onSelect: openRootPage,
      };
      return [
        back,
        ...targets.map((target): HubMenuItem => ({
          kind: 'radio',
          id: `move-${target.id ?? 'none'}`,
          label: target.name,
          icon: target.id === null ? 'file' : 'folder',
          checked: session.folderId === target.id,
          onSelect: () => {
            if (session.folderId !== target.id) onMoveSession(session, target.id);
          },
        })),
      ];
    }
    const items: HubMenuItem[] = [];
    items.push({
      kind: 'action',
      id: 'open',
      label: t('hub.inspectorOpen'),
      icon: 'file',
      onSelect: () => onOpenSession(session),
    });
    if (onRenameSession) {
      items.push({
        kind: 'action',
        id: 'rename',
        label: t('hub.menuRename'),
        icon: 'pencil',
        shortcut: 'F2',
        onSelect: () => setRenaming(menuRow.key),
      });
    }
    if (onMoveSession) {
      items.push({
        kind: 'action',
        id: 'move',
        label: `${t('hub.menuMove')} \u25B8`,
        icon: 'folder',
        onSelect: openMovePage,
      });
    }
    if (onPeekSession) {
      items.push({
        kind: 'action',
        id: 'info',
        label: t('hub.sessionInfo'),
        icon: 'info',
        shortcut: 'Space',
        onSelect: () => onPeekSession(session),
      });
    }
    if (onDeleteSession) {
      items.push({
        kind: 'action',
        id: 'delete',
        label: t('common.delete'),
        icon: 'trash',
        shortcut: 'Del',
        danger: true,
        onSelect: () => deleteSession(session),
      });
    }
    return items;
  }, [
    menu,
    menuRow,
    moveFolders,
    onOpenSession,
    onRenameFolder,
    onNewSession,
    onDeleteFolder,
    onRenameSession,
    onPeekSession,
    onDeleteSession,
    onMoveSession,
    openMovePage,
    openRootPage,
    confirmDeleteFolder,
    deleteSession,
    t,
  ]);

  // The drill-down's keyboard: ArrowRight on `이동` opens the page, ArrowLeft
  // or Esc on the page returns. Capture runs before the menu's own Esc close.
  const onMenuKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menu || menuRow?.kind !== 'session') return;
    if (menu.page === 'root' && event.key === 'ArrowRight') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.dataset.testid === 'hub-row-menu-move') {
        event.preventDefault();
        event.stopPropagation();
        openMovePage();
      }
      return;
    }
    if (menu.page === 'move' && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
      event.preventDefault();
      event.stopPropagation();
      openRootPage();
    }
  };

  const sortItems = useMemo<HubMenuItem[]>(
    () => [
      {
        kind: 'radio',
        id: 'recent',
        label: t('hub.sortRecent'),
        checked: sort === 'recent',
        onSelect: () => setSort('recent'),
      },
      {
        kind: 'radio',
        id: 'name',
        label: t('hub.sortName'),
        checked: sort === 'name',
        onSelect: () => setSort('name'),
      },
    ],
    [sort, t],
  );

  const flyoutFolder = flyout
    ? (visible.find((entry) => entry.folder.id === flyout.folderId)?.folder ?? null)
    : null;

  const flyoutItems = useMemo<HubMenuItem[]>(() => {
    const items: HubMenuItem[] = [];
    if (!flyoutFolder) return items;
    if (onNewSession) {
      items.push({
        kind: 'action',
        id: 'new-session',
        label: t('hub.newSession'),
        icon: 'plus',
        onSelect: () => onNewSession(flyoutFolder),
      });
    }
    return items;
  }, [flyoutFolder, currentSessionId, onOpenSession, onNewSession, t]);

  const renameField = (rowKey: string, current: string, commit: (next: string) => void) => (
    <input
      className="hub-row__rename"
      defaultValue={current}
      data-testid={`hub-rename-${rowKey.replace(':', '-')}`}
      aria-label={t('hub.menuRename')}
      autoFocus
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The tree owns every bare key, so the editor has to keep its own.
        event.stopPropagation();
        if (event.key === 'Enter') {
          const next = event.currentTarget.value.trim();
          setRenaming(null);
          rowRefs.current.get(rowKey)?.focus();
          if (next && next !== current) commit(next);
        }
        if (event.key === 'Escape') {
          setRenaming(null);
          rowRefs.current.get(rowKey)?.focus();
        }
      }}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        setRenaming(null);
        if (next && next !== current) commit(next);
      }}
    />
  );

  /* ---- drag and drop (native HTML5) ---- */

  const onSessionDragStart = (event: ReactDragEvent<HTMLDivElement>, session: HubSessionNode) => {
    event.stopPropagation();
    event.dataTransfer.setData(HUB_SESSION_DRAG_TYPE, session.id);
    event.dataTransfer.setData('text/plain', session.id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(session.id);
  };

  const onSessionDragEnd = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const dropHandlers = (targetKey: string, folderId: string | null) => {
    if (!onMoveSession) return {};
    return {
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        if (!hasSessionDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget((prev) => (prev === targetKey ? prev : targetKey));
      },
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
        // Leaving for a child of the same target is not leaving the target.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setDropTarget((prev) => (prev === targetKey ? null : prev));
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        if (!hasSessionDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const id = event.dataTransfer.getData(HUB_SESSION_DRAG_TYPE);
        setDropTarget(null);
        setDraggingId(null);
        const session = [...tree.folders.flatMap((f) => f.sessions), ...tree.recents]
          .find((candidate) => candidate.id === id);
        if (!session || session.folderId === folderId) return;
        if (folderId !== null) setCollapsed((prev) => ({ ...prev, [folderId]: false }));
        onMoveSession(session, folderId);
      },
    };
  };

  /* ---- inline folder create ---- */

  const createField = (
    <div className="hub-row hub-row--folder hub-row--creating" data-testid="hub-folder-create-row">
      <Icon name="folder" size={15} />
      <input
        className="hub-row__rename"
        data-testid="hub-folder-create-input"
        aria-label={t('hub.newFolder')}
        placeholder={t('hub.newFolder')}
        autoFocus
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            const next = event.currentTarget.value.trim();
            setCreatingFolder(false);
            if (next) onCreateFolder?.(next);
          }
          if (event.key === 'Escape') setCreatingFolder(false);
        }}
        onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          setCreatingFolder(false);
          if (next) onCreateFolder?.(next);
        }}
      />
    </div>
  );

  const nothingKnown = railStatus === 'loading' || railStatus === 'unavailable';
  const treeEmpty = tree.folders.length === 0 && tree.recents.length === 0;
  const narrowed = filter !== 'all' || searching;

  const sessionRow = (session: HubSessionNode, folder: HubFolderNode | null) => {
    const sessionKey = `s:${session.id}`;
    const sessionIndex = indexOfKey(sessionKey);
    const labelKey = stateLabelKey(session.state);
    const sessionRenaming = renaming === sessionKey;
    return (
      <div
        key={session.id}
        ref={registerRow(sessionKey)}
        role="treeitem"
        aria-level={folder ? 2 : 1}
        aria-current={session.id === currentSessionId ? 'true' : undefined}
        aria-roledescription={onMoveSession ? t('hub.dragSession') : undefined}
        {...(labelKey ? { 'aria-describedby': `hub-state-${session.id}` } : {})}
        tabIndex={cursor === sessionIndex ? 0 : -1}
        data-testid={`hub-session-${session.id}`}
        data-row-key={sessionKey}
        data-session-id={session.id}
        data-folder={folder ? folder.id : 'none'}
        data-state={session.state}
        data-dragging={draggingId === session.id ? 'true' : undefined}
        data-tooltip={session.title}
        draggable={Boolean(onMoveSession) && !sessionRenaming}
        className={`hub-row hub-row--session readable-tooltip${
          session.id === currentSessionId ? ' is-current' : ''
        }${menu?.rowKey === sessionKey ? ' is-menu-open' : ''}`}
        onFocus={() => syncCursorToFocus(sessionKey)}
        onClick={(event) => {
          // Nested inside the folder treeitem, so opening a session must not
          // also toggle its folder.
          event.stopPropagation();
          setCursor(sessionIndex);
          onOpenSession(session);
        }}
        onKeyDown={(event) => onKeyDown(event, sessionIndex)}
        onContextMenu={(event) => openContextMenu(event, sessionKey, sessionIndex)}
        onDragStart={onMoveSession ? (event) => onSessionDragStart(event, session) : undefined}
        onDragEnd={onMoveSession ? onSessionDragEnd : undefined}
      >
        {sessionRenaming && onRenameSession ? (
          renameField(sessionKey, session.title, (next) => onRenameSession(session, next))
        ) : (
          <span className="hub-row__title">{session.title}</span>
        )}
        {labelKey ? (
          <span
            id={`hub-state-${session.id}`}
            className={`hub-row__state hub-row__state--${session.state}`}
          >
            {t(labelKey)}
          </span>
        ) : (
          // A settled session carries its last activity instead of a state
          // word.
          <span className="hub-row__meta" data-testid={`hub-when-${session.id}`}>
            {relativeTimeShort(session.updatedAt, t)}
          </span>
        )}
        <span className="hub-row__actions">
          {onPeekSession ? (
            <button
              type="button"
              tabIndex={-1}
              className="hub-row__action"
              data-testid={`hub-peek-${session.id}`}
              aria-label={t('hub.peekSession', { name: session.title })}
              onClick={(event) => {
                event.stopPropagation();
                setCursor(sessionIndex);
                onPeekSession(session);
              }}
            >
              <Icon name="info" size={14} />
            </button>
          ) : null}
          {onRenameSession || onDeleteSession || onMoveSession ? (
            <button
              type="button"
              tabIndex={-1}
              className="hub-row__action"
              data-testid={`hub-menu-session-${session.id}`}
              aria-haspopup="menu"
              aria-expanded={menu?.rowKey === sessionKey}
              aria-label={t('hub.rowMenu', { name: session.title })}
              onClick={(event) => {
                event.stopPropagation();
                const anchor = event.currentTarget as HTMLElement;
                setCursor(sessionIndex);
                setMenu((prev) =>
                  prev?.rowKey === sessionKey ? null : { rowKey: sessionKey, anchor, page: 'root' },
                );
              }}
            >
              <Icon name="more-horizontal" size={14} />
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  const moreRow = (key: string, hiddenCount: number, row: FlatRow, testId: string) => (
    <div
      ref={registerRow(key)}
      role="treeitem"
      aria-level={row.folder ? 2 : 1}
      tabIndex={cursor === indexOfKey(key) ? 0 : -1}
      data-testid={testId}
      data-row-key={key}
      className="hub-row hub-row--more"
      onFocus={() => syncCursorToFocus(key)}
      onClick={(event) => {
        event.stopPropagation();
        revealOverflow(row);
      }}
      onKeyDown={(event) => onKeyDown(event, indexOfKey(key))}
    >
      <Icon name="chevron-right" size={12} strokeWidth={1.8} />
      <span>{t('hub.showMoreSessions', { count: String(hiddenCount) })}</span>
    </div>
  );

  return (
    <div className="hub-tree">
      {openWork}
      <div className="hub-tree__filters" role="group" aria-label={t('hub.filterLabel')}>
        <button
          type="button"
          className="hub-tree__filter"
          data-testid="hub-filter-all"
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          {t('hub.filterAll')}
        </button>
        <button
          type="button"
          className="hub-tree__filter"
          data-testid="hub-filter-attention"
          aria-pressed={filter === 'attention'}
          onClick={() => setFilter('attention')}
        >
          {t('hub.filterAttention')}
          <span className="hub-tree__count">{counts.attention}</span>
        </button>
        <button
          type="button"
          className="hub-tree__filter"
          data-testid="hub-filter-running"
          aria-pressed={filter === 'running'}
          onClick={() => setFilter('running')}
        >
          {t('hub.filterRunning')}
          <span className="hub-tree__count">{counts.running}</span>
        </button>
        {/* One sort control, not one button per order: the orders are mutually
            exclusive and the rail has no room for a pill each. */}
        <button
          type="button"
          className="hub-tree__sort"
          data-testid="hub-sort"
          aria-haspopup="menu"
          aria-expanded={sortAnchor !== null}
          aria-label={t('hub.sortLabel')}
          title={t('hub.sortLabel')}
          onClick={(event) => {
            // Read the button out of the event BEFORE the state updater runs.
            // React clears `currentTarget` once the handler returns, so a
            // deferred updater would anchor the menu to `null` and silently
            // swallow the click.
            const button = event.currentTarget as HTMLElement;
            setSortAnchor((prev) => (prev ? null : button));
          }}
        >
          <Icon name="sort" size={15} />
        </button>
      </div>

      {railStatus === 'unavailable' || railStatus === 'stale' ? (
        <p
          role="presentation"
          className={`hub-tree__note hub-tree__note--${railStatus}`}
          data-testid="hub-sessions-error"
          data-status={railStatus}
        >
          <span>
            {railStatus === 'unavailable' ? t('hub.sessionsUnavailable') : t('hub.sessionsStale')}
          </span>
          {onRetrySessions ? (
            <button
              type="button"
              className="hub-tree__link"
              data-testid="hub-sessions-retry"
              onClick={(event) => {
                event.stopPropagation();
                onRetrySessions();
              }}
            >
              {t('hub.retrySessions')}
            </button>
          ) : null}
        </p>
      ) : null}

      {treeEmpty && railStatus === 'loading' ? (
        <p role="presentation" className="hub-tree__note" data-testid="hub-sessions-loading">
          {t('common.loading')}
        </p>
      ) : null}

      {treeEmpty && !searching && !creatingFolder ? (
        // Nothing exists yet, so no filter is hiding anything and a
        // "clear filter" link would promise rows that are not there. An
        // unknown list (not loaded yet) says nothing rather than lying.
        nothingKnown ? null : (
          <p className="hub-tree__empty" data-testid="hub-tree-no-projects">
            {t('hub.noProjectsTitle')}
          </p>
        )
      ) : rows.length === 0 && !creatingFolder ? (
        <p className="hub-tree__empty" data-testid="hub-tree-empty">
          {t('hub.emptyFiltered')}{' '}
          <button type="button" className="hub-tree__link" onClick={() => { setFilter('all'); onClearFilter?.(); }}>
            {t('hub.clearFilter')}
          </button>
        </p>
      ) : narrowed ? (
        <p className="hub-tree__group-label" data-testid="hub-group-label">
          {t('hub.results')}{' '}
          <span className="hub-tree__group-count" data-testid="hub-group-count">
            {resultCount}
          </span>
        </p>
      ) : null}

      <div className="hub-tree__body" role="tree" aria-label={t('hub.treeLabel')}>
        {/* ---- 프로젝트 ---- */}
        <div
          className="hub-tree__section hub-tree__section--projects"
          data-testid="hub-section-projects"
          hidden={treeEmpty && !creatingFolder && nothingKnown}
        >
          <div className="hub-tree__section-head" role="presentation">
            <span className="hub-tree__section-label" data-testid="hub-section-projects-label">
              {t('hub.projects')}
            </span>
            {onCreateFolder ? (
              <button
                type="button"
                className="hub-row__action hub-tree__section-action"
                data-testid="hub-folder-create"
                aria-label={t('hub.newFolder')}
                onClick={(event) => {
                  event.stopPropagation();
                  setCreatingFolder(true);
                }}
              >
                <Icon name="plus" size={14} />
              </button>
            ) : null}
          </div>
          {creatingFolder && !railCollapsed ? createField : null}
          {visible.map((entry) => {
            const folderKey = `p:${entry.folder.id}`;
            const folderIndex = indexOfKey(folderKey);
            const rollup = rollupFolderState(entry.folder);
            const rollupKey = stateLabelKey(rollup);
            const folderRenaming = renaming === folderKey;
            const hasCurrent =
              currentSessionId !== null &&
              entry.folder.sessions.some((session) => session.id === currentSessionId);
            const isSelected = selectedFolderId === entry.folder.id;
            return (
              <div key={entry.folder.id} className="hub-tree__node">
                <div
                  ref={registerRow(folderKey)}
                  role="treeitem"
                  // A collapsed folder has no rendered group to expand, and
                  // claiming otherwise would promise screen readers a subtree
                  // that is not there.
                  {...(railCollapsed
                    ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': flyout?.folderId === entry.folder.id }
                    : { 'aria-expanded': entry.open })}
                  {...(railCollapsed ? { 'aria-label': entry.folder.name } : {})}
                  aria-selected={isSelected}
                  data-tooltip={entry.folder.name}
                  data-initial={initialGlyph(entry.folder.name)}
                  data-current={hasCurrent ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : undefined}
                  data-drop={dropTarget === folderKey ? 'active' : undefined}
                  onMouseEnter={
                    railCollapsed
                      ? (event) => {
                          const anchor = event.currentTarget;
                          cancelHoverFlyout();
                          hoverTimerRef.current = setTimeout(() => {
                            hoverTimerRef.current = null;
                            setFlyout({ folderId: entry.folder.id, anchor });
                          }, FLYOUT_HOVER_DELAY_MS);
                        }
                      : undefined
                  }
                  onMouseLeave={railCollapsed ? cancelHoverFlyout : undefined}
                  aria-level={1}
                  {...(!entry.open && rollupKey
                    ? { 'aria-describedby': `hub-state-${entry.folder.id}` }
                    : {})}
                  tabIndex={cursor === folderIndex ? 0 : -1}
                  data-testid={`hub-project-${entry.folder.id}`}
                  data-row-key={folderKey}
                  data-project-id={entry.folder.id}
                  data-state={rollup}
                  className={`hub-row hub-row--project hub-row--folder readable-tooltip${
                    menu?.rowKey === folderKey ? ' is-menu-open' : ''
                  }${isSelected ? ' is-selected' : ''}`}
                  onFocus={() => syncCursorToFocus(folderKey)}
                  onClick={() => {
                    setCursor(folderIndex);
                    const row = rows[folderIndex];
                    if (row) activate(row);
                  }}
                  onKeyDown={(event) => onKeyDown(event, folderIndex)}
                  onContextMenu={(event) => openContextMenu(event, folderKey, folderIndex)}
                  {...dropHandlers(folderKey, entry.folder.id)}
                >
                  <span className="hub-row__chevron" aria-hidden="true" data-open={entry.open} />
                  <span className="hub-row__icon" aria-hidden="true">
                    <Icon name="folder" size={15} />
                  </span>
                  {folderRenaming && onRenameFolder ? (
                    renameField(folderKey, entry.folder.name, (next) =>
                      onRenameFolder(entry.folder, next),
                    )
                  ) : (
                    <span className="hub-row__title">{entry.folder.name}</span>
                  )}
                  {entry.open || !rollupKey ? null : (
                    <span
                      id={`hub-state-${entry.folder.id}`}
                      className={`hub-row__state hub-row__state--${rollup}`}
                    >
                      {t(rollupKey)}
                    </span>
                  )}
                  <span className="hub-row__actions">
                    {onNewSession ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        className="hub-row__action"
                        data-testid={`hub-new-session-${entry.folder.id}`}
                        aria-label={t('hub.newSessionIn', { name: entry.folder.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          onNewSession(entry.folder);
                        }}
                      >
                        <Icon name="plus" size={14} />
                      </button>
                    ) : null}
                    {onRenameFolder || onDeleteFolder ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        className="hub-row__action"
                        data-testid={`hub-menu-folder-${entry.folder.id}`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.rowKey === folderKey}
                        aria-label={t('hub.rowMenu', { name: entry.folder.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          const anchor = event.currentTarget as HTMLElement;
                          setCursor(folderIndex);
                          setMenu((prev) =>
                            prev?.rowKey === folderKey ? null : { rowKey: folderKey, anchor, page: 'root' },
                          );
                        }}
                      >
                        <Icon name="more-horizontal" size={14} />
                      </button>
                    ) : null}
                  </span>

                  {/* The group is a DESCENDANT of the folder treeitem, not a
                      sibling: ARIA ownership is what lets assistive tech say
                      which folder owns which sessions. */}
                  <div
                    role="group"
                    aria-label={entry.folder.name}
                    className="hub-tree__group"
                    data-open={entry.open && !railCollapsed}
                    hidden={!entry.open || railCollapsed}
                  >
                    {!railCollapsed ? entry.sessions.map((session) => sessionRow(session, entry.folder)) : null}
                    {entry.hiddenCount > 0
                      ? moreRow(
                          `m:${entry.folder.id}`,
                          entry.hiddenCount,
                          { key: `m:${entry.folder.id}`, kind: 'more', folder: entry.folder },
                          `hub-tree-more-${entry.folder.id}`,
                        )
                      : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- 최근 ---- */}
        {railCollapsed ? (
          <button
            type="button"
            className="hub-row hub-row--project readable-tooltip"
            data-testid="hub-recents-flyout-trigger"
            aria-label={t('hub.recents')}
            data-tooltip={t('hub.recents')}
            aria-haspopup="dialog"
            aria-expanded={flyout?.folderId === RECENTS_KEY}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setFlyout((prev) => prev?.folderId === RECENTS_KEY ? null : { folderId: RECENTS_KEY, anchor });
            }}
            {...dropHandlers(RECENTS_KEY, null)}
          >
            <Icon name="file" size={15} />
          </button>
        ) : null}
        {railCollapsed || (treeEmpty && nothingKnown) ? null : (
          <div
            className="hub-tree__section hub-tree__section--recents"
            data-testid="hub-section-recents"
            data-drop={dropTarget === RECENTS_KEY ? 'active' : undefined}
            {...dropHandlers(RECENTS_KEY, null)}
          >
            <div className="hub-tree__section-head" role="presentation">
              <span className="hub-tree__section-label" data-testid="hub-section-recents-label">
                {t('hub.recents')}
              </span>
            </div>
            {recents.sessions.length === 0 && !narrowed ? (
              <p role="presentation" className="hub-tree__note" data-testid="hub-no-recents">
                {t('hub.noRecents')}
              </p>
            ) : null}
            {recents.sessions.map((session) => sessionRow(session, null))}
            {recents.hiddenCount > 0
              ? moreRow(
                  RECENTS_MORE_KEY,
                  recents.hiddenCount,
                  { key: RECENTS_MORE_KEY, kind: 'more', folder: null },
                  'hub-tree-more-recents',
                )
              : null}
          </div>
        )}
      </div>

      {menu && menuRow && menuItems.length > 0 ? (
        <div onKeyDownCapture={onMenuKeyDownCapture}>
          <HubMenu
            key={menu.page}
            title={
              menu.page === 'move'
                ? t('hub.menuMove')
                : menuRow.kind === 'folder'
                  ? (menuRow.folder?.name ?? '')
                  : (menuRow.session?.title ?? '')
            }
            items={menuItems}
            anchor={menu.anchor}
            point={menu.point ?? null}
            returnFocusTo={rowRefs.current.get(menu.rowKey) ?? menu.anchor}
            testId="hub-row-menu"
            onClose={() => setMenu(null)}
          />
        </div>
      ) : null}

      {confirming ? createPortal(
        <div
          className="hub-delete-backdrop"
          data-testid="hub-delete-confirm-backdrop"
          onClick={(event) => {
            // The body portal still bubbles through the rail's React owners.
            event.stopPropagation();
            setConfirming(null);
          }}
        >
          <div
            ref={confirmRef}
            className="modal modal-confirm hub-delete-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${confirmId}-title`}
            aria-describedby={`${confirmId}-message`}
            data-testid="hub-delete-confirm"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={`${confirmId}-title`}>{confirming.title}</h2>
            <p id={`${confirmId}-message`} className="modal-confirm-message">{confirming.message}</p>
            <div className="row hub-delete-confirm__actions">
              {confirming.actions.map((action, index) => (
                <Button
                  key={action.testId}
                  ref={index === 0 ? defaultActionRef : undefined}
                  variant={action.danger ? 'primary' : undefined}
                  className={action.danger ? 'danger' : undefined}
                  data-testid={action.testId}
                  onClick={() => {
                    setConfirming(null);
                    action.run();
                  }}
                >
                  {action.label}
                </Button>
              ))}
              <Button
                data-testid="hub-delete-cancel"
                onClick={() => setConfirming(null)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {flyout && (flyoutFolder || flyout.folderId === RECENTS_KEY) ? (
        <HubMenu
          title={flyoutFolder?.name ?? t('hub.recents')}
          items={flyoutItems}
          anchor={flyout.anchor}
          returnFocusTo={flyout.anchor}
          testId="hub-project-flyout"
          onClose={() => { setMenu(null); setFlyout(null); }}
        >
          <div role="tree" aria-label={flyoutFolder?.name ?? t('hub.recents')}>
            {[...(flyoutFolder?.sessions ?? tree.recents)].sort(byRecency).map((session) => sessionRow(session, flyoutFolder))}
          </div>
        </HubMenu>
      ) : null}

      {sortAnchor ? (
        <HubMenu
          title={t('hub.sortLabel')}
          items={sortItems}
          anchor={sortAnchor}
          testId="hub-sort-menu"
          onClose={() => setSortAnchor(null)}
        />
      ) : null}
    </div>
  );
}
