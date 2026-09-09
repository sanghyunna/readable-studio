// Floating menu for the hub rail: row overflow menus, the collapsed-rail
// project flyout, the sort dropdown and the footer's Library menu.
//
// The rail is an `overflow: hidden` glass box (44px wide when collapsed), so
// any menu left inside it is clipped. EVERY rail-owned menu therefore goes
// through this one placer: it is portalled to the body with a
// viewport-clamped fixed rect that flips above its anchor near the floor. Focus moves into
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
const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const SELECTED_ITEM_STYLE = {
  background: 'var(--selected-soft)',
  color: 'var(--selected)',
} as const;

type HubMenuItemBase = {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly shortcut?: string;
  readonly danger?: boolean;
  /** Overrides the derived `${menuTestId}-${id}` hook for callers with stable ids. */
  readonly testId?: string;
  readonly onSelect: () => void;
};

type HubMenuActionItem = HubMenuItemBase & {
  readonly kind: 'action';
};

type HubMenuRadioItem = HubMenuItemBase & {
  readonly kind: 'radio';
  readonly checked: boolean;
};

type HubMenuToggleItem = HubMenuItemBase & {
  readonly kind: 'toggle';
  readonly checked: boolean;
  readonly onLabel: string;
  readonly offLabel: string;
};

export type HubMenuItem = HubMenuActionItem | HubMenuRadioItem | HubMenuToggleItem;

interface Props {
  /** DOM id, so a trigger can point `aria-controls` at the portalled menu. */
  id?: string;
  /** Heading rendered above the items, as in the mockup's labelled menus. */
  title: string;
  items: readonly HubMenuItem[];
  anchor: HTMLElement | null;
  /**
   * Pointer position for a context menu. When present the menu opens AT the
   * pointer instead of under the anchor rect; the anchor is still needed for
   * focus return and for click-outside ownership.
   */
  point?: { x: number; y: number } | null;
  /**
   * Where focus goes when the menu closes. Defaults to the anchor; row menus
   * pass the row so focus lands on the treeitem, not on a hover-only button.
   */
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  testId?: string;
}

export function HubMenu({ id, title, items, anchor, point = null, returnFocusTo, onClose, testId }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeAheadRef = useRef('');
  const typeAheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      // A context menu hangs off the pointer, so its "anchor rect" is the
      // pointer itself - the same clamp then keeps it inside the viewport.
      const left = point ? point.x : box.left;
      const openBelowFrom = point ? point.y : box.bottom;
      const openAboveFrom = point ? point.y : box.top;
      const below = openBelowFrom + MENU_GAP;
      const top =
        below + height > window.innerHeight - MENU_MARGIN
          ? Math.max(MENU_MARGIN, openAboveFrom - height - MENU_GAP)
          : below;
      setRect({ left: Math.min(Math.max(MENU_MARGIN, left), maxLeft), top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, items.length, point]);

  // Focus the first item once the menu has a position, so the browser does not
  // scroll to a menu still parked at the origin. Tracked as a boolean so that
  // re-placing the menu on scroll cannot steal focus back from a later item.
  const placed = rect !== null;
  useEffect(() => {
    if (!placed) return;
    menuRef.current?.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)?.focus();
  }, [placed]);

  useEffect(
    () => () => {
      if (typeAheadTimerRef.current) clearTimeout(typeAheadTimerRef.current);
    },
    [],
  );

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
      menuRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? [],
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
          const match = nodes.find((node) =>
            node.textContent?.trim().toLocaleLowerCase().startsWith(typeAheadRef.current),
          );
          match?.focus();
        }
        break;
    }
  };

  if (typeof document === 'undefined' || !anchor) return null;

  const body: ReactNode = (
    <div
      ref={menuRef}
      id={id}
      className="hub-menu"
      role="menu"
      aria-label={title}
      data-testid={testId}
      style={rect ? { left: `${rect.left}px`, top: `${rect.top}px` } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <p className="hub-menu__label">{title}</p>
      {items.map((item) => {
        const presentation = (() => {
          switch (item.kind) {
            case 'action':
              return { role: 'menuitem' as const, checked: undefined, selected: false, state: null };
            case 'radio':
              return {
                role: 'menuitemradio' as const,
                checked: item.checked,
                selected: item.checked,
                state: null,
              };
            case 'toggle':
              return {
                role: 'menuitemcheckbox' as const,
                checked: item.checked,
                selected: item.checked,
                state: item.checked ? item.onLabel : item.offLabel,
              };
            default: {
              const exhaustive: never = item;
              return exhaustive;
            }
          }
        })();
        return (
          <button
            key={item.id}
            type="button"
            role={presentation.role}
            className={`hub-menu__item${item.danger ? ' hub-menu__item--danger' : ''}`}
            data-testid={item.testId ?? (testId ? `${testId}-${item.id}` : undefined)}
            aria-label={presentation.state ? `${item.label} ${presentation.state}` : undefined}
            aria-checked={presentation.checked}
            style={presentation.selected ? SELECTED_ITEM_STYLE : undefined}
            onClick={() => {
              close(true);
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={15} /> : null}
            <span className="hub-menu__text">{item.label}</span>
            {item.shortcut ? <kbd className="hub-menu__shortcut">{item.shortcut}</kbd> : null}
            {presentation.state ? (
              <span className="hub-menu__shortcut">{presentation.state}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  return createPortal(body, document.body);
}
