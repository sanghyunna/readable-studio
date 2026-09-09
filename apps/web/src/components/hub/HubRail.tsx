// The hub rail's content: brand, New Project, search, the session tree, the
// footer and the resize handle. AppInner mounts this once beside the keyed
// surface; every route reads the same controller and exposes the same actions.
// The shell owns layout, including the rail's resizer and transient overlays.

import { useT } from '../../i18n';
import { ProjectRail } from '../ProjectRail';
import { HubOpenWork } from './HubOpenWork';
import { HubRailFooter } from './HubRailFooter';
import { useHubRail } from './HubRailContext';
import { HubSessionTree } from './HubSessionTree';
import type { HubDestination } from './types';
import { HUB_RAIL_WIDTH_MAX, HUB_RAIL_WIDTH_MIN } from './useHubRailController';

export interface HubRailProps {
  projectsLoading?: boolean;
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
}

export function HubRail({
  projectsLoading = false,
  username = null,
  workspaceName = null,
  onGoHome,
  onOpenDestination,
  onOpenSettings,
  onOpenWorkspaceFolder,
}: HubRailProps) {
  const t = useT();
  const rail = useHubRail();
  const { railCollapsed, narrow, railWidth, query, setRailWidth } = rail;

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
            className="hub__new-project"
            data-testid="hub-new-project"
            onClick={rail.newProject}
          >
            {t('entry.navNewProject')}
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
        {projectsLoading ? (
          <p className="hub__nav-loading">{t('common.loading')}</p>
        ) : (
          <div className="hub__nav-list">
            <HubSessionTree
              key={query.trim() ? 'filtered' : 'all'}
              projects={rail.tree}
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
              pendingNewSessionProjectId={rail.creatingSessionFor}
              {...(rail.openProject ? { onOpenProject: rail.openProject } : {})}
              onRenameSession={rail.renameSession}
              onDeleteSession={rail.deleteSession}
              {...(rail.renameProject ? { onRenameProject: rail.renameProject } : {})}
              {...(rail.deleteProject ? { onDeleteProject: rail.deleteProject } : {})}
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
