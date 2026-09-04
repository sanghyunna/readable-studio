// Entry hub: the surface that replaced the welcome/hero screen.
//
// Left panel owns navigation (project -> session tree). The center is a calm
// start surface: a live-work strip when something is running, the composer,
// and the New Project modal launcher. Past work is never dumped into the center canvas.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';

import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT } from '../../providers/daemon';
import {
  createConversation,
  deleteConversation,
  patchConversation,
  readConversations,
} from '../../state/projects';
import type {
  DesignSystemSummary,
  Project,
  ProjectTemplate,
  SkillSummary,
} from '../../types';
import { HomeView } from '../HomeView';
import { Icon } from '../Icon';
import type { CreateInput, ImportClaudeDesignOutcome } from '../NewProjectPanel';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { Toast } from '../Toast';
import { HubCommandPalette, type HubPaletteEntry } from './HubCommandPalette';
import { HubInspector } from './HubInspector';
import { HubOpenWork, type HubOpenWorkItem } from './HubOpenWork';
import { HubRailFooter } from './HubRailFooter';
import { HubSessionTree } from './HubSessionTree';
import { relativeTimeShort } from './relativeTime';
import {
  projectStateFromStatus,
  sessionStateFromRunStatus,
  type HubDestination,
  type HubProjectNode,
  type HubSessionNode,
  type HubSessionsStatus,
} from './types';

const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];
const OPEN_WORK_STORAGE_KEY = 'readable-studio:hub-open-work';
/**
 * The rail's Ctrl/Cmd+I shortcut is owned by the hub's keyboard layer, which
 * dispatches this event rather than reaching into inspector state directly.
 */
const HUB_INSPECTOR_TOGGLE_EVENT = 'readable:hub-inspector-toggle';
// Collapsing the rail is a durable preference, not a per-tab one: a user who
// works in the narrow rail expects it still narrow tomorrow.
const RAIL_COLLAPSED_STORAGE_KEY = 'readable-studio:hub-rail-collapsed';
// The mockup's breakpoint. Below it the rail is ALWAYS the icon rail, so the
// stored preference is irrelevant until the window widens again.
const NARROW_RAIL_QUERY = '(max-width: 900px)';

function loadRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === 'true';
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

type PendingSessionDeletion = {
  readonly session: HubSessionNode;
  readonly wasOpen: boolean;
  readonly wasPeeked: boolean;
};

const EMPTY_SESSIONS: HubSessionNode[] = [];

interface Props {
  projects: Project[];
  /** Windows account running the local daemon, when available. */
  username?: string | null;
  projectsLoading?: boolean;
  /** Open an existing session directly in the workspace. */
  onOpenSession: (projectId: string, conversationId: string) => void;
  /** Rich creation payload; HomeView owns all composer submission state. */
  onSubmit?: (payload: PluginLoopSubmit) => Promise<boolean> | boolean | void;
  /** @deprecated compatibility for callers not yet migrated to the rich payload. */
  onSubmitPrompt?: (prompt: string, options?: { designSystemId: string | null }) => unknown;
  /** Open a project itself, including projects with no sessions. */
  onOpenProject?: (projectId: string) => void;
  onViewAllProjects?: () => void;
  onBrowseRegistry?: () => void;
  onOpenMcp?: () => void;
  onOpenNewProject?: (tab: 'template') => void;
  /**
   * Project creation as the entry shell already owns it. Threading the SAME
   * handler (never a second creation path) is what mounts the Advanced /
   * Import disclosure on the project panel: HomeView renders it only when a
   * host supplies a real creator, so without this prop the disclosure — the
   * working-folder picker, ZIP / folder imports and the template picker — is
   * unreachable on the hub.
   */
  onCreateProject?: (
    input: CreateInput & { requestId?: string },
  ) => Promise<boolean> | boolean | void;
  /** Template picker source for the disclosure; same list the modal renders. */
  templates?: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  onImportClaudeDesign?: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (
    response: ReadableStudioHostProjectImportSuccess,
  ) => Promise<void> | void;
  skills?: SkillSummary[];
  skillsLoading?: boolean;
  /** Navigate to one of the entry destinations (rail footer library menu). */
  onOpenDestination?: (destination: HubDestination) => void;
  /** Open settings (rail footer gear and workspace menu). */
  onOpenSettings?: () => void;
  /** Open the surface that owns the workspace storage roots. */
  onOpenWorkspaceFolder?: () => void;
  /** Name of the active workspace, rendered in the rail footer row. */
  workspaceName?: string | null;
  designSystems?: DesignSystemSummary[];
  defaultDesignSystemId?: string | null;
  onNewProject: () => void;
  /** Persisted rename/delete for a project row; the hub never invents these. */
  onRenameProject?: (projectId: string, name: string) => void;
  onDeleteProject?: (projectId: string) => Promise<boolean | void> | boolean | void;
  onNavigateDestination?: (destination: 'home' | 'projects' | 'tasks' | 'design-systems' | 'plugins' | 'integrations') => void;
  currentSessionId?: string | null;
  /** Brand click returns to the hub itself; entry chrome owns the target. */
  onGoHome?: () => void;
  /**
   * The agent + model control for the composer footer, mounted as an opaque
   * node. EntryShell owns the real InlineModelSwitcher (config, agents,
   * daemon state and every persistence callback); the hub only forwards the
   * SAME node down to HomeView, so the live callbacks stay real without
   * threading a dozen execution inputs through this component.
   */
  executionSwitcher?: ReactNode;
}

export function HubHome({
  projects,
  username = null,
  projectsLoading = false,
  onOpenSession,
  onSubmit,
  onSubmitPrompt,
  onOpenProject,
  onOpenDestination,
  onOpenSettings,
  onOpenWorkspaceFolder,
  workspaceName = null,
  onViewAllProjects,
  onBrowseRegistry,
  onOpenMcp,
  onOpenNewProject,
  onCreateProject,
  templates,
  onDeleteTemplate,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  skills,
  skillsLoading,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  onNavigateDestination,
  currentSessionId = null,
  onGoHome,
  designSystems = EMPTY_DESIGN_SYSTEMS,
  defaultDesignSystemId = null,
  executionSwitcher,
}: Props) {
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
  // Per-project in-flight guard for the new-session action: a double click
  // must not create two empty conversations.
  const creatingSessionRef = useRef(new Set<string>());
  const [creatingSessionFor, setCreatingSessionFor] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandChip, setCommandChip] = useState<{ readonly id: string; readonly nonce: number } | null>(null);
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
  const [narrow, setNarrow] = useState(() => narrowRailQuery()?.matches ?? false);
  const railCollapsed = railCollapsedPreference || narrow;
  const [peekedSessionId, setPeekedSessionId] = useState<string | null>(null);
  const [removedSessionIds, setRemovedSessionIds] = useState<string[]>([]);
  const [pendingSessionDeletion, setPendingSessionDeletion] = useState<PendingSessionDeletion | null>(null);
  const pendingSessionDeletionRef = useRef<PendingSessionDeletion | null>(null);
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

  const toggleRail = useCallback(() => {
    setRailCollapsedPreference((current) => {
      const next = !current;
      window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, String(next));
      setAnnouncement(t(next ? 'entry.navCollapse' : 'entry.navExpand'));
      return next;
    });
  }, [t]);

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
  // conversation endpoint. Fan out per project and commit each result as it
  // lands so one slow or failing project cannot hide every other project's
  // sessions, and refresh when runs change so states do not go stale.
  const projectIds = useMemo(() => projects.map((p) => p.id).join('\u0000'), [projects]);

  const loadProject = useCallback((projectId: string) => {
    const generation = (generationsRef.current.get(projectId) ?? 0) + 1;
    generationsRef.current.set(projectId, generation);
    void readConversations(projectId).then((result) => {
      // A response from a superseded request for this project is dropped
      // outright, so a slow first read can never overwrite a newer retry.
      if (generationsRef.current.get(projectId) !== generation) return;
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
    });
  }, []);

  useEffect(() => {
    const ids = projectIds ? projectIds.split('\u0000') : [];
    if (ids.length === 0) {
      generationsRef.current.clear();
      setSessionsByProject({});
      return undefined;
    }

    // Until the first response lands a project is LOADING, never "empty":
    // inferring emptiness from an unfinished read is exactly the bug that made
    // a dead daemon look like a user with no work.
    setSessionsByProject((prev) => {
      const next: Record<string, ProjectSessionsEntry> = {};
      for (const id of ids) {
        next[id] = prev[id] ?? { status: 'loading', sessions: EMPTY_SESSIONS };
      }
      return next;
    });

    const load = () => {
      for (const id of ids) loadProject(id);
    };

    load();
    window.addEventListener(RUNS_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(RUNS_CHANGED_EVENT, load);
      // Bump every generation so responses still in flight are ignored
      // instead of writing into an unmounted or re-keyed tree.
      for (const id of ids) {
        generationsRef.current.set(id, (generationsRef.current.get(id) ?? 0) + 1);
      }
    };
  }, [projectIds, loadProject]);

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
        window.dispatchEvent(new CustomEvent('readable:hub-inspector-toggle'));
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
        group: 'Create',
        title,
        kind: 'command' as const,
        activate: () => setCommandChip({ id: chipId, nonce: Date.now() }),
      })),
      ...projectEntries,
      ...sessionEntries,
      ...destinations.map(([destination, title]) => ({
        id: `destination-${destination}`,
        group: 'Navigate',
        title,
        kind: 'destination' as const,
        activate: () => onNavigateDestination?.(destination),
      })),
    ];
  }, [allNodes, onNavigateDestination, onOpenProject, onOpenSession, t]);

  const running = useMemo(
    () =>
      allNodes
        .flatMap((project) => project.sessions.map((session) => ({ project, session })))
        .find((entry) => entry.session.state === 'running') ?? null,
    [allNodes],
  );
  const sessionIndex = useMemo(() => {
    const map = new Map<string, { project: HubProjectNode; session: HubSessionNode }>();
    for (const project of allNodes) {
      for (const session of project.sessions) map.set(session.id, { project, session });
    }
    return map;
  }, [allNodes]);

  const handleOpenSession = useCallback(
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

  const peeked = peekedSessionId ? (sessionIndex.get(peekedSessionId) ?? null) : null;

  const handlePeekSession = useCallback((session: HubSessionNode) => {
    setPeekedSessionId(session.id);
  }, []);

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

  const handleRenameSession = useCallback((session: HubSessionNode, title: string) => {
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
    (pending: PendingSessionDeletion) => {
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

  const handleDeleteSession = useCallback(
    (session: HubSessionNode) => {
      commitPendingSessionDeletion();
      const pending = {
        session,
        wasOpen: openWorkIdsRef.current.includes(session.id),
        wasPeeked: peekedSessionId === session.id,
      } satisfies PendingSessionDeletion;
      setRemovedSessionIds((prev) => (prev.includes(session.id) ? prev : [...prev, session.id]));
      updateOpenWorkIds((prev) => prev.filter((id) => id !== session.id));
      setPeekedSessionId((prev) => (prev === session.id ? null : prev));
      pendingSessionDeletionRef.current = pending;
      setPendingSessionDeletion(pending);
      setAnnouncement(t('hub.sessionDeleted', { name: session.title }));
    },
    [commitPendingSessionDeletion, peekedSessionId, t, updateOpenWorkIds],
  );

  const handleRenameProjectRow = useCallback(
    (project: HubProjectNode, name: string) => {
      onRenameProject?.(project.id, name);
    },
    [onRenameProject],
  );

  const handleDeleteProjectRow = useCallback(
    (project: HubProjectNode) => {
      updateOpenWorkIds((prev) =>
        prev.filter((id) => sessionIndex.get(id)?.project.id !== project.id),
      );
      setPeekedSessionId((prev) =>
        prev && sessionIndex.get(prev)?.project.id === project.id ? null : prev,
      );
      void onDeleteProject?.(project.id);
    },
    [onDeleteProject, sessionIndex, updateOpenWorkIds],
  );
  const handleRetrySessions = useCallback(
    (project: HubProjectNode) => {
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
      loadProject(project.id);
    },
    [loadProject],
  );
  const handleOpenProject = useCallback(
    (project: HubProjectNode) => {
      onOpenProject?.(project.id);
    },
    [onOpenProject],
  );

  // The new-session action creates a real conversation and hands it to the
  // workspace through the same route the tree uses for existing sessions, so
  // the workspace-tab reuse contract is preserved. It never falls back to
  // "open the new-project form" and never navigates without a conversation.
  const handleNewSession = useCallback(
    (project: HubProjectNode) => {
      if (creatingSessionRef.current.has(project.id)) return;
      // An already-empty session is what the user would get anyway, so reuse
      // it rather than accumulating empty conversations.
      const reusable = project.sessions.find((session) => session.messageCount === 0);
      if (reusable) {
        handleOpenSession(reusable);
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
    [handleOpenSession, onOpenSession],
  );

  return (
    <div
      className={`hub${peeked ? ' hub--inspecting' : ''}${
        railCollapsed ? ' hub--rail-collapsed' : ''
      }`}
      data-rail-collapsed={railCollapsed ? 'true' : 'false'}
    >
      <div className="hub__wash" aria-hidden="true" />
      <div className="sr-only" role="status" aria-live="polite" data-testid="hub-live-region">
        {announcement}
      </div>
      {/* The aggregate read failure is text, not a colour: assistive tech and
          a sighted user get the same fact. */}
      <div
        className="hub__status"
        role="status"
        aria-live="polite"
        data-testid="hub-sessions-status"
        hidden={failedSessionReads === 0}
      >
        {failedSessionReads > 0
          ? t('hub.sessionsFailed', { count: String(failedSessionReads) })
          : ''}
      </div>

      <button
        type="button"
        className="hub__rail-toggle readable-tooltip"
        data-testid="hub-rail-toggle"
        aria-pressed={railCollapsed}
        aria-label={t(railCollapsed ? 'entry.navExpand' : 'entry.navCollapse')}
        title={t(railCollapsed ? 'entry.navExpand' : 'entry.navCollapse')}
        data-tooltip={t(railCollapsed ? 'entry.navExpand' : 'entry.navCollapse')}
        data-tooltip-placement="bottom"
        disabled={narrow}
        onClick={toggleRail}
      >
        <Icon name="panel-left" size={18} strokeWidth={1.8} />
      </button>

      <nav className="hub__nav" aria-label={t('hub.treeLabel')} data-testid="hub-nav">
        <div className="hub__nav-head">
          <button
            type="button"
            className="hub__brand"
            data-testid="hub-brand"
            aria-label={t('entry.navHome')}
            onClick={() => onGoHome?.()}
          >
            <img
              className="hub__brand-mark"
              src="/logo.svg"
              alt=""
              width={22}
              height={22}
              draggable={false}
              aria-hidden="true"
            />
            <span className="hub__brand-name">{t('app.brand')}</span>
            <span className="hub__brand-home">{t('entry.navHome')}</span>
          </button>
        </div>
        <div className="hub__nav-actions">
          <button
            type="button"
            className="hub__new-project"
            data-testid="hub-new-project"
            onClick={onNewProject}
          >
            {t('entry.navNewProject')}
          </button>
          <div className="hub__search-wrap">
            <input
              type="search"
              className="hub__search"
              data-testid="hub-search"
              value={query}
              aria-label={t('hub.searchPlaceholder')}
              placeholder={t('hub.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="hub__search-shortcut" data-testid="hub-open-palette" aria-label="Open command palette" onClick={openPalette}>
              <kbd className="hub-kbd">Ctrl K</kbd>
            </button>
          </div>
        </div>
        {projectsLoading ? (
          <p className="hub__nav-loading">{t('common.loading')}</p>
        ) : (
          <div className="hub__nav-list">
            <HubSessionTree
              key={query.trim() ? 'filtered' : 'all'}
              projects={tree}
              compactByDefault
              openWork={
                <HubOpenWork
                  items={openWork}
                  currentSessionId={currentSessionId}
                  onOpen={(item) => {
                    const entry = sessionIndex.get(item.sessionId);
                    if (entry) handleOpenSession(entry.session);
                  }}
                  onClose={(item) => {
                    updateOpenWorkIds((prev) => prev.filter((id) => id !== item.sessionId));
                    setAnnouncement(t('hub.closedOpenWork', { name: item.title }));
                  }}
                />
              }
              collapsed={railCollapsed}
              currentSessionId={currentSessionId}
              onOpenSession={handleOpenSession}
              onPeekSession={handlePeekSession}
              onNewSession={handleNewSession}
              onRetrySessions={handleRetrySessions}
              pendingNewSessionProjectId={creatingSessionFor}
              {...(onOpenProject ? { onOpenProject: handleOpenProject } : {})}
              onRenameSession={handleRenameSession}
              onDeleteSession={handleDeleteSession}
              {...(onRenameProject ? { onRenameProject: handleRenameProjectRow } : {})}
              {...(onDeleteProject ? { onDeleteProject: handleDeleteProjectRow } : {})}
            />
          </div>
        )}
        {onOpenDestination && onOpenSettings && onOpenWorkspaceFolder ? (
          <HubRailFooter
            username={username}
            onOpenDestination={onOpenDestination}
            onOpenSettings={onOpenSettings}
            onOpenWorkspaceFolder={onOpenWorkspaceFolder}
            workspaceName={workspaceName}
          />
        ) : null}
      </nav>

      <div className="hub__stage">
        <div className="hub__start">
          {running ? (
            <button
              type="button"
              className="hub__live"
              data-testid="hub-live-strip"
              onClick={() => handleOpenSession(running.session)}
            >
              <span className="hub__live-state">{t('hub.liveRunning')}</span>
              <span className="hub__live-text">
                {t('hub.liveWorking', {
                  project: running.project.name,
                  session: running.session.title,
                })}
              </span>
              <span className="hub__live-time" data-testid="hub-live-time">
                {relativeTimeShort(running.session.updatedAt, t)}
              </span>
              <Icon name="arrow-up" size={15} className="hub__live-arrow" />
            </button>
          ) : null}

          <HomeView
            surface="hub"
            richDataEnabled={Boolean(onSubmit)}
            projects={projects}
            projectsLoading={projectsLoading}
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            onSubmit={onSubmit ?? ((payload) => {
              onSubmitPrompt?.(payload.prompt, { designSystemId: payload.designSystemId ?? null });
            })}
            onOpenProject={onOpenProject ?? (() => undefined)}
            onViewAllProjects={onViewAllProjects ?? (() => undefined)}
            onBrowseRegistry={onBrowseRegistry}
            onOpenMcp={onOpenMcp}
            onOpenNewProject={onOpenNewProject}
            onCreateProject={onCreateProject}
            templates={templates}
            onDeleteTemplate={onDeleteTemplate}
            onImportClaudeDesign={onImportClaudeDesign}
            onImportFolder={onImportFolder}
            onImportFolderResponse={onImportFolderResponse}
            skills={skills}
            skillsLoading={skillsLoading}
            commandChip={commandChip}
            executionSwitcher={executionSwitcher}
          />

          {projects.length === 0 && !projectsLoading ? (
            <p className="hub__empty" data-testid="hub-empty">
              <strong>{t('hub.noProjectsTitle')}</strong> {t('hub.noProjectsBody')}
            </p>
          ) : (
            <p className="hub__hint">
              {t('hub.startHint')} <kbd className="hub-kbd">Ctrl K</kbd>{' '}
              {t('hub.startHintContinuation')}
            </p>
          )}
        </div>
      </div>
      {paletteOpen ? <HubCommandPalette entries={paletteEntries} onClose={closePalette} /> : null}
      {pendingSessionDeletion ? (
        <Toast
          message={t('hub.sessionDeleted', { name: pendingSessionDeletion.session.title })}
          ttlMs={6000}
          actionLabel={t('manualEdit.undo')}
          onAction={undoPendingSessionDeletion}
          onDismiss={commitPendingSessionDeletion}
        />
      ) : null}
      {peeked ? (
        <HubInspector
          session={peeked.session}
          projectName={peeked.project.name}
          onOpen={(session) => {
            setPeekedSessionId(null);
            handleOpenSession(session);
          }}
          onClose={() => {
            setPeekedSessionId(null);
            // Peeking is a rail interaction, so dismissing it belongs back on
            // the row that opened it rather than at the top of the document.
            document
              .querySelector<HTMLElement>(`[data-testid="hub-session-${peeked.session.id}"]`)
              ?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
