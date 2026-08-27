// Rail footer for the entry hub.
//
// The approved mockup keeps the entry destinations out of the tree and puts
// them behind a "library" menu at the foot of the rail, with the
// user/workspace row underneath (`.tmp/design/main-hub/index.html:1106-1116`).
// This is the only place the hub navigates away from home, so every
// destination the old icon rail owned stays reachable without reinstating a
// second always-visible rail next to the project tree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import type { HubDestination } from './types';

interface MenuItem {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  testId?: string;
}

interface Props {
  /** Open one of the entry destinations. */
  onOpenDestination: (destination: HubDestination) => void;
  /** Open the settings surface (gear in the destination row). */
  onOpenSettings: () => void;
  /** Open the surface that owns the workspace storage roots. */
  onOpenWorkspaceFolder: () => void;
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
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]!.slice(0, 1)}${words[1]!.slice(0, 1)}`.toUpperCase();
}

/**
 * Menu model from the mockup (`index.html:1825-1865`): opening focuses the
 * first item, Up/Down move, Escape closes and returns focus to the trigger,
 * and a pointer press outside dismisses it.
 */
function HubMenu({
  id,
  label,
  items,
  open,
  onClose,
  triggerRef,
}: {
  id: string;
  label: string;
  items: MenuItem[];
  open: boolean;
  onClose: (restoreFocus: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const node = menuRef.current;
    node?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      id={id}
      className="hub__menu"
      role="menu"
      aria-label={label}
      data-testid={`${id}-menu`}
      onKeyDown={(event) => {
        const buttons = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          buttons[Math.max(index - 1, 0)]?.focus();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="hub__menu-label">{label}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="hub__menu-item"
          {...(item.testId ? { 'data-testid': item.testId } : {})}
          onClick={() => {
            onClose(false);
            item.onSelect();
          }}
        >
          <Icon name={item.icon} size={15} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function HubRailFooter({
  onOpenDestination,
  onOpenSettings,
  onOpenWorkspaceFolder,
  workspaceName = null,
}: Props) {
  const t = useT();
  const [openMenu, setOpenMenu] = useState<'library' | 'workspace' | null>(null);
  const libraryRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLButtonElement | null>(null);

  const closeLibrary = useCallback((restoreFocus: boolean) => {
    setOpenMenu(null);
    if (restoreFocus) libraryRef.current?.focus();
  }, []);
  const closeWorkspace = useCallback((restoreFocus: boolean) => {
    setOpenMenu(null);
    if (restoreFocus) workspaceRef.current?.focus();
  }, []);

  // The mockup's library menu carries the four management destinations;
  // Projects stays a first-class row above the footer and Help lives in the
  // topbar, exactly as the approved composition places them.
  const libraryItems = useMemo<MenuItem[]>(
    () =>
      (['tasks', 'design-systems', 'plugins', 'integrations'] as const).map((destination) => ({
        id: destination,
        icon: DESTINATION_ICON[destination],
        label: t(
          destination === 'tasks'
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
    [onOpenDestination, t],
  );

  const workspaceLabel = workspaceName?.trim() || t('hub.localWorkspace');
  const workspaceSub = workspaceName?.trim() ? t('hub.localWorkspace') : null;

  const workspaceItems = useMemo<MenuItem[]>(
    () => [
      {
        id: 'settings',
        icon: 'settings',
        label: t('avatar.settings'),
        testId: 'hub-workspace-settings',
        onSelect: onOpenSettings,
      },
      {
        id: 'workspace-folder',
        icon: 'folder',
        label: t('hub.workspaceFolder'),
        testId: 'hub-workspace-folder',
        onSelect: onOpenWorkspaceFolder,
      },
    ],
    [onOpenSettings, onOpenWorkspaceFolder, t],
  );

  return (
    <div className="hub__foot" data-testid="hub-rail-footer">
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
            <Icon name="layers-filled" size={16} />
            <span>{t('hub.library')}</span>
          </button>
          <HubMenu
            id="hub-library"
            label={t('hub.library')}
            items={libraryItems}
            open={openMenu === 'library'}
            onClose={closeLibrary}
            triggerRef={libraryRef}
          />
        </div>
        <button
          type="button"
          className="hub__dest"
          data-testid="hub-footer-settings"
          aria-label={t('avatar.settings')}
          title={t('avatar.settings')}
          onClick={onOpenSettings}
        >
          <Icon name="settings" size={17} />
        </button>
      </div>
      <div className="hub__menu-anchor">
        <button
          ref={workspaceRef}
          type="button"
          className="hub__user-row"
          data-testid="hub-workspace-row"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'workspace'}
          aria-controls={openMenu === 'workspace' ? 'hub-workspace' : undefined}
          onClick={() => setOpenMenu((current) => (current === 'workspace' ? null : 'workspace'))}
        >
          <span className="hub__user-avatar" aria-hidden="true">
            {workspaceInitials(workspaceLabel)}
          </span>
          <span className="hub__user-meta">
            <span className="hub__user-name">{workspaceLabel}</span>
            {workspaceSub ? <span className="hub__user-sub">{workspaceSub}</span> : null}
          </span>
        </button>
        <HubMenu
          id="hub-workspace"
          label={workspaceLabel}
          items={workspaceItems}
          open={openMenu === 'workspace'}
          onClose={closeWorkspace}
          triggerRef={workspaceRef}
        />
      </div>
    </div>
  );
}
