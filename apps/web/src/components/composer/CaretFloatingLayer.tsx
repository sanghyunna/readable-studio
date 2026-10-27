'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { CaretRect } from './LexicalComposerInput';
import {
  POPOVER_ANCHOR_GAP,
  POPOVER_VIEWPORT_MARGIN,
  placePopover,
} from '../popoverPlacement';

const GAP = 8; // gap between caret and popover edge
const MARGIN = 8; // viewport edge margin
const HARD_MAX_H = 460; // never taller than this
const MIN_W = 320;
const PREF_W = 420;

interface PopoverPos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

function visibleHorizontalBounds(boundary: DOMRect | null, viewportWidth: number, margin: number) {
  const viewportRight = Math.max(margin, viewportWidth - margin);
  const left = Math.max(margin, boundary ? boundary.left + MARGIN : margin);
  const right = Math.min(viewportRight, boundary ? boundary.right - MARGIN : viewportRight);
  return right > left ? { left, right } : { left: margin, right: viewportRight };
}

// Default ABOVE the caret (composer sits at panel bottom → above never
// occludes the input line); flip BELOW only when above lacks room. Clamp
// horizontally into the viewport. Cap height; the list scrolls internally.
function computePopoverPos(
  caret: CaretRect,
  size: { width: number; height: number } | null,
  boundary: DOMRect | null,
  preferredWidth: number,
): PopoverPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bounds = visibleHorizontalBounds(boundary, vw, MARGIN);
  const width = Math.min(preferredWidth, bounds.right - bounds.left);

  const spaceAbove = caret.top - GAP - MARGIN;
  const spaceBelow = vh - caret.bottom - GAP - MARGIN;

  const wantedH = size?.height ?? HARD_MAX_H;
  const aboveFits = spaceAbove >= Math.min(wantedH, 160);
  const placement: 'above' | 'below' =
    aboveFits || spaceAbove >= spaceBelow ? 'above' : 'below';

  const space = placement === 'above' ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(120, Math.min(HARD_MAX_H, space));

  let top: number;
  if (placement === 'above') {
    const h = Math.min(wantedH, maxHeight);
    top = caret.top - GAP - h;
    if (top < MARGIN) top = MARGIN;
  } else {
    top = caret.bottom + GAP;
  }

  const left = Math.min(Math.max(caret.left, bounds.left), bounds.right - width);

  return { left, top, width, maxHeight, placement };
}

function computeControlPopoverPos(
  control: DOMRect,
  size: { width: number; height: number } | null,
  boundary: DOMRect | null,
  preferredWidth: number | undefined,
): PopoverPos {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const measured = size ?? { width: preferredWidth ?? PREF_W, height: HARD_MAX_H };
  const bounds = visibleHorizontalBounds(boundary, viewport.width, POPOVER_VIEWPORT_MARGIN);
  const width = Math.min(
    preferredWidth ?? (measured.width || PREF_W),
    bounds.right - bounds.left,
  );
  // Home's context control has always start-aligned its panel. Giving the
  // shared end-alignment maths a synthetic anchor as wide as the measured
  // panel preserves that behavior while keeping one placement implementation.
  const anchor = {
    left: control.left,
    top: control.top,
    width,
    height: control.height,
  };
  const initialPlacement = placePopover(anchor, { width, height: measured.height }, viewport);
  const placement = initialPlacement.top < control.top ? 'above' : 'below';
  const availableHeight = placement === 'above'
    ? control.top - POPOVER_ANCHOR_GAP - POPOVER_VIEWPORT_MARGIN
    : viewport.height - control.bottom - POPOVER_ANCHOR_GAP - POPOVER_VIEWPORT_MARGIN;
  const maxHeight = Math.max(120, Math.min(HARD_MAX_H, availableHeight));
  const placed = placePopover(
    anchor,
    { width, height: Math.min(measured.height, maxHeight) },
    viewport,
  );
  // Constraining the panel height can make the final placement fit on the
  // opposite side from the full-height probe. The rendered direction must
  // describe that final geometry, otherwise the enter animation travels from
  // the wrong edge and consumers observe a stale data-placement value.
  const finalPlacement = placed.top < control.top ? 'above' : 'below';
  const left = Math.min(Math.max(placed.left, bounds.left), bounds.right - width);

  return { ...placed, left, width, maxHeight, placement: finalPlacement };
}

export function CaretFloatingLayer({
  caret,
  open,
  boundaryRef,
  anchorRef,
  preferredWidth,
  children,
}: {
  caret: CaretRect | null;
  open: boolean;
  boundaryRef?: RefObject<HTMLElement | null>;
  /** Optional control anchor. When present it takes precedence over the caret. */
  anchorRef?: RefObject<HTMLElement | null>;
  preferredWidth?: number;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const reposition = useCallback(() => {
    const control = anchorRef?.current?.getBoundingClientRect() ?? null;
    if (!control && !caret) return;
    const el = layerRef.current;
    const size = el ? { width: el.offsetWidth, height: el.scrollHeight } : null;
    const boundary = boundaryRef?.current?.getBoundingClientRect() ?? null;
    if (control) {
      setPos(computeControlPopoverPos(control, size, boundary, preferredWidth));
      return;
    }
    if (caret) {
      setPos(computePopoverPos(caret, size, boundary, preferredWidth ?? PREF_W));
    }
  }, [anchorRef, boundaryRef, caret, preferredWidth]);

  // Measured pass on open + every anchor change. useLayoutEffect avoids a
  // wrong-coordinate flash before paint.
  useLayoutEffect(() => {
    if (open && (caret || anchorRef?.current)) reposition();
  }, [anchorRef, open, caret, reposition]);

  // Keep pinned while open. rAF-throttle scroll/resize. Reposition (not close)
  // so a small chat-log scroll doesn't feel broken; capture:true catches
  // ancestor scroll.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        reposition();
      });
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onMove);
    if (layerRef.current) resizeObserver?.observe(layerRef.current);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      resizeObserver?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, reposition]);

  if (!open || (!caret && !anchorRef?.current) || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={layerRef}
      className="caret-floating-layer"
      data-placement={pos?.placement ?? 'above'}
      style={
        pos
          ? {
              position: 'fixed',
              left: `${pos.left}px`,
              top: `${pos.top}px`,
              width: `${pos.width}px`,
              ['--cfl-max-h' as string]: `${pos.maxHeight}px`,
            }
          : {
              // Pre-measure off-screen so sizing causes no flash.
              position: 'fixed',
              left: '-9999px',
              top: '0px',
              width: `${preferredWidth ?? PREF_W}px`,
              visibility: 'hidden',
            }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
