// The hub rail's controller: every piece of state the left rail owns, with no
// JSX attached.
//
// This is the boundary between "who owns the rail's state" and "who renders
// it". Today HubHome calls this hook and mounts `HubRail` itself; the intent is
// for the shell (AppInner) to own ONE instance outside the keyed surface later,
// with HubHome reading it through `useHubRail()` instead of creating a second.
// Nothing in here assumes it lives inside the hub's DOM: the daemon reads, the
// open-work / rail-width persistence, the keyboard bindings and the undo
// window are all keyed off `window`, not off a component ancestor.

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

import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT } from '../../providers/daemon';
import {
  createConversation,
  deleteConversation,
  patchConversation,
  readConversations,
} from '../../state/projects';
import type { Project } from '../../types';
import type { HubPaletteEntry } from './HubCommandPalette';
import type { HubOpenWorkItem } from './HubOpenWork';
import {
  projectStateFromStatus,
  sessionStateFromRunStatus,
  type HubProjectNode,
  type HubSessionNode,
  type HubSessionsStatus,
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
// The daemon serves conversation reads synchronously and Chromium limits
// parallel HTTP/1 requests per origin. Launching one fetch per project lets a
// large idle workspace fill both queues before the project with live work is
// serviced. Keep the client wave bounded to the transport's useful parallelism.
const SESSION_READ_CONCURRENCY = 6;

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

/**
 * What the hub knows about ONE project's sessions.
 *
 * `sessions` is a cache: a failed read keeps the last good rows and marks them
 * stale rather than blanking the project, and a failure with no cache says so
 * instead of claiming the project has no sessions.
 */
interface ProjectSessionsEntry {
  status: HubSessionsStatus;
  sessions: HubSessionNode[];
}

export type HubPendingSessionDeletion = {
  readonly session: HubSessionNode;
  readonly wasOpen: boolean;
  readonly wasPeeked: boolean;
};

/** A session together with the project row it belongs to. */
export interface HubRailSessionEntry {
  readonly project: HubProjectNode;
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

const EMPTY_SESSIONS: HubSessionNode[] = [];

/** Everything the controller needs from whoever owns it. */
export interface HubRailControllerInputs {
  projects: Project[];
  currentSessionId: string | null;
  /** Open an existing session directly in the workspace. */
  onOpenSession: (projectId: string, conversationId: string) => void;
  onNewProject: () => void;
  /** Open a project itself, including projects with no sessions. */
  onOpenProject?: ((projectId: string) => void) | undefined;
  /** Persisted rename/delete for a project row; the hub never invents these. */
  onRenameProject?: ((projectId: string, name: string) => void) | undefined;
  onDeleteProject?: ((projectId: string) => Promise<boolean | void> | boolean | void) | undefined;
  onNavigateDestination?: ((destination: HubNavigateDestination) => void) | undefined;
  /**
   * Hold the per-project session reads. While `true` no read wave is issued
   * and in-flight reads are aborted so they release the browser's request
   * slots; cached rows stay on screen and unread projects stay `loading`.
   * Flipping back to `false` fans out afresh, exactly as a remount would. The
   * owner uses this to keep the rail from competing with project hydration or
   * with a workspace that is loading its own conversation.
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
 * surface reads the parts it depends on (`running`, `commandChip`, the
 * inspector, the undo toast, the palette). Optional row actions are exposed
 * as `undefined` when the owner supplied no callback, so the tree keeps its
 * "no menu item without a handler" contract.
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

  readonly allNodes: HubProjectNode[];
  /** `allNodes` narrowed by the search query. */
  readonly tree: HubProjectNode[];
  readonly failedSessionReads: number;
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

  readonly creatingSessionFor: string | null;
  readonly newProject: () => void;
  readonly newSession: (project: HubProjectNode) => void;
  readonly retrySessions: (project: HubProjectNode) => void;
  readonly renameSession: (session: HubSessionNode, title: string) => void;
  readonly deleteSession: (session: HubSessionNode) => void;
  readonly openProject: ((project: HubProjectNode) => void) | undefined;
  readonly renameProject: ((project: HubProjectNode, name: string) => void) | undefined;
  readonly deleteProject: ((project: HubProjectNode) => void) | undefined;

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
  projects,
  currentSessionId,
  onOpenSession,
  onNewProject,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
  onNavigateDestination,
  pauseSessionReads = false,
  onCommandChip,
}: HubRailControllerInputs): HubRailController {
  const t = useT();
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, ProjectSessionsEntry>
  >({});
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState('');
  // One generation counter per project, so a retry (or a runs-changed refresh)
  // can discard a slower in-flight response for the SAME project without
  // touching any sibling's request.
  const generationsRef = useRef(new Map<string, number>());
  // Superseded reads must release the browser's per-origin request slots, not
  // merely have their eventual responses ignored. Only the bounded worker wave
  // below may add controllers, so this map also represents every active read.
  const sessionReadControllersRef = useRef(new Map<string, AbortController>());
  // Per-project in-flight guard for the new-session action: a double click
  // must not create two empty conversations.
  const creatingSessionRef = useRef(new Set<string>());
  const [creatingSessionFor, setCreatingSessionFor] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandChip, setCommandChip] = useState<HubCommandChip | null>(null);
  const commandChipNonceRef = useRef(0);
  const paletteReturnRef = useRef<HTMLElement | null>(null);
  const allNodesRef = useRef<HubProjectNode[]>([]);
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
  // Read through a ref so the fetch effect does not re-run when `t` changes
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
  // Sessions are per-project on the daemon; there is no cross-project
  // conversation endpoint. Load urgent project states first, then drain the
  // rest through a bounded pool. This preserves progressive rendering without
  // allowing hundreds of idle projects to starve the live-work strip.
  const prioritizedProjectIds = useMemo(() => {
    const priority = (project: Project): number => {
      const state = projectStateFromStatus(project.status?.value);
      if (state === 'running') return 0;
      if (state === 'awaiting') return 1;
      if (state === 'failed') return 2;
      return 3;
    };
    return projects
      .map((project, index) => ({ project, index }))
      .sort((left, right) => priority(left.project) - priority(right.project) || left.index - right.index)
      .map(({ project }) => project.id);
  }, [projects]);
  const projectLoadKey = prioritizedProjectIds.join('\u0000');

  const loadProject = useCallback(async (projectId: string): Promise<void> => {
    const generation = (generationsRef.current.get(projectId) ?? 0) + 1;
    generationsRef.current.set(projectId, generation);
    sessionReadControllersRef.current.get(projectId)?.abort();
    const controller = new AbortController();
    sessionReadControllersRef.current.set(projectId, controller);
    const result = await readConversations(projectId, { signal: controller.signal });
    // A response from a superseded request for this project is dropped
    // outright, so a slow first read can never overwrite a newer retry.
    if (generationsRef.current.get(projectId) !== generation) return;
    if (sessionReadControllersRef.current.get(projectId) === controller) {
      sessionReadControllersRef.current.delete(projectId);
    }
    setSessionsByProject((prev) => {
      const cached = prev[projectId];
      if (result.ok) {
        return {
          ...prev,
          [projectId]: {
            status: 'ready',
            sessions: result.conversations.map((conversation) => ({
              id: conversation.id,
              projectId,
              title: conversation.title ?? untitledLabel.current,
              updatedAt: conversation.updatedAt,
              state: sessionStateFromRunStatus(conversation.latestRun?.status),
              ...(conversation.messageCount === undefined
                ? {}
                : { messageCount: conversation.messageCount }),
              ...(conversation.sessionMode === undefined
                ? {}
                : { sessionMode: conversation.sessionMode }),
            })),
          },
        };
      }
      // A failed read keeps this project's last known rows and marks them
      // stale; with nothing cached it says the sessions are unavailable
      // rather than claiming there are none. Siblings are untouched.
      const keptSessions = cached?.sessions ?? EMPTY_SESSIONS;
      return {
        ...prev,
        [projectId]: {
          status: keptSessions.length > 0 ? 'stale' : 'unavailable',
          sessions: keptSessions,
        },
      };
    });
  }, []);

  useEffect(() => {
    const ids = projectLoadKey ? projectLoadKey.split('\u0000') : [];
    // Missing entries already derive as loading in allNodes. Preserve cache
    // identity unless a project was removed; materializing loading adds a commit.
    setSessionsByProject((prev) => {
      const currentIds = new Set(ids);
      if (Object.keys(prev).every((id) => currentIds.has(id))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([id]) => currentIds.has(id)));
    });
    if (ids.length === 0) {
      generationsRef.current.clear();
      return undefined;
    }
    // The owner is holding reads back. The previous run's cleanup has already
    // aborted anything in flight; this run issues nothing and the effect
    // re-runs to fan out when the hold lifts.
    if (pauseSessionReads) return undefined;

    let wave = 0;
    const load = () => {
      const currentWave = ++wave;
      for (const [id, controller] of sessionReadControllersRef.current) {
        generationsRef.current.set(id, (generationsRef.current.get(id) ?? 0) + 1);
        controller.abort();
      }
      sessionReadControllersRef.current.clear();

      let cursor = 0;
      const worker = async () => {
        while (currentWave === wave) {
          const id = ids[cursor];
          cursor += 1;
          if (!id) return;
          await loadProject(id);
        }
      };
      for (let index = 0; index < Math.min(SESSION_READ_CONCURRENCY, ids.length); index += 1) {
        void worker();
      }
    };

    load();
    window.addEventListener(RUNS_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(RUNS_CHANGED_EVENT, load);
      wave += 1;
      // Bump every generation so responses still in flight are ignored
      // instead of writing into an unmounted or re-keyed tree.
      for (const id of ids) {
        generationsRef.current.set(id, (generationsRef.current.get(id) ?? 0) + 1);
        sessionReadControllersRef.current.get(id)?.abort();
        sessionReadControllersRef.current.delete(id);
      }
    };
  }, [projectLoadKey, loadProject, pauseSessionReads]);

  const allNodes = useMemo<HubProjectNode[]>(
    () =>
      projects.map((project) => {
        const entry = sessionsByProject[project.id];
        return {
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          // A deleted session must leave the list immediately; a cached fetch
          // result would otherwise keep rendering a row that no longer exists.
          sessions: (entry?.sessions ?? EMPTY_SESSIONS).filter(
            (session) => !removedSessionIds.includes(session.id),
          ),
          sessionsStatus: entry?.status ?? 'loading',
          state: projectStateFromStatus(project.status?.value),
        };
      }),
    [projects, sessionsByProject, removedSessionIds],
  );

  // The failure is announced as a count in the live region, so it is never
  // carried by colour alone.
  const failedSessionReads = useMemo(
    () =>
      allNodes.filter(
        (project) =>
          project.sessionsStatus === 'stale' || project.sessionsStatus === 'unavailable',
      ).length,
    [allNodes],
  );

  // Search narrows the same rows the tree already renders instead of opening a
  // second result list. A project name match keeps all of its sessions.
  const tree = useMemo<HubProjectNode[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allNodes;
    return allNodes
      .map((project) => {
        if (project.name.toLowerCase().includes(needle)) return project;
        return {
          ...project,
          sessions: project.sessions.filter((s) => s.title.toLowerCase().includes(needle)),
        };
      })
      .filter(
        (project) => project.sessions.length > 0 || project.name.toLowerCase().includes(needle),
      );
  }, [allNodes, query]);

  useLayoutEffect(() => {
    allNodesRef.current = allNodes;
  }, [allNodes]);

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

  const createSession = useCallback(async (project: HubProjectNode) => {
    const conversation = await createConversation(project.id);
    if (!conversation) return;
    onOpenSession(project.id, conversation.id);
  }, [onOpenSession]);

  const issueCommandChip = useCallback((id: string) => {
    const chip: HubCommandChip = { id, nonce: ++commandChipNonceRef.current };
    setCommandChip(chip);
    onCommandChip?.(chip);
  }, [onCommandChip]);

  const consumeCommandChip = useCallback((nonce: number) => {
    setCommandChip((current) => (current?.nonce === nonce ? null : current));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const primary = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLocaleLowerCase();
      if (primary && !event.shiftKey && key === 'k') {
        event.preventDefault();
        openPalette();
      } else if (primary && event.shiftKey && key === 'n') {
        event.preventDefault();
        const focusedProjectId = document.activeElement instanceof HTMLElement
          ? document.activeElement.closest<HTMLElement>('[data-project-id]')?.dataset.projectId
          : undefined;
        const project = allNodesRef.current.find((candidate) => candidate.id === focusedProjectId)
          ?? allNodesRef.current[0];
        if (project) void createSession(project);
      } else if (primary && !event.shiftKey && key === 'n') {
        event.preventDefault();
        onNewProject();
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
  }, [closePalette, createSession, onNewProject, openPalette, paletteOpen]);

  const paletteEntries = useMemo<HubPaletteEntry[]>(() => {
    const projectEntries = allNodes.map((project) => ({
      id: `project-${project.id}`,
      group: t('hub.projects'),
      title: project.name,
      kind: 'project' as const,
      activate: () => onOpenProject?.(project.id),
    }));
    const sessionEntries = allNodes.flatMap((project) => project.sessions.map((session) => ({
      id: `session-${session.id}`,
      group: t('hub.treeLabel'),
      title: session.title,
      meta: project.name,
      kind: 'session' as const,
      activate: () => onOpenSession(project.id, session.id),
    })));
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
      ...projectEntries,
      ...sessionEntries,
      ...destinations.map(([destination, title]) => ({
        id: `destination-${destination}`,
        group: t('hub.paletteNavigate'),
        title,
        kind: 'destination' as const,
        activate: () => onNavigateDestination?.(destination),
      })),
    ];
  }, [allNodes, issueCommandChip, onNavigateDestination, onOpenProject, onOpenSession, t]);

  const running = useMemo(
    () =>
      allNodes
        .flatMap((project) => project.sessions.map((session) => ({ project, session })))
        .find((entry) => entry.session.state === 'running') ?? null,
    [allNodes],
  );
  const sessionIndex = useMemo(() => {
    const map = new Map<string, HubRailSessionEntry>();
    for (const project of allNodes) {
      for (const session of project.sessions) map.set(session.id, { project, session });
    }
    return map;
  }, [allNodes]);

  const openSession = useCallback(
    (session: HubSessionNode) => {
      setAnnouncement(t('hub.liveWorking', { project: '', session: session.title }));
      updateOpenWorkIds((prev) =>
        prev.includes(session.id) ? prev : [session.id, ...prev],
      );
      onOpenSession(session.projectId, session.id);
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
            projectId: entry.project.id,
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

  const renameSession = useCallback((session: HubSessionNode, title: string) => {
    setSessionsByProject((prev) => {
      const entry = prev[session.projectId] ?? { status: 'ready', sessions: EMPTY_SESSIONS };
      return {
        ...prev,
        [session.projectId]: {
          ...entry,
          sessions: entry.sessions.map((candidate) =>
            candidate.id === session.id ? { ...candidate, title } : candidate,
          ),
        },
      };
    });
    void patchConversation(session.projectId, session.id, { title });
  }, []);

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
    void deleteConversation(pending.session.projectId, pending.session.id).then((ok) => {
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
        void deleteConversation(pending.session.projectId, pending.session.id);
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

  const renameProject = useMemo(
    () =>
      onRenameProject
        ? (project: HubProjectNode, name: string) => {
            onRenameProject(project.id, name);
          }
        : undefined,
    [onRenameProject],
  );

  const deleteProject = useMemo(
    () =>
      onDeleteProject
        ? (project: HubProjectNode) => {
            updateOpenWorkIds((prev) =>
              prev.filter((id) => sessionIndex.get(id)?.project.id !== project.id),
            );
            setPeekedSessionId((prev) =>
              prev && sessionIndex.get(prev)?.project.id === project.id ? null : prev,
            );
            void onDeleteProject(project.id);
          }
        : undefined,
    [onDeleteProject, sessionIndex, updateOpenWorkIds],
  );
  const retrySessions = useCallback(
    (project: HubProjectNode) => {
      if (pauseSessionReads) return;
      setSessionsByProject((prev) => {
        const cached = prev[project.id];
        return {
          ...prev,
          [project.id]: {
            // Keep the cached rows on screen while the retry runs; only a
            // project with nothing to show falls back to the loading note.
            status: cached && cached.sessions.length > 0 ? cached.status : 'loading',
            sessions: cached?.sessions ?? EMPTY_SESSIONS,
          },
        };
      });
      void loadProject(project.id);
    },
    [loadProject, pauseSessionReads],
  );
  const openProject = useMemo(
    () =>
      onOpenProject
        ? (project: HubProjectNode) => {
            onOpenProject(project.id);
          }
        : undefined,
    [onOpenProject],
  );

  // The new-session action creates a real conversation and hands it to the
  // workspace through the same route the tree uses for existing sessions, so
  // the workspace-tab reuse contract is preserved. It never falls back to
  // "open the new-project form" and never navigates without a conversation.
  const newSession = useCallback(
    (project: HubProjectNode) => {
      if (creatingSessionRef.current.has(project.id)) return;
      // An already-empty session is what the user would get anyway, so reuse
      // it rather than accumulating empty conversations.
      const reusable = project.sessions.find((session) => session.messageCount === 0);
      if (reusable) {
        openSession(reusable);
        return;
      }
      creatingSessionRef.current.add(project.id);
      setCreatingSessionFor(project.id);
      void createConversation(project.id)
        .then((conversation) => {
          if (!conversation) return;
          setSessionsByProject((prev) => {
            const cached = prev[project.id];
            const created: HubSessionNode = {
              id: conversation.id,
              projectId: project.id,
              title: conversation.title ?? untitledLabel.current,
              updatedAt: conversation.updatedAt,
              state: sessionStateFromRunStatus(conversation.latestRun?.status),
              messageCount: conversation.messageCount ?? 0,
              ...(conversation.sessionMode === undefined
                ? {}
                : { sessionMode: conversation.sessionMode }),
            };
            return {
              ...prev,
              [project.id]: {
                status: 'ready',
                sessions: [created, ...(cached?.sessions ?? EMPTY_SESSIONS)],
              },
            };
          });
          onOpenSession(project.id, conversation.id);
        })
        .finally(() => {
          creatingSessionRef.current.delete(project.id);
          setCreatingSessionFor((current) => (current === project.id ? null : current));
        });
    },
    [openSession, onOpenSession],
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
    allNodes,
    tree,
    failedSessionReads,
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
    creatingSessionFor,
    newProject: onNewProject,
    newSession,
    retrySessions,
    renameSession,
    deleteSession,
    openProject,
    renameProject,
    deleteProject,
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
