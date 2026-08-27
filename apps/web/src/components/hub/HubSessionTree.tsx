// Left-panel navigation for the entry hub.
//
// This is the single navigation model for the entry surface: projects expand
// into their sessions in place, and activating a session hands off directly to
// the workspace. Follows the ARIA tree pattern - one tab stop (roving
// tabindex), arrow-key traversal, and a group per project.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useT } from '../../i18n';
import { relativeTimeLong } from '../../utils/chatTime';
import {
  HUB_SESSION_PAGE,
  matchesHubFilter,
  projectMatchesFilter,
  rollupProjectState,
  sortProjects,
  type HubFilter,
  type HubProjectNode,
  type HubSessionNode,
  type HubSessionState,
  type HubSort,
} from './types';

interface Props {
  projects: HubProjectNode[];
  currentSessionId: string | null;
  onOpenSession: (session: HubSessionNode) => void;
  onNewSession?: (project: HubProjectNode) => void;
  /** Retries ONE project's session read; siblings are left alone. */
  onRetrySessions?: (project: HubProjectNode) => void;
  /** The project whose new-session request is currently in flight, if any. */
  pendingNewSessionProjectId?: string | null;
  /** Opens a project with no sessions rather than leaving a dead row. */
  onOpenProject?: (project: HubProjectNode) => void;
  onRename?: (row: HubProjectNode | HubSessionNode, name: string) => void;
  onDelete?: (row: HubProjectNode | HubSessionNode) => void;
}

interface FlatRow {
  key: string;
  kind: 'project' | 'session' | 'more';
  project: HubProjectNode;
  session?: HubSessionNode;
}

type StateLabelKey = 'hub.stateRunning' | 'hub.stateAwaiting' | 'hub.stateFailed';

function stateLabelKey(state: HubSessionState): StateLabelKey | null {
  if (state === 'running') return 'hub.stateRunning';
  if (state === 'awaiting') return 'hub.stateAwaiting';
  if (state === 'failed') return 'hub.stateFailed';
  return null;
}

export function HubSessionTree({
  projects,
  currentSessionId,
  onOpenSession,
  onNewSession,
  onRetrySessions,
  pendingNewSessionProjectId = null,
  onOpenProject,
  onRename,
  onDelete,
}: Props) {
  const t = useT();
  const [filter, setFilter] = useState<HubFilter>('all');
  const [sort, setSort] = useState<HubSort>('recent');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedOverflow, setExpandedOverflow] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const typeAheadRef = useRef('');
  const typeAheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row activated out of existence (the overflow row) hands focus to a row
  // that only mounts on the next render, so the target is claimed by whichever
  // ref callback registers it rather than by an effect that may run first.
  const pendingFocusRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const ordered = useMemo(() => sortProjects(projects, sort), [projects, sort]);

  const visible = useMemo(() => {
    return ordered
      .map((project) => {
        const matching = project.sessions.filter((s) => matchesHubFilter(s.state, filter));
        const capped =
          filter === 'all' && !expandedOverflow[project.id]
            ? matching.slice(0, HUB_SESSION_PAGE)
            : matching;
        return {
          project,
          sessions: capped,
          hiddenCount: matching.length - capped.length,
          // A filtered view always reveals its matches, so only the unfiltered
          // list is allowed to stay collapsed.
          open: filter !== 'all' ? true : !collapsed[project.id],
          empty: matching.length === 0,
          selfMatches: projectMatchesFilter(project, filter),
        };
      })
      .filter((entry) => (filter === 'all' ? true : !entry.empty || entry.selfMatches));
  }, [ordered, filter, collapsed, expandedOverflow]);

  const rows = useMemo<FlatRow[]>(() => {
    const next: FlatRow[] = [];
    for (const entry of visible) {
      next.push({ key: `p:${entry.project.id}`, kind: 'project', project: entry.project });
      if (!entry.open) continue;
      for (const session of entry.sessions) {
        next.push({ key: `s:${session.id}`, kind: 'session', project: entry.project, session });
      }
      if (entry.hiddenCount > 0) {
        next.push({ key: `m:${entry.project.id}`, kind: 'more', project: entry.project });
      }
    }
    return next;
  }, [visible]);

  useEffect(() => {
    if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length, cursor]);

  useEffect(() => () => {
    if (typeAheadTimerRef.current) clearTimeout(typeAheadTimerRef.current);
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setCursor(index);
      rowRefs.current.get(row.key)?.focus();
    },
    [rows],
  );

  const activate = useCallback(
    (row: FlatRow) => {
      if (row.kind === 'session' && row.session) {
        onOpenSession(row.session);
        return;
      }
      if (row.kind === 'more') {
        // The "more" row disappears once its sessions render, so hand focus to
        // the first newly revealed session rather than letting it fall to body.
        // Index against the rows the current filter actually shows.
        const shown = row.project.sessions.filter((s) => matchesHubFilter(s.state, filter));
        const firstHidden = shown[HUB_SESSION_PAGE]?.id;
        setExpandedOverflow((prev) => ({ ...prev, [row.project.id]: true }));
        if (firstHidden) pendingFocusRef.current = `s:${firstHidden}`;
        return;
      }
      // A project with no sessions has nothing to expand, so activating it
      // opens the project instead of toggling an empty group.
      if (onOpenProject && row.project.sessions.length === 0) {
        onOpenProject(row.project);
        return;
      }
      setCollapsed((prev) => ({ ...prev, [row.project.id]: !prev[row.project.id] }));
    },
    [onOpenSession, onOpenProject, filter],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, fallbackIndex: number) => {
      // Project treeitems own their session groups in the DOM, so a session
      // key event must not bubble into the parent project's handler.
      event.stopPropagation();
      // Resolve the row from the focused element so keyboard traversal stays
      // correct even when focus arrived without going through onClick.
      const focusedKey = event.currentTarget.dataset.rowKey;
      const resolved = focusedKey ? rows.findIndex((candidate) => candidate.key === focusedKey) : -1;
      const index = resolved >= 0 ? resolved : fallbackIndex;
      const row = rows[index];
      if (!row) return;
      switch (event.key) {
        case 'F2': {
          if (row.kind === 'more' || !onRename) break;
          event.preventDefault();
          setRenamingKey(row.key);
          setRenameValue(row.session?.title ?? row.project.name);
          break;
        }
        case 'Delete':
          if (row.kind === 'more' || !onDelete) break;
          event.preventDefault();
          onDelete(row.session ?? row.project);
          focusRow(Math.min(index + 1, rows.length - 1));
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
          if (row.kind !== 'project') break;
          event.preventDefault();
          if (collapsed[row.project.id]) {
            setCollapsed((prev) => ({ ...prev, [row.project.id]: false }));
          } else {
            focusRow(Math.min(index + 1, rows.length - 1));
          }
          break;
        case 'ArrowLeft': {
          event.preventDefault();
          if (row.kind === 'project' && !collapsed[row.project.id]) {
            setCollapsed((prev) => ({ ...prev, [row.project.id]: true }));
            break;
          }
          const parent = rows.findIndex(
            (candidate) => candidate.kind === 'project' && candidate.project.id === row.project.id,
          );
          if (parent >= 0) focusRow(parent);
          break;
        }
        case 'Enter':
        case ' ':
          event.preventDefault();
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
              const name = candidate.session?.title ?? candidate.project.name;
              return candidate.kind !== 'more' && name.toLocaleLowerCase().startsWith(typeAheadRef.current);
            });
            if (match >= 0) focusRow(match);
          }
          break;
      }
    },
    [rows, focusRow, collapsed, activate, onRename, onDelete],
  );

  // Counts are per-project so a project awaiting input is counted once, even
  // though no session can carry that state.
  const counts = useMemo(
    () => ({
      attention: projects.filter((p) => projectMatchesFilter(p, 'attention')).length,
      running: projects.filter((p) => projectMatchesFilter(p, 'running')).length,
    }),
    [projects],
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

  const renameControl = (key: string, row: HubProjectNode | HubSessionNode) => (
    <input
      className="hub-row__rename"
      data-testid={`hub-rename-${key.slice(2)}`}
      value={renameValue}
      aria-label="Rename"
      autoFocus
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setRenameValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          const next = renameValue.trim();
          if (next) onRename?.(row, next);
          setRenamingKey(null);
          rowRefs.current.get(key)?.focus();
        } else if (event.key === 'Escape') {
          setRenamingKey(null);
          rowRefs.current.get(key)?.focus();
        }
      }}
    />
  );

  return (
    <div className="hub-tree">
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
        <span className="hub-tree__sorts">
          <button
            type="button"
            className="hub-tree__sort"
            data-testid="hub-sort-recent"
            aria-pressed={sort === 'recent'}
            onClick={() => setSort('recent')}
          >
            {t('hub.sortRecent')}
          </button>
          <button
            type="button"
            className="hub-tree__sort"
            data-testid="hub-sort-name"
            aria-pressed={sort === 'name'}
            onClick={() => setSort('name')}
          >
            {t('hub.sortName')}
          </button>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="hub-tree__empty" data-testid="hub-tree-empty">
          {t('hub.emptyFiltered')}{' '}
          <button type="button" className="hub-tree__link" onClick={() => setFilter('all')}>
            {t('hub.clearFilter')}
          </button>
        </p>
      ) : null}

      <div className="hub-tree__body" role="tree" aria-label={t('hub.treeLabel')}>
        {visible.map((entry) => {
          const projectKey = `p:${entry.project.id}`;
          const projectIndex = indexOfKey(projectKey);
          const rollup = rollupProjectState(entry.project);
          const rollupKey = stateLabelKey(rollup);
          const sessionsStatus = entry.project.sessionsStatus ?? 'ready';
          return (
            <div key={entry.project.id} className="hub-tree__node">
              <div
                ref={registerRow(projectKey)}
                role="treeitem"
                aria-expanded={entry.open}
                aria-level={1}
                {...(!entry.open && rollupKey
                  ? { 'aria-describedby': `hub-state-${entry.project.id}` }
                  : {})}
                tabIndex={cursor === projectIndex ? 0 : -1}
                data-testid={`hub-project-${entry.project.id}`}
                data-row-key={projectKey}
                data-project-id={entry.project.id}
                data-state={rollup}
                className="hub-row hub-row--project"
                onFocus={() => syncCursorToFocus(projectKey)}
                onClick={() => {
                  setCursor(projectIndex);
                  const row = rows[projectIndex];
                  if (row) activate(row);
                }}
                onKeyDown={(event) => onKeyDown(event, projectIndex)}
              >
                <span className="hub-row__chevron" aria-hidden="true" data-open={entry.open} />
                {renamingKey === projectKey
                  ? renameControl(projectKey, entry.project)
                  : <span className="hub-row__title">{entry.project.name}</span>}
                {entry.open || !rollupKey ? null : (
                  <span
                    id={`hub-state-${entry.project.id}`}
                    className={`hub-row__state hub-row__state--${rollup}`}
                  >
                    {t(rollupKey)}
                  </span>
                )}
                {onNewSession ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="hub-row__action"
                    data-testid={`hub-new-session-${entry.project.id}`}
                    aria-label={t('hub.newSessionIn', { name: entry.project.name })}
                    aria-busy={pendingNewSessionProjectId === entry.project.id}
                    disabled={pendingNewSessionProjectId === entry.project.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNewSession(entry.project);
                    }}
                  >
                    +
                  </button>
                ) : null}

              <div
                role="group"
                aria-label={entry.project.name}
                className="hub-tree__group"
                data-open={entry.open}
                hidden={!entry.open}
              >
                {/* Session-read state lives OUTSIDE the treeitem set on
                    purpose: adding rows here would change the roving-focus
                    order and the arrow-key model. */}
                {sessionsStatus === 'loading' ? (
                  <p
                    role="presentation"
                    className="hub-tree__note"
                    data-testid={`hub-sessions-loading-${entry.project.id}`}
                  >
                    {t('common.loading')}
                  </p>
                ) : null}
                {sessionsStatus === 'unavailable' || sessionsStatus === 'stale' ? (
                  <p
                    role="presentation"
                    className={`hub-tree__note hub-tree__note--${sessionsStatus}`}
                    data-testid={`hub-sessions-error-${entry.project.id}`}
                    data-status={sessionsStatus}
                  >
                    <span>
                      {sessionsStatus === 'unavailable'
                        ? t('hub.sessionsUnavailable')
                        : t('hub.sessionsStale')}
                    </span>
                    {onRetrySessions ? (
                      <button
                        type="button"
                        className="hub-tree__link"
                        data-testid={`hub-sessions-retry-${entry.project.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRetrySessions(entry.project);
                        }}
                      >
                        {t('hub.retrySessions')}
                      </button>
                    ) : null}
                  </p>
                ) : null}
                {entry.sessions.map((session) => {
                  const sessionKey = `s:${session.id}`;
                  const sessionIndex = indexOfKey(sessionKey);
                  const labelKey = stateLabelKey(session.state);
                  return (
                    <div
                      key={session.id}
                      ref={registerRow(sessionKey)}
                      role="treeitem"
                      aria-level={2}
                      aria-current={session.id === currentSessionId ? 'true' : undefined}
                      {...(labelKey ? { 'aria-describedby': `hub-state-${session.id}` } : {})}
                      tabIndex={cursor === sessionIndex ? 0 : -1}
                      data-testid={`hub-session-${session.id}`}
                      data-row-key={sessionKey}
                      data-session-id={session.id}
                      data-state={session.state}
                      className={`hub-row hub-row--session${
                        session.id === currentSessionId ? ' is-current' : ''
                      }`}
                      onFocus={() => syncCursorToFocus(sessionKey)}
                      onClick={() => {
                        setCursor(sessionIndex);
                        onOpenSession(session);
                      }}
                      onKeyDown={(event) => onKeyDown(event, sessionIndex)}
                    >
                      {renamingKey === sessionKey
                        ? renameControl(sessionKey, session)
                        : <span className="hub-row__title">{session.title}</span>}
                      {labelKey ? (
                        <span
                          id={`hub-state-${session.id}`}
                          className={`hub-row__state hub-row__state--${session.state}`}
                        >
                          {t(labelKey)}
                        </span>
                      ) : (
                        // A completed session carries no status badge, so its
                        // trailing slot shows last activity - the same thing the
                        // approved rows show there. The test id deliberately
                        // avoids the `hub-session-` prefix: row queries select on
                        // it and a nested match would inflate every row count.
                        <span
                          className="hub-row__meta"
                          data-testid={`hub-row-time-${session.id}`}
                        >
                          {relativeTimeLong(session.updatedAt, t)}
                        </span>
                      )}
                    </div>
                  );
                })}

                {entry.hiddenCount > 0 ? (
                  <div
                    ref={registerRow(`m:${entry.project.id}`)}
                    role="treeitem"
                    aria-level={2}
                    tabIndex={cursor === indexOfKey(`m:${entry.project.id}`) ? 0 : -1}
                    data-testid={`hub-tree-more-${entry.project.id}`}
                    data-row-key={`m:${entry.project.id}`}
                    className="hub-row hub-row--more"
                    onFocus={() => syncCursorToFocus(`m:${entry.project.id}`)}
                    onClick={() =>
                      setExpandedOverflow((prev) => ({ ...prev, [entry.project.id]: true }))
                    }
                    onKeyDown={(event) => onKeyDown(event, indexOfKey(`m:${entry.project.id}`))}
                  >
                    {t('hub.showMoreSessions', { count: String(entry.hiddenCount) })}
                  </div>
                ) : null}
              </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
