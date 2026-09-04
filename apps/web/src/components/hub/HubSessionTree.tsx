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
  type ReactNode,
} from 'react';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { HubMenu, type HubMenuItem } from './HubMenu';
import { initialGlyph } from './initialGlyph';
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
  /** Open only the first project when this tree is used in the compact hub rail. */
  compactByDefault?: boolean;
  /** Content placed after the shared filters and before the project tree. */
  openWork?: ReactNode;
  /**
   * The rail is showing glyphs only. Sessions are not rendered inline, so a
   * project's sessions are reached through the flyout instead of by expanding.
   */
  collapsed?: boolean;
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

// Hovering must not fire a flyout the pointer only crossed on its way
// somewhere else, and it must not lag behind a deliberate hover either.
const FLYOUT_HOVER_DELAY_MS = 180;
const COMPACT_SESSION_QUERY = '(max-height: 760px) and (max-width: 900px)';
const COMPACT_SESSION_PAGE = 4;

type StateLabelKey = 'hub.stateRunning' | 'hub.stateAwaiting' | 'hub.stateFailed';

function stateLabelKey(state: HubSessionState): StateLabelKey | null {
  if (state === 'running') return 'hub.stateRunning';
  if (state === 'awaiting') return 'hub.stateAwaiting';
  if (state === 'failed') return 'hub.stateFailed';
  return null;
}

export function HubSessionTree({
  projects,
  compactByDefault = false,
  openWork,
  collapsed: railCollapsed = false,
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
  // The collapsed rail's project flyout. Kept apart from `menu` so a row's
  // overflow menu and its flyout can never both claim the same anchor.
  const [flyout, setFlyout] = useState<{ projectId: string; anchor: HTMLElement } | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [compactSessionPage, setCompactSessionPage] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT_SESSION_QUERY).matches,
  );
  // Rename happens in place: a modal for one field is heavier than the edit.
  const [renaming, setRenaming] = useState<string | null>(null);
  const typeAheadRef = useRef('');
  const typeAheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row activated out of existence (the overflow row) hands focus to a row
  // that only mounts on the next render, so the target is claimed by whichever
  // ref callback registers it rather than by an effect that may run first.
  const pendingFocusRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const ordered = useMemo(() => sortProjects(projects, sort), [projects, sort]);
  const sessionPageSize = compactSessionPage ? COMPACT_SESSION_PAGE : HUB_SESSION_PAGE;

  const visible = useMemo(() => {
    return ordered
      .map((project, projectIndex) => {
        const matching = [...project.sessions]
          .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
          .filter((session) => matchesHubFilter(session.state, filter));
        const capped =
          filter === 'all' && !expandedOverflow[project.id]
            ? matching.slice(0, sessionPageSize)
            : matching;
        return {
          project,
          sessions: capped,
          hiddenCount: matching.length - capped.length,
          // A filtered view always reveals its matches, so only the unfiltered
          // list is allowed to stay collapsed.
          open:
            filter !== 'all'
              ? true
              : collapsed[project.id] === undefined
                ? !compactByDefault || projectIndex === 0
                : !collapsed[project.id],
          empty: matching.length === 0,
          selfMatches: projectMatchesFilter(project, filter),
        };
      })
      .filter((entry) => (filter === 'all' ? true : !entry.empty || entry.selfMatches));
  }, [ordered, filter, collapsed, expandedOverflow, sessionPageSize, compactByDefault]);

  const rows = useMemo<FlatRow[]>(() => {
    const next: FlatRow[] = [];
    for (const entry of visible) {
      next.push({ key: `p:${entry.project.id}`, kind: 'project', project: entry.project });
      // Session rows are hidden in the collapsed rail, so leaving them in the
      // row model would send arrow-key focus to invisible rows.
      if (railCollapsed) continue;
      if (!entry.open) continue;
      for (const session of entry.sessions) {
        next.push({ key: `s:${session.id}`, kind: 'session', project: entry.project, session });
      }
      if (entry.hiddenCount > 0) {
        next.push({ key: `m:${entry.project.id}`, kind: 'more', project: entry.project });
      }
    }
    return next;
  }, [visible, railCollapsed]);

  useEffect(() => {
    if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length, cursor]);

  // A row removed underneath an open menu would leave the menu anchored to a
  // detached node and its focus-restore target gone.
  useEffect(() => {
    if (menu && !rows.some((row) => row.key === menu.rowKey)) setMenu(null);
    if (renaming && !rows.some((row) => row.key === renaming)) setRenaming(null);
    if (flyout && !rows.some((row) => row.key === `p:${flyout.projectId}`)) setFlyout(null);
  }, [rows, menu, renaming, flyout]);

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
      if (row.kind === 'project' && railCollapsed) {
        // There is nothing to expand into: the sessions group is not rendered
        // in the collapsed rail, so activating a project offers them directly.
        const anchor = rowRefs.current.get(row.key);
        if (anchor) {
          setFlyout((prev) =>
            prev?.projectId === row.project.id ? null : { projectId: row.project.id, anchor },
          );
        }
        return;
      }
      if (row.kind === 'more') {
        // The "more" row disappears once its sessions render, so hand focus to
        // the first newly revealed session rather than letting it fall to body.
        // Index against the rows the current filter actually shows.
        const shown = row.project.sessions.filter((s) => matchesHubFilter(s.state, filter));
        const firstHidden = shown[sessionPageSize]?.id;
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
    [onOpenSession, onOpenProject, filter, railCollapsed, sessionPageSize],
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
          kind: 'action',
          id: 'rename',
          label: t('common.rename'),
          icon: 'pencil',
          onSelect: () => setRenaming(menuRow.key),
        });
      }
      if (onNewSession) {
        items.push({
          kind: 'action',
          id: 'new-session',
          label: t('hub.newSession'),
          icon: 'plus',
          onSelect: () => onNewSession(menuRow.project),
        });
      }
      if (onDeleteProject) {
        items.push({
          kind: 'action',
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
        kind: 'action',
        id: 'rename',
        label: t('common.rename'),
        icon: 'pencil',
        onSelect: () => setRenaming(menuRow.key),
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

  const flyoutProject = flyout
    ? (visible.find((entry) => entry.project.id === flyout.projectId)?.project ?? null)
    : null;

  const flyoutItems = useMemo<HubMenuItem[]>(() => {
    if (!flyoutProject) return [];
    const items: HubMenuItem[] = flyoutProject.sessions.map((session) => ({
      kind: 'radio',
      id: session.id,
      label: session.title,
      icon: 'file',
      checked: session.id === currentSessionId,
      onSelect: () => onOpenSession(session),
    }));
    if (onNewSession) {
      items.push({
        kind: 'action',
        id: 'new-session',
        label: t('hub.newSession'),
        icon: 'plus',
        onSelect: () => onNewSession(flyoutProject),
      });
    }
    return items;
  }, [flyoutProject, currentSessionId, onOpenSession, onNewSession, t]);

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
          <Icon name="sort" size={15} />
        </button>
      </div>

      {openWork}

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
          const hasCurrent =
            currentSessionId !== null &&
            entry.project.sessions.some((session) => session.id === currentSessionId);
          return (
            <div key={entry.project.id} className="hub-tree__node">
              <div
                ref={registerRow(projectKey)}
                role="treeitem"
                // A collapsed project has no rendered group to expand, and
                // claiming otherwise would promise screen readers a subtree
                // that is not there.
                {...(railCollapsed
                  ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': flyout?.projectId === entry.project.id }
                  : { 'aria-expanded': entry.open })}
                {...(railCollapsed ? { 'aria-label': entry.project.name } : {})}
                data-tooltip={entry.project.name}
                data-initial={initialGlyph(entry.project.name)}
                data-current={hasCurrent ? 'true' : 'false'}
                onMouseEnter={
                  railCollapsed
                    ? (event) => {
                        const anchor = event.currentTarget;
                        cancelHoverFlyout();
                        hoverTimerRef.current = setTimeout(() => {
                          hoverTimerRef.current = null;
                          setFlyout({ projectId: entry.project.id, anchor });
                        }, FLYOUT_HOVER_DELAY_MS);
                      }
                    : undefined
                }
                onMouseLeave={railCollapsed ? cancelHoverFlyout : undefined}
                aria-level={1}
                {...(!entry.open && rollupKey
                  ? { 'aria-describedby': `hub-state-${entry.project.id}` }
                  : {})}
                tabIndex={cursor === projectIndex ? 0 : -1}
                data-testid={`hub-project-${entry.project.id}`}
                data-row-key={projectKey}
                data-project-id={entry.project.id}
                data-state={rollup}
                className={`hub-row hub-row--project readable-tooltip${
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
                data-open={entry.open && !railCollapsed}
                hidden={!entry.open || railCollapsed}
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
                      data-tooltip={session.title}
                      className={`hub-row hub-row--session readable-tooltip${
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
                    <Icon name="chevron-right" size={12} strokeWidth={1.8} />
                    <span>{t('hub.showMoreSessions', { count: String(entry.hiddenCount) })}</span>
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

      {flyout && flyoutProject && flyoutItems.length > 0 ? (
        <HubMenu
          title={flyoutProject.name}
          items={flyoutItems}
          anchor={flyout.anchor}
          returnFocusTo={rowRefs.current.get(`p:${flyoutProject.id}`) ?? flyout.anchor}
          testId="hub-project-flyout"
          onClose={() => setFlyout(null)}
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
