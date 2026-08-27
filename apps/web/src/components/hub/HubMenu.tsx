// Floating menu for the hub rail: row overflow menus and the sort dropdown.
//
// The rail's scroller clips absolutely positioned children, so the menu is
// portalled to the body with a viewport-clamped fixed rect. Focus moves into
// the menu on open and is handed BACK to the row that owns the menu on close -
// the tree's roving tabindex is meaningless if a dismissed menu drops focus to
// the body.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from '../Icon';

const MENU_MARGIN = 10;
const MENU_GAP = 6;
const MENU_WIDTH = 208;

export interface HubMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Heading rendered above the items, as in the mockup's labelled menus. */
  title: string;
  items: HubMenuItem[];
  anchor: HTMLElement | null;
  /**
   * Where focus goes when the menu closes. Defaults to the anchor; row menus
   * pass the row so focus lands on the treeitem, not on a hover-only button.
   */
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  testId?: string;
}

export function HubMenu({ title, items, anchor, returnFocusTo, onClose, testId }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  // Read the return target through a ref so a re-render cannot change where a
  // close lands mid-interaction.
  const returnRef = useRef<HTMLElement | null>(returnFocusTo ?? anchor);
  returnRef.current = returnFocusTo ?? anchor;

  const close = useCallback(
    (restoreFocus: boolean) => {
      const back = returnRef.current;
      onClose();
      if (restoreFocus && back?.isConnected) back.focus();
    },
    [onClose],
  );

  useLayoutEffect(() => {
    if (!anchor) return undefined;
    const place = () => {
      const box = anchor.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 0;
      const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
      const below = box.bottom + MENU_GAP;
      const top =
        below + height > window.innerHeight - MENU_MARGIN
          ? Math.max(MENU_MARGIN, box.top - height - MENU_GAP)
          : below;
      setRect({ left: Math.min(Math.max(MENU_MARGIN, box.left), maxLeft), top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, items.length]);

  // Focus the first item once the menu has a position, so the browser does not
  // scroll to a menu still parked at the origin. Tracked as a boolean so that
  // re-placing the menu on scroll cannot steal focus back from a later item.
  const placed = rect !== null;
  useEffect(() => {
    if (!placed) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      // A click elsewhere is a deliberate move away, so focus stays where the
      // pointer put it rather than snapping back to the row.
      close(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [anchor, close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        nodes[Math.min(index + 1, nodes.length - 1)]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        nodes[Math.max(index - 1, 0)]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        nodes[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        nodes[nodes.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // A menu is modal enough that tabbing out is a dismissal, not a way to
        // land somewhere unpredictable behind it.
        event.preventDefault();
        close(true);
        break;
      default:
        break;
    }
  };

  if (typeof document === 'undefined' || !anchor) return null;

  const body: ReactNode = (
    <div
      ref={menuRef}
      className="hub-menu"
      role="menu"
      aria-label={title}
      data-testid={testId}
      style={rect ? { left: `${rect.left}px`, top: `${rect.top}px` } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <p className="hub-menu__label">{title}</p>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`hub-menu__item${item.danger ? ' hub-menu__item--danger' : ''}`}
          data-testid={testId ? `${testId}-${item.id}` : undefined}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          onClick={() => {
            close(true);
            item.onSelect();
          }}
        >
          {item.icon ? <Icon name={item.icon} size={15} /> : null}
          <span className="hub-menu__text">{item.label}</span>
          {item.shortcut ? <kbd className="hub-menu__shortcut">{item.shortcut}</kbd> : null}
          {item.checked ? (
            <span className="hub-menu__check" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );

  return createPortal(body, document.body);
}
