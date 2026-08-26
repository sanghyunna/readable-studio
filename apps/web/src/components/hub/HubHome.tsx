// Entry hub: the surface that replaced the welcome/hero screen.
//
// Left panel owns navigation (project -> session tree). The center is a calm
// start surface: a live-work strip when something is running, the composer,
// and import starters. Past work is never dumped into the center canvas.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT } from '../../providers/daemon';
import { listConversations } from '../../state/projects';
import type { DesignSystemSummary, Project } from '../../types';
import { HubSessionTree } from './HubSessionTree';
import {
  projectStateFromStatus,
  sessionStateFromRunStatus,
  type HubProjectNode,
  type HubSessionNode,
} from './types';

const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];

interface Props {
  projects: Project[];
  projectsLoading?: boolean;
  /** Open an existing session directly in the workspace. */
  onOpenSession: (projectId: string, conversationId: string) => void;
  /**
   * Prompt-first creation; App owns the auto-send handoff. The options carry
   * the composer's design-system choice so the hub does not silently drop what
   * the hero used to let the user pick.
   */
  onSubmitPrompt: (prompt: string, options?: { designSystemId: string | null }) => unknown;
  designSystems?: DesignSystemSummary[];
  defaultDesignSystemId?: string | null;
  onNewProject: () => void;
  onImportFolder: () => void;
  onImportClaudeZip?: () => void;
  currentSessionId?: string | null;
  /** Brand click returns to the hub itself; entry chrome owns the target. */
  onGoHome?: () => void;
}

export function HubHome({
  projects,
  projectsLoading = false,
  onOpenSession,
  onSubmitPrompt,
  onNewProject,
  onImportFolder,
  onImportClaudeZip,
  currentSessionId = null,
  onGoHome,
  designSystems = EMPTY_DESIGN_SYSTEMS,
  defaultDesignSystemId = null,
}: Props) {
  const t = useT();
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, HubSessionNode[]>>({});
  const [prompt, setPrompt] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [designSystemId, setDesignSystemId] = useState<string | null>(defaultDesignSystemId);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // State updates are async, so the ref is what actually blocks a second
  // activation inside the same tick (double-click, key repeat).
  const submittingRef = useRef(false);
  // Read through a ref so the fetch effect does not re-run when `t` changes
  // identity, while still rendering the translated fallback label.
  const untitledLabel = useRef(t('hub.untitledSession'));
  untitledLabel.current = t('hub.untitledSession');

  useEffect(() => {
    setDesignSystemId(defaultDesignSystemId);
  }, [defaultDesignSystemId]);

  // Sessions are per-project on the daemon; there is no cross-project
  // conversation endpoint. Fan out per project and commit each result as it
  // lands so one slow or failing project cannot hide every other project's
  // sessions, and refresh when runs change so states do not go stale.
  const projectIds = useMemo(() => projects.map((p) => p.id).join('\u0000'), [projects]);

  useEffect(() => {
    const ids = projectIds ? projectIds.split('\u0000') : [];
    if (ids.length === 0) {
      setSessionsByProject({});
      return undefined;
    }

    let generation = 0;
    let cancelled = false;

    const load = () => {
      const current = ++generation;
      for (const id of ids) {
        void listConversations(id)
          .then((conversations) => {
            if (cancelled || current !== generation) return;
            setSessionsByProject((prev) => ({
              ...prev,
              [id]: conversations.map((conversation) => ({
                id: conversation.id,
                projectId: id,
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
            }));
          })
          .catch(() => {
            // A project whose conversations cannot be read keeps whatever it
            // last had; it must not erase its siblings.
          });
      }
    };

    load();
    window.addEventListener(RUNS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RUNS_CHANGED_EVENT, load);
    };
  }, [projectIds]);

  const allNodes = useMemo<HubProjectNode[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        sessions: sessionsByProject[project.id] ?? [],
        state: projectStateFromStatus(project.status?.value),
      })),
    [projects, sessionsByProject],
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
  const submit = useCallback(() => {
    // State updates are async, so the ref is what actually blocks a second
    // activation inside the same tick (double-click, key repeat).
    if (submittingRef.current) return;
    const value = prompt.trim();
    if (!value) {
      composerRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    const result = onSubmitPrompt(value, { designSystemId }) as Promise<unknown> | unknown;
    const done = () => {
      submittingRef.current = false;
      setSubmitting(false);
    };
    if (result && typeof (result as Promise<unknown>).finally === 'function') {
      void (result as Promise<unknown>).finally(done);
    } else {
      // A synchronous handler has already done its work; unlock immediately so
      // the composer never stays dead after a non-promise create path.
      done();
    }
  }, [prompt, onSubmitPrompt, designSystemId]);

  const ready = prompt.trim().length > 0 && !submitting;

  return (
    <div className="hub">
      <div className="sr-only" role="status" aria-live="polite" data-testid="hub-live-region">
        {announcement}
      </div>

      <nav className="hub__nav" aria-label={t('hub.treeLabel')} data-testid="hub-nav">
        <div className="hub__nav-head">
          <button
            type="button"
            className="hub__brand"
            data-testid="hub-brand"
            onClick={() => onGoHome?.()}
          >
            <span className="hub__brand-mark" aria-hidden="true" />
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

          <h1 className="hub__title">{t('hub.startTitle')}</h1>
          <p className="hub__subtitle">{t('hub.startSubtitle')}</p>

          <div className="hub__composer">
            <textarea
              ref={composerRef}
              className="hub__composer-input"
              data-testid="hub-composer"
              rows={3}
              value={prompt}
              aria-label={t('hub.startTitle')}
              placeholder={t('hub.composerPlaceholder')}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="hub__composer-bar">
              {designSystems.length > 0 ? (
                <select
                  className="hub__ctl"
                  data-testid="hub-design-system"
                  value={designSystemId ?? ''}
                  aria-label={t('hub.designSystem')}
                  onChange={(event) => setDesignSystemId(event.target.value || null)}
                >
                  {designSystems.map((system) => (
                    <option key={system.id} value={system.id}>
                      {system.title}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="hub__send"
                data-testid="hub-send"
                aria-label={submitting ? t('hub.starting') : t('hub.send')}
                aria-disabled={!ready}
                disabled={submitting}
                onClick={submit}
              >
                {submitting ? t('hub.starting') : t('hub.send')}
              </button>
            </div>
          </div>

          <div className="hub__starters">
            <button type="button" className="hub__starter" onClick={onImportFolder}>
              {t('hub.importFolder')}
            </button>
            {onImportClaudeZip ? (
              <button type="button" className="hub__starter" onClick={onImportClaudeZip}>
                {t('hub.importClaudeZip')}
              </button>
            ) : null}
          </div>

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
