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
import { Icon } from '../Icon';
import { HubMenu, type HubMenuItem } from './HubMenu';
import { relativeTimeShort } from './relativeTime';
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
  /** Open the inspector for a session without navigating to it. */
  onPeekSession?: (session: HubSessionNode) => void;
  onRenameProject?: (project: HubProjectNode, name: string) => void;
  onDeleteProject?: (project: HubProjectNode) => void;
  onRenameSession?: (session: HubSessionNode, title: string) => void;
  onDeleteSession?: (session: HubSessionNode) => void;
}

interface FlatRow {
  key: string;
  kind: 'project' | 'session' | 'more';
  project: HubProjectNode;
  session?: HubSessionNode;
}

interface MenuState {
  rowKey: string;
  anchor: HTMLElement;
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
  onPeekSession,
  onRenameProject,
  onDeleteProject,
  onRenameSession,
  onDeleteSession,
}: Props) {
  const t = useT();
  const [filter, setFilter] = useState<HubFilter>('all');
  const [sort, setSort] = useState<HubSort>('recent');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedOverflow, setExpandedOverflow] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  // Rename happens in place: a modal for one field is heavier than the edit.
  const [renaming, setRenaming] = useState<string | null>(null);
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

  // A row removed underneath an open menu would leave the menu anchored to a
  // detached node and its focus-restore target gone.
  useEffect(() => {
    if (menu && !rows.some((row) => row.key === menu.rowKey)) setMenu(null);
    if (renaming && !rows.some((row) => row.key === renaming)) setRenaming(null);
  }, [rows, menu, renaming]);

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
      if (row.project.sessions.length === 0 && onOpenProject) {
        onOpenProject(row.project);
        return;
      }
      setCollapsed((prev) => ({ ...prev, [row.project.id]: !prev[row.project.id] }));
    },
    [onOpenSession, onOpenProject, filter],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, fallbackIndex: number) => {
      // Resolve the row from the focused element so keyboard traversal stays
      // correct even when focus arrived without going through onClick.
      const focusedKey = event.currentTarget.dataset.rowKey;
      const resolved = focusedKey ? rows.findIndex((candidate) => candidate.key === focusedKey) : -1;
      const index = resolved >= 0 ? resolved : fallbackIndex;
      const row = rows[index];
      if (!row) return;
      // A session group lives INSIDE its project treeitem for ARIA ownership, so
      // an unstopped key would run this handler again on the ancestor row and
      // act twice - Space on a session would also collapse its project.
      event.stopPropagation();
      switch (event.key) {
        case 'F2': {
          if (row.kind === 'more') break;
          const canRename = row.kind === 'project' ? onRenameProject : onRenameSession;
          if (!canRename) break;
          event.preventDefault();
          setRenaming(row.key);
          break;
        }
        case 'Delete':
          if (row.kind === 'more') break;
          event.preventDefault();
          if (row.kind === 'project') onDeleteProject?.(row.project);
          else if (row.session) onDeleteSession?.(row.session);
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
          event.preventDefault();
          activate(row);
          break;
        case ' ':
          event.preventDefault();
          // Space peeks a session rather than opening it - the whole point of
          // the inspector is inspecting without leaving the rail. Projects have
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
              const name = candidate.session?.title ?? candidate.project.name;
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
      onRenameProject,
      onRenameSession,
      onDeleteProject,
      onDeleteSession,
    ],
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

  // The heading counts what the list is actually showing: projects when
  // unfiltered, matching sessions once a filter narrows the view.
  const groupCount = useMemo(() => {
    if (filter === 'all') return visible.length;
    return visible.reduce((total, entry) => total + entry.sessions.length, 0);
  }, [visible, filter]);

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

  const menuItems = useMemo<HubMenuItem[]>(() => {
    if (!menuRow) return [];
    if (menuRow.kind === 'project') {
      const items: HubMenuItem[] = [];
      if (onRenameProject) {
        items.push({
          id: 'rename',
          label: t('common.rename'),
          icon: 'pencil',
          onSelect: () => setRenaming(menuRow.key),
        });
      }
      if (onNewSession) {
        items.push({
          id: 'new-session',
          label: t('hub.newSession'),
          icon: 'plus',
          onSelect: () => onNewSession(menuRow.project),
        });
      }
      if (onDeleteProject) {
        items.push({
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash',
          danger: true,
          onSelect: () => onDeleteProject(menuRow.project),
        });
      }
      return items;
    }
    const session = menuRow.session;
    if (!session) return [];
    const items: HubMenuItem[] = [];
    if (onRenameSession) {
      items.push({
        id: 'rename',
        label: t('common.rename'),
        icon: 'pencil',
        onSelect: () => setRenaming(menuRow.key),
      });
    }
    if (onPeekSession) {
      items.push({
        id: 'info',
        label: t('hub.sessionInfo'),
        icon: 'info',
        shortcut: 'Space',
        onSelect: () => onPeekSession(session),
      });
    }
    if (onDeleteSession) {
      items.push({
        id: 'delete',
        label: t('common.delete'),
        icon: 'trash',
        danger: true,
        onSelect: () => onDeleteSession(session),
      });
    }
    return items;
  }, [
    menuRow,
    onRenameProject,
    onNewSession,
    onDeleteProject,
    onRenameSession,
    onPeekSession,
    onDeleteSession,
    t,
  ]);

  const sortItems = useMemo<HubMenuItem[]>(
    () => [
      {
        id: 'recent',
        label: t('hub.sortRecent'),
        checked: sort === 'recent',
        onSelect: () => setSort('recent'),
      },
      {
        id: 'name',
        label: t('hub.sortName'),
        checked: sort === 'name',
        onSelect: () => setSort('name'),
      },
    ],
    [sort, t],
  );

  const renameField = (rowKey: string, current: string, commit: (next: string) => void) => (
    <input
      className="hub-row__rename"
      defaultValue={current}
      data-testid={`hub-rename-${rowKey.replace(':', '-')}`}
      aria-label={t('common.rename')}
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
            // swallow the click - which is exactly what happened on the click
            // right after selecting an item, when the menu's focus handoff
            // leaves React scheduling this update outside the handler.
            const button = event.currentTarget as HTMLElement;
            setSortAnchor((prev) => (prev ? null : button));
          }}
        >
          <Icon name="sliders" size={15} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="hub-tree__empty" data-testid="hub-tree-empty">
          {t('hub.emptyFiltered')}{' '}
          <button type="button" className="hub-tree__link" onClick={() => setFilter('all')}>
            {t('hub.clearFilter')}
          </button>
        </p>
      ) : (
        <p className="hub-tree__group-label" data-testid="hub-group-label">
          {filter === 'all' ? t('hub.projects') : t('hub.results')}{' '}
          <span className="hub-tree__group-count" data-testid="hub-group-count">
            {groupCount}
          </span>
        </p>
      )}

      <div className="hub-tree__body" role="tree" aria-label={t('hub.treeLabel')}>
        {visible.map((entry) => {
          const projectKey = `p:${entry.project.id}`;
          const projectIndex = indexOfKey(projectKey);
          const rollup = rollupProjectState(entry.project);
          const rollupKey = stateLabelKey(rollup);
          const sessionsStatus = entry.project.sessionsStatus ?? 'ready';
          const projectRenaming = renaming === projectKey;
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
                className={`hub-row hub-row--project${
                  menu?.rowKey === projectKey ? ' is-menu-open' : ''
                }`}
                onFocus={() => syncCursorToFocus(projectKey)}
                onClick={() => {
                  setCursor(projectIndex);
                  const row = rows[projectIndex];
                  if (row) activate(row);
                }}
                onKeyDown={(event) => onKeyDown(event, projectIndex)}
              >
                <span className="hub-row__chevron" aria-hidden="true" data-open={entry.open} />
                {projectRenaming && onRenameProject ? (
                  renameField(projectKey, entry.project.name, (next) =>
                    onRenameProject(entry.project, next),
                  )
                ) : (
                  <span className="hub-row__title">{entry.project.name}</span>
                )}
                {entry.open || !rollupKey ? null : (
                  <span
                    id={`hub-state-${entry.project.id}`}
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
                      data-testid={`hub-new-session-${entry.project.id}`}
                      aria-label={t('hub.newSessionIn', { name: entry.project.name })}
                      aria-busy={pendingNewSessionProjectId === entry.project.id}
                      disabled={pendingNewSessionProjectId === entry.project.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        onNewSession(entry.project);
                      }}
                    >
                      <Icon name="plus" size={14} />
                    </button>
                  ) : null}
                  {onRenameProject || onDeleteProject ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="hub-row__action"
                      data-testid={`hub-menu-project-${entry.project.id}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.rowKey === projectKey}
                      aria-label={t('hub.rowMenu', { name: entry.project.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        const anchor = event.currentTarget as HTMLElement;
                        setCursor(projectIndex);
                        setMenu((prev) =>
                          prev?.rowKey === projectKey ? null : { rowKey: projectKey, anchor },
                        );
                      }}
                    >
                      <Icon name="more-horizontal" size={14} />
                    </button>
                  ) : null}
                </span>

              {/* The group is a DESCENDANT of the project treeitem, not a
                  sibling: ARIA ownership is what lets assistive tech say which
                  project owns which sessions. */}
              <div
                role="group"
                aria-label={entry.project.name}
                className="hub-tree__group"
                data-open={entry.open}
                hidden={!entry.open}
              >
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
                  const sessionRenaming = renaming === sessionKey;
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
                      }${menu?.rowKey === sessionKey ? ' is-menu-open' : ''}`}
                      onFocus={() => syncCursorToFocus(sessionKey)}
                      onClick={(event) => {
                        // Nested inside the project treeitem, so opening a
                        // session must not also toggle its project.
                        event.stopPropagation();
                        setCursor(sessionIndex);
                        onOpenSession(session);
                      }}
                      onKeyDown={(event) => onKeyDown(event, sessionIndex)}
                    >
                      {sessionRenaming && onRenameSession ? (
                        renameField(sessionKey, session.title, (next) =>
                          onRenameSession(session, next),
                        )
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
                        // A settled session carries its last activity instead of
                        // a state word - the fetched `updatedAt` was previously
                        // dropped on the floor.
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
                        {onRenameSession || onDeleteSession ? (
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
                                prev?.rowKey === sessionKey ? null : { rowKey: sessionKey, anchor },
                              );
                            }}
                          >
                            <Icon name="more-horizontal" size={14} />
                          </button>
                        ) : null}
                      </span>
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
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedOverflow((prev) => ({ ...prev, [entry.project.id]: true }));
                    }}
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

      {menu && menuRow && menuItems.length > 0 ? (
        <HubMenu
          title={menuRow.kind === 'project' ? menuRow.project.name : (menuRow.session?.title ?? '')}
          items={menuItems}
          anchor={menu.anchor}
          returnFocusTo={rowRefs.current.get(menu.rowKey) ?? menu.anchor}
          testId="hub-row-menu"
          onClose={() => setMenu(null)}
        />
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
