// Help launcher for the entry surfaces.
//
// The approved mockup keeps a help control in the topbar
// (`.tmp/design/main-hub/index.html:791`); this is that control. It opens a
// small menu with the project's own support destinations — no promotional
// links, only the repository's help and feature-request entry points, opened
// through the same host/daemon bridge every other external link uses.

import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';
import { openExternalUrl } from '../providers/registry';
import { Icon } from './Icon';

const REPO_URL = 'https://github.com/sanghyunna/readable-studio';
const HELP_URL = `${REPO_URL}/issues`;
const FEATURE_REQUEST_URL = `${REPO_URL}/issues/new`;

export function EntryHelpMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const items = [
    { id: 'help', label: t('entry.helpGetHelp'), url: HELP_URL },
    { id: 'feature', label: t('entry.helpSubmitFeature'), url: FEATURE_REQUEST_URL },
  ];

  return (
    <div className="entry-help-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="entry-help-menu__trigger"
        data-testid="entry-help-trigger"
        aria-label={t('entry.helpAria')}
        title={t('entry.helpAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="help-circle" size={17} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="entry-help-menu__popover"
          role="menu"
          aria-label={t('entry.helpMenuAria')}
          data-testid="entry-help-menu"
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
              close(true);
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="entry-help-menu__item"
              data-testid={`entry-help-${item.id}`}
              onClick={() => {
                close(false);
                void openExternalUrl(item.url);
              }}
            >
              <Icon name="github" size={14} />
              <span>{item.label}</span>
              <Icon name="external-link" size={12} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
