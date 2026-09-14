// Rail footer for the entry hub.
//
// The approved mockup keeps the entry destinations out of the tree and puts
// them behind a "library" menu at the foot of the rail, with the
// user/workspace row underneath (`.tmp/design/main-hub/index.html:1106-1116`).
// This is the only place the hub navigates away from home, so every
// destination the old icon rail owned stays reachable without reinstating a
// second always-visible rail next to the project tree.

import { useCallback, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n';
import type { AppTheme } from '../../types';
import { Icon, type IconName } from '../Icon';
import { HubMenu, type HubMenuItem } from './HubMenu';
import { HUB_THEME_DIALOG_ID, HubThemeModal } from './HubThemeModal';
import type { HubDestination } from './types';

interface Props {
  /** Windows account running the local daemon, when available. */
  username: string | null;
  /** Open one of the entry destinations. */
  onOpenDestination: (destination: HubDestination) => void;
  /** Open the settings surface (gear in the destination row). */
  onOpenSettings: () => void;
  /** Open the surface that owns the workspace storage roots. */
  onOpenWorkspaceFolder: () => void;
  /** The theme the app config currently holds (absent = default). */
  theme?: AppTheme | undefined;
  /** App's appearance path: persists the theme and applies it live. */
  onThemeChange: (theme: AppTheme) => void;
  /** Name of the active workspace, when the user has configured one. */
  workspaceName?: string | null;
}

const DESTINATION_ICON: Record<HubDestination, IconName> = {
  projects: 'folder',
  tasks: 'kanban',
  'design-systems': 'blocks',
  plugins: 'puzzle',
  integrations: 'link',
};

/**
 * Initials for the workspace avatar. Two words give one letter each, a single
 * word gives its first two characters, so Latin and CJK names both land on a
 * readable two-glyph mark.
 */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return Array.from(words[0] ?? '').slice(0, 2).join('').toUpperCase();
  return `${Array.from(words[0] ?? '')[0] ?? ''}${Array.from(words[1] ?? '')[0] ?? ''}`.toUpperCase();
}

export function HubRailFooter({
  username,
  onOpenDestination,
  onOpenSettings,
  onOpenWorkspaceFolder,
  theme,
  onThemeChange,
  workspaceName = null,
}: Props) {
  const t = useT();
  const [openMenu, setOpenMenu] = useState<'library' | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const libraryRef = useRef<HTMLButtonElement | null>(null);
  const themeRef = useRef<HTMLButtonElement | null>(null);

  // The shared HubMenu owns dismissal and hands focus back to the trigger
  // itself (Escape and item selection restore it; an outside click does not).
  const closeLibrary = useCallback(() => setOpenMenu(null), []);
  // The theme modal owns its own dismissal (Escape, backdrop, Done) and hands
  // focus back to the Theme row through the ref it is given.
  const closeTheme = useCallback(() => setThemeOpen(false), []);

  // Projects remains reachable in the library menu without adding a separate
  // row above the reference footer hierarchy. The workspace folder joins the
  // same menu: the user row is presentational now, and the library menu is the
  // footer's only surface that already holds destination items, so this keeps
  // the storage-roots settings section reachable in one click.
  const libraryItems = useMemo<HubMenuItem[]>(
    () => [
      ...(['projects', 'tasks', 'design-systems', 'plugins', 'integrations'] as const).map((destination): HubMenuItem => ({
        kind: 'action',
        id: destination,
        icon: DESTINATION_ICON[destination],
        label: t(
          destination === 'projects'
            ? 'entry.navProjects'
            : destination === 'tasks'
              ? 'entry.navTasks'
              : destination === 'design-systems'
              ? 'entry.navDesignSystems'
              : destination === 'plugins'
                ? 'entry.navPlugins'
                : 'entry.navIntegrations',
        ),
        testId: `hub-library-${destination}`,
        onSelect: () => onOpenDestination(destination),
      })),
      {
        kind: 'action',
        id: 'workspace-folder',
        icon: 'folder' as IconName,
        label: t('hub.workspaceFolder'),
        testId: 'hub-workspace-folder',
        onSelect: onOpenWorkspaceFolder,
      },
    ],
    [onOpenDestination, onOpenWorkspaceFolder, t],
  );

  const userLabel = username?.trim() || t('hub.localUserUnavailable');
  const workspaceLabel = workspaceName?.trim() || t('hub.localWorkspace');

  return (
    <div className="hub__foot" data-testid="hub-rail-footer">
      {/* Theme sits directly above Library and opens its modal in one click:
          no settings screen, no submenu. Same row chrome as Library so the two
          read as one stack; the modal itself is body-portalled and so, like
          the Library menu, clears the rail box in both rail states. */}
      <button
        ref={themeRef}
        type="button"
        className="hub__dest-more"
        data-testid="hub-theme"
        aria-haspopup="dialog"
        aria-expanded={themeOpen}
        aria-controls={themeOpen ? HUB_THEME_DIALOG_ID : undefined}
        onClick={() => setThemeOpen(true)}
      >
        <Icon name="sun-moon" size={16} strokeWidth={1.6} />
        <span>{t('hub.theme')}</span>
      </button>
      <HubThemeModal
        open={themeOpen}
        theme={theme}
        onThemeChange={onThemeChange}
        onClose={closeTheme}
        returnFocusRef={themeRef}
      />
      <div className="hub__dest-row">
        <div className="hub__menu-anchor">
          <button
            ref={libraryRef}
            type="button"
            className="hub__dest-more"
            data-testid="hub-library"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'library'}
            aria-controls={openMenu === 'library' ? 'hub-library' : undefined}
            onClick={() => setOpenMenu((current) => (current === 'library' ? null : 'library'))}
          >
            <Icon name="swatch" size={16} strokeWidth={1.6} />
            <span>{t('hub.library')}</span>
          </button>
          {/* Rail-owned overlays escape the rail's `overflow: hidden` box through
              the shared placer: portalled to the body, fixed, viewport-clamped
              and flipped above the anchor at the floor, in both rail states. */}
          {openMenu === 'library' ? (
            <HubMenu
              id="hub-library"
              title={t('hub.library')}
              items={libraryItems}
              anchor={libraryRef.current}
              testId="hub-library-menu"
              onClose={closeLibrary}
            />
          ) : null}
        </div>
        <button
          type="button"
          className="hub__dest"
          data-testid="hub-footer-settings"
          aria-label={t('avatar.settings')}
          title={t('avatar.settings')}
          onClick={onOpenSettings}
        >
          <Icon name="settings" size={21} strokeWidth={1.7} />
        </button>
      </div>
      {/* Presentational identity only. The row used to open a menu holding
          settings and the workspace folder; settings now lives on the footer
          gear beside it and in the topbar, and the workspace folder moved into
          the library menu, so nothing here is interactive. */}
      <div className="hub__user-row" data-testid="hub-workspace-row">
        <span className="hub__user-avatar" aria-hidden="true">
          {workspaceInitials(userLabel)}
        </span>
        <span className="hub__user-meta">
          <span className="hub__user-name">{userLabel}</span>
          <span className="hub__user-sub">{workspaceLabel}</span>
        </span>
      </div>
    </div>
  );
}
