// Body-portaled colour popover shared by every swatch in the direct-edit
// inspector (text colour in the quick-format panel, fill/border in the quick
// shape panel and in the Appearance section).
//
// Why a portal: the left inspector clips its children twice — `.root` is
// `overflow: hidden` and `.scroll` is `overflow-y: auto`
// (ManualEditLeftInspector.module.css). An absolutely-positioned popover inside
// either box is cut off at the panel edge, which is the same failure the rail
// overlays and the theme/Databricks modals hit before they moved to body
// portals. The popover therefore mounts on `document.body` as a fixed layer and
// is placed from the swatch's measured viewport rect through the shared
// `placePopover` maths (flip above when there is no room below, clamp to the
// viewport gutter). It re-measures on scroll/resize so it tracks the swatch
// while the panel scrolls.
//
// Presence: the portal stays mounted and `open` toggles a class
// (apps/web/AGENTS.md: a React unmount skips the exit transition). While
// closed the node is `inert` + `aria-hidden` so it leaves hit testing, tab
// order and the accessibility tree the moment the exit starts.
//
// Single-open: a module-level registry closes whichever popover was open when
// another one opens. Pointer activation already produced that through the
// outside-mousedown listener, but keyboard/focus activation never does, so the
// invariant lives here rather than in the event stream.
//
// Access contract: focus moves into the popover on open; Escape closes it and
// returns focus to the trigger; a mousedown outside both the trigger and the
// popover dismisses it.
import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type MutableRefObject, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_SWATCH_COLORS, normalizeColorForPicker } from './ManualEditPanel';
import { placePopover } from './popoverPlacement';
import styles from './ManualEditColorPopover.module.css';

export const MANUAL_EDIT_COLOR_POPOVER_TESTID = 'manual-edit-color-popover';

let activeClose: MutableRefObject<() => void> | null = null;

export function ManualEditColorPopover({
  open,
  anchorRef,
  label,
  value,
  onChange,
  onClose,
}: {
  open: boolean;
  /** The swatch button that opened the popover; focus returns here on Escape. */
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    if (activeClose && activeClose !== closeRef) activeClose.current();
    activeClose = closeRef;
    return () => {
      if (activeClose === closeRef) activeClose = null;
    };
  }, [open]);

  useLayoutEffect(() => {
    // React 18 cannot serialize `inert` as a boolean prop; use the DOM API.
    // Applied before paint so the closing surface is never a live frame.
    popoverRef.current?.toggleAttribute('inert', !open);
  }, [open]);

  useLayoutEffect(() => {
    // The last position is kept on close so the exit fades in place.
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const rect = anchor.getBoundingClientRect();
      setPosition(placePopover(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: popover.offsetWidth, height: popover.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    // Focus enters the popover when the swatch opened it. ColorRow also opens
    // on its hex input's focus; stealing focus from that input mid-typing would
    // be a regression, so the input keeps focus in that case.
    if (document.activeElement === anchorRef.current) {
      popoverRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    }
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open, anchorRef, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popoverRef}
      className={`${styles.popover}${open ? ` ${styles.popoverOpen}` : ''}`}
      role="group"
      aria-label={label}
      aria-hidden={!open}
      data-testid={MANUAL_EDIT_COLOR_POPOVER_TESTID}
      data-state={open ? 'open' : 'closed'}
      style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
    >
      <div className={styles.grid}>
        {EDITOR_SWATCH_COLORS.map((hex) => (
          <button
            key={hex}
            type="button"
            className={styles.tile}
            style={{ '--swatch-color': hex } as CSSProperties}
            aria-label={hex}
            onClick={() => { onChange(hex); onClose(); anchorRef.current?.focus(); }}
          />
        ))}
      </div>
      <input
        type="color"
        className={styles.native}
        aria-label={label}
        value={normalizeColorForPicker(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>,
    document.body,
  );
}
