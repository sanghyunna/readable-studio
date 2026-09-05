// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand logo,
// followed by the primary destinations users expect to keep in reach:
// New project, home, projects, automations, design systems, plugins,
// and integrations. The rail footer previously carried the help launcher; the
// help menu was removed from the product entirely, so the footer is gone.
// Language, appearance and other account-scoped controls live in the Settings
// dialog, reachable from the hub rail footer gear.

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { ProjectRail } from './ProjectRail';
import { useT } from '../i18n';

export type EntryView =
  | 'home'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  /** When false the rail renders as the thin, always-visible collapsed strip. */
  open: boolean;
  /** Collapse the rail - called after a destination is chosen or the user dismisses it. */
  onClose: () => void;
  /** Expand the collapsed strip. The strip is a real control surface, so it
   *  carries its own expand affordance instead of relying on a floating
   *  button parked outside the panel. */
  onOpen?: () => void;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, tooltip, onClick, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </button>
  );
}

export function EntryNavRail({ view, onViewChange, onNewProject, open, onClose, onOpen }: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';

  // Once opened the rail stays docked (Manus-style); navigating between
  // destinations no longer collapses it.
  const selectView = (next: EntryView) => {
    onViewChange(next);
  };

  return (
    <ProjectRail
      surface="workspace"
      expanded={open}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      ariaLabel={t('entry.navPrimary')}
      headClassName="entry-nav-rail__brand"
      toggleClassName="entry-nav-rail__collapse"
      toggleLabel={t(open ? 'entry.navCollapse' : 'entry.navExpand')}
      toggleTestId="entry-nav-collapse"
      testId="entry-nav-rail"
      onToggle={open ? onClose : onOpen ?? onClose}
      header={(
        <button
          type="button"
          className="entry-nav-rail__logo"
          onClick={() => selectView('home')}
          aria-label={brandLabel}
          data-testid="entry-nav-logo"
        >
          <img src="/app-icon.svg" alt="" className="entry-nav-rail__logo-img" draggable={false} />
        </button>
      )}
    >
      <div className="entry-nav-rail__group">
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />
        <NavButton
          ariaLabel={t('entry.navNewProject')}
          tooltip={t('entry.navNewProject')}
          onClick={onNewProject}
          testId="entry-nav-new-project"
        >
          <Icon name="plus" size={18} />
        </NavButton>
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          tooltip={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={18} />
        </NavButton>
        <NavButton
          active={view === 'projects'}
          ariaLabel={t('entry.navProjects')}
          tooltip={t('entry.navProjects')}
          onClick={() => selectView('projects')}
          testId="entry-nav-projects"
        >
          <Icon name="folder" size={18} />
        </NavButton>
        <NavButton
          active={view === 'tasks'}
          ariaLabel={t('entry.navTasks')}
          tooltip={t('entry.navTasks')}
          onClick={() => selectView('tasks')}
          testId="entry-nav-tasks"
        >
          <Icon name="kanban" size={18} />
        </NavButton>
        <NavButton
          active={view === 'design-systems'}
          ariaLabel={t('entry.navDesignSystems')}
          tooltip={t('entry.navDesignSystems')}
          onClick={() => selectView('design-systems')}
          testId="entry-nav-design-systems"
        >
          <Icon name="blocks" size={18} />
        </NavButton>
        <NavButton
          active={view === 'plugins'}
          ariaLabel={t('entry.navPlugins')}
          tooltip={t('entry.navPlugins')}
          onClick={() => selectView('plugins')}
          testId="entry-nav-plugins"
        >
          <Icon name="grid" size={18} />
        </NavButton>
        <NavButton
          active={view === 'integrations'}
          ariaLabel={t('entry.navIntegrations')}
          tooltip={t('entry.navIntegrations')}
          onClick={() => selectView('integrations')}
          testId="entry-nav-integrations"
        >
          <Icon name="link" size={18} />
        </NavButton>
      </div>
    </ProjectRail>
  );
}
