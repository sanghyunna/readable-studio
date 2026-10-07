// The hub rail's content: brand, New Project, search, the session tree, the
// footer and the resize handle. AppInner mounts this once beside the keyed
// surface; every route reads the same controller and exposes the same actions.
// The shell owns layout, including the rail's resizer and transient overlays.

import { useEffect } from 'react';
import { useT } from '../../i18n';
import type { AppTheme } from '../../types';
import { ProjectRail } from '../ProjectRail';
import { Icon } from '../Icon';
import { HUB_SESSION_DRAG_TYPE } from './HubSessionTree';
import { HubOpenWork } from './HubOpenWork';
import { HubRailFooter } from './HubRailFooter';
import { useHubRail } from './HubRailContext';
import { HubSessionTree } from './HubSessionTree';
import type { HubDestination } from './types';
import { HUB_RAIL_WIDTH_MAX, HUB_RAIL_WIDTH_MIN } from './useHubRailController';

export interface HubRailProps {
  projectsLoading?: boolean;
  /**
   * False until a project read has succeeded (startup, daemon reconnect).
   * An empty list is then unknown, not empty, and the tree stays silent.
   */
  projectsKnown?: boolean;
  /** Windows account running the local daemon, when available. */
  username?: string | null;
  /** Name of the active workspace, rendered in the rail footer row. */
  workspaceName?: string | null;
  /** Brand click returns to the hub itself; entry chrome owns the target. */
  onGoHome?: (() => void) | undefined;
  /** Navigate to one of the entry destinations (rail footer library menu). */
  onOpenDestination?: ((destination: HubDestination) => void) | undefined;
  /** Open settings (rail footer gear and workspace menu). */
  onOpenSettings?: (() => void) | undefined;
  /** Open the surface that owns the workspace storage roots. */
  onOpenWorkspaceFolder?: (() => void) | undefined;
  /** The theme the app config currently holds (rail footer Theme row). */
  theme?: AppTheme | undefined;
  /** App's appearance path; the footer's theme modal drives it. */
  onThemeChange?: ((theme: AppTheme) => void) | undefined;
}

export function HubRail({
  projectsLoading = false,
  projectsKnown: _projectsKnown = true,
  username = null,
  workspaceName = null,
  onGoHome,
  onOpenDestination,
  onOpenSettings,
  onOpenWorkspaceFolder,
  theme,
  onThemeChange,
}: HubRailProps) {
  const t = useT();
  const rail = useHubRail();
  const { railCollapsed, narrow, railWidth, query, setRailWidth } = rail;

  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="hub-nav"]');
    const onDragOver = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes(HUB_SESSION_DRAG_TYPE)) return;
      event.preventDefault();
      // React delegates at the root; let a tree target reach its own drop
      // handler before it stops propagation. Blank chrome has no such handler.
      if (!(event.target instanceof Element) || !event.target.closest('[data-row-key], [data-testid="hub-section-recents"]')) {
        event.stopPropagation();
      }
    };
    nav?.addEventListener('dragover', onDragOver);
    return () => nav?.removeEventListener('dragover', onDragOver);
  }, []);

  return (
    <>
      <ProjectRail
        surface="hub"
        expanded={!railCollapsed}
        className="hub__nav"
        ariaLabel={t('hub.treeLabel')}
        headClassName="hub__nav-head"
        toggleClassName="hub__rail-toggle"
        toggleLabel={t(railCollapsed ? 'entry.navExpand' : 'entry.navCollapse')}
        toggleTestId="hub-rail-toggle"
        testId="hub-nav"
        onToggle={rail.toggleRail}
        toggleDisabled={narrow}
        toggleAriaPressed={railCollapsed}
        toggleIconSize={18}
        toggleStrokeWidth={1.8}
        tooltipPlacement="bottom"
        header={(
          <button
            type="button"
            className="hub__brand readable-tooltip"
            data-testid="hub-brand"
            aria-label={t('entry.navHome')}
            /* The "Home" affordance rides on the canonical TooltipLayer. The
               old in-flow hover hint sat between the wordmark and the row end,
               which is exactly where the collapse toggle now lives. */
            data-tooltip={t('entry.navHome')}
            data-tooltip-placement="bottom"
            onClick={() => onGoHome?.()}
          >
            <img className="hub__brand-mark" src="/logo.svg" alt="" width={22} height={22} draggable={false} aria-hidden="true" />
            <span className="hub__brand-name">{t('app.brand')}</span>
          </button>
        )}
      >
        <div className="hub__nav-actions">
          <button
            type="button"
            className="hub__new-session"
            data-testid="hub-new-session"
            aria-label={t('hub.newSession')}
            onClick={() => rail.newSession()}
          >
            <Icon name="pencil" size={16} />
            <span>{t('hub.newSession')}</span>
          </button>
          <div className="hub__search-wrap">
            <input
              ref={rail.searchRef}
              type="search"
              className="hub__search"
              data-testid="hub-search"
              value={query}
              aria-label={t('hub.searchPlaceholder')}
              placeholder={t('hub.searchPlaceholder')}
              onChange={(event) => rail.setQuery(event.target.value)}
              onMouseDown={rail.expandRailForSearch}
              onFocus={rail.expandRailForSearch}
            />
            <button type="button" className="hub__search-shortcut" data-testid="hub-open-palette" aria-label={t('hub.paletteOpen')} onClick={rail.openPalette}>
              <kbd className="hub-kbd">Ctrl K</kbd>
            </button>
          </div>
        </div>
        <div className="hub__nav-divider" role="separator" />
        {projectsLoading ? (
          <p className="hub__nav-loading">{t('common.loading')}</p>
        ) : (
          <div className="hub__nav-list">
            <HubSessionTree
              key={query.trim() ? 'filtered' : 'all'}
              tree={rail.tree}
              moveFolders={rail.allTree.folders}
              railStatus={rail.railStatus}
              selectedFolderId={rail.selectedFolder?.id ?? null}
              onSelectFolder={rail.selectFolder}
              onClearSelectedFolder={rail.clearSelectedFolder}
              onCreateFolder={(name) => { void rail.createFolder(name); }}
              onMoveSession={(session, folderId) => { void rail.moveSession(session, folderId); }}
              searching={Boolean(query.trim())}
              onClearFilter={() => rail.setQuery('')}
              compactByDefault
              openWork={
                <HubOpenWork
                  items={rail.openWork}
                  currentSessionId={rail.currentSessionId}
                  onOpen={rail.openOpenWork}
                  onClose={rail.closeOpenWork}
                />
              }
              collapsed={railCollapsed}
              currentSessionId={rail.currentSessionId}
              onOpenSession={rail.openSession}
              onPeekSession={rail.peekSession}
              onNewSession={rail.newSession}
              onRetrySessions={rail.retrySessions}
              onRenameSession={rail.renameSession}
              onDeleteSession={rail.deleteSession}
              onRenameFolder={(folder, name) => { void rail.renameFolder(folder, name); }}
              onDeleteFolder={(folder, policy) => { void rail.deleteFolder(folder, policy); }}
            />
          </div>
        )}
        {onOpenDestination && onOpenSettings && onOpenWorkspaceFolder && onThemeChange ? (
          <HubRailFooter
            username={username}
            onOpenDestination={onOpenDestination}
            onOpenSettings={onOpenSettings}
            onOpenWorkspaceFolder={onOpenWorkspaceFolder}
            theme={theme}
            onThemeChange={onThemeChange}
            workspaceName={workspaceName}
          />
        ) : null}
      </ProjectRail>

      <div
        className="hub__rail-resizer"
        role="separator"
        aria-label={t('hub.resizeRail')}
        aria-orientation="vertical"
        aria-valuemin={HUB_RAIL_WIDTH_MIN}
        aria-valuemax={HUB_RAIL_WIDTH_MAX}
        aria-valuenow={railWidth}
        tabIndex={railCollapsed || narrow ? -1 : 0}
        hidden={railCollapsed || narrow}
        data-testid="hub-rail-resizer"
        onPointerDown={rail.beginRailResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setRailWidth(railWidth - 16);
          else if (event.key === 'ArrowRight') setRailWidth(railWidth + 16);
          else if (event.key === 'Home') setRailWidth(HUB_RAIL_WIDTH_MIN);
          else if (event.key === 'End') setRailWidth(HUB_RAIL_WIDTH_MAX);
          else return;
          event.preventDefault();
        }}
      />
    </>
  );
}
