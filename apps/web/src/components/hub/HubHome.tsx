// Entry hub: the surface that replaced the welcome/hero screen.
//
// Left panel owns navigation (project -> session tree). The center is a calm
// start surface: a live-work strip when something is running, the composer,
// and import starters. Past work is never dumped into the center canvas.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT } from '../../providers/daemon';
import { createConversation, readConversations } from '../../state/projects';
import type { DesignSystemSummary, Project, SkillSummary } from '../../types';
import { HomeView } from '../HomeView';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { HubSessionTree } from './HubSessionTree';
import {
  projectStateFromStatus,
  sessionStateFromRunStatus,
  type HubProjectNode,
  type HubSessionNode,
  type HubSessionsStatus,
} from './types';

const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];

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

const EMPTY_SESSIONS: HubSessionNode[] = [];

interface Props {
  projects: Project[];
  projectsLoading?: boolean;
  /** Open an existing session directly in the workspace. */
  onOpenSession: (projectId: string, conversationId: string) => void;
  /** Rich creation payload; HomeView owns all composer submission state. */
  onSubmit?: (payload: PluginLoopSubmit) => Promise<boolean> | boolean | void;
  /** @deprecated compatibility for callers not yet migrated to the rich payload. */
  onSubmitPrompt?: (prompt: string, options?: { designSystemId: string | null }) => unknown;
  onOpenProject?: (id: string) => void;
  onViewAllProjects?: () => void;
  onBrowseRegistry?: () => void;
  onOpenMcp?: () => void;
  onOpenNewProject?: (tab: 'template') => void;
  skills?: SkillSummary[];
  skillsLoading?: boolean;
  designSystems?: DesignSystemSummary[];
  defaultDesignSystemId?: string | null;
  onNewProject: () => void;
  /**
   * Real folder import. Omitted when no import route is available (no desktop
   * host and no local daemon picker), in which case the starter is not shown
   * at all rather than opening an unrelated form.
   */
  onImportFolder?: () => void;
  importingFolder?: boolean;
  onImportClaudeZip?: () => void;
  importingClaudeZip?: boolean;
  /** Failure text from either starter; rendered as a visible alert. */
  starterError?: { message: string; details?: string } | null;
  onDismissStarterError?: () => void;
  currentSessionId?: string | null;
  /** Brand click returns to the hub itself; entry chrome owns the target. */
  onGoHome?: () => void;
}

export function HubHome({
  projects,
  projectsLoading = false,
  onOpenSession,
  onSubmit,
  onSubmitPrompt,
  onOpenProject,
  onViewAllProjects,
  onBrowseRegistry,
  onOpenMcp,
  onOpenNewProject,
  skills,
  skillsLoading,
  onNewProject,
  onImportFolder,
  importingFolder = false,
  onImportClaudeZip,
  importingClaudeZip = false,
  starterError = null,
  onDismissStarterError,
  currentSessionId = null,
  onGoHome,
  designSystems = EMPTY_DESIGN_SYSTEMS,
  defaultDesignSystemId = null,
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
  // Read through a ref so the fetch effect does not re-run when `t` changes
  // identity, while still rendering the translated fallback label.
  const untitledLabel = useRef(t('hub.untitledSession'));
  untitledLabel.current = t('hub.untitledSession');

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
          sessions: entry?.sessions ?? EMPTY_SESSIONS,
          sessionsStatus: entry?.status ?? 'loading',
          state: projectStateFromStatus(project.status?.value),
        };
      }),
    [projects, sessionsByProject],
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

  const running = useMemo(
    () =>
      allNodes
        .flatMap((project) => project.sessions.map((session) => ({ project, session })))
        .find((entry) => entry.session.state === 'running') ?? null,
    [allNodes],
  );
  const handleOpenSession = useCallback(
    (session: HubSessionNode) => {
      setAnnouncement(t('hub.liveWorking', { project: '', session: session.title }));
      onOpenSession(session.projectId, session.id);
    },
    [onOpenSession, t],
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
    <div className="hub">
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

      <nav className="hub__nav" aria-label={t('hub.treeLabel')} data-testid="hub-nav">
        <div className="hub__nav-head">
          <button
            type="button"
            className="hub__brand"
            data-testid="hub-brand"
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
          </button>
        </div>
        <div className="hub__nav-actions">
          <button type="button" className="hub__new-project" onClick={onNewProject}>
            {t('entry.navNewProject')}
          </button>
          <input
            type="search"
            className="hub__search"
            data-testid="hub-search"
            value={query}
            aria-label={t('hub.searchPlaceholder')}
            placeholder={t('hub.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {projectsLoading ? (
          <p className="hub__nav-loading">{t('common.loading')}</p>
        ) : (
          <HubSessionTree
            key={query.trim() ? 'filtered' : 'all'}
            projects={tree}
            currentSessionId={currentSessionId}
            onOpenSession={handleOpenSession}
            onNewSession={handleNewSession}
            onRetrySessions={handleRetrySessions}
            pendingNewSessionProjectId={creatingSessionFor}
          />
        )}
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
            skills={skills}
            skillsLoading={skillsLoading}
          />

          <div className="hub__starters">
            {onImportFolder ? (
              <button
                type="button"
                className="hub__starter"
                data-testid="hub-import-folder"
                disabled={importingFolder}
                aria-busy={importingFolder}
                onClick={onImportFolder}
              >
                {importingFolder ? t('hub.importingFolder') : t('hub.importFolder')}
              </button>
            ) : null}
            {onImportClaudeZip ? (
              <button
                type="button"
                className="hub__starter"
                data-testid="hub-import-claude-zip"
                disabled={importingClaudeZip}
                aria-busy={importingClaudeZip}
                onClick={onImportClaudeZip}
              >
                {importingClaudeZip ? t('hub.importingClaudeZip') : t('hub.importClaudeZip')}
              </button>
            ) : null}
          </div>

          {starterError ? (
            <p className="hub__starter-error" role="alert" data-testid="hub-starter-error">
              <span>{starterError.message}</span>
              {starterError.details ? <span>{starterError.details}</span> : null}
              {onDismissStarterError ? (
                <button type="button" className="hub-tree__link" onClick={onDismissStarterError}>
                  {t('common.close')}
                </button>
              ) : null}
            </p>
          ) : null}

          {projects.length === 0 && !projectsLoading ? (
            <p className="hub__empty" data-testid="hub-empty">
              <strong>{t('hub.noProjectsTitle')}</strong> {t('hub.noProjectsBody')}
            </p>
          ) : (
            <p className="hub__hint">{t('hub.startHint')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
