import type { ManualEditStyles } from './types';

export type ResizeHandleDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLE_DIRECTIONS: readonly ResizeHandleDirection[] = [
  'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w',
];

const MIN_SIZE = 8;

// Placement-only floor: on a zero/near-zero-sized element all 8 handle centers
// would collapse onto one point and only the last-rendered button stays clickable.
// Spread the placement box to at least this many px so every handle stays reachable
// (does not affect committed size, which comes from resizeDragSize).
const MIN_HANDLE_SPREAD = 20;

// Sign of deltaX/deltaY contribution to width/height growth per direction.
// 0 means that axis is not affected by this direction.
const DELTA_SIGN: Record<ResizeHandleDirection, { x: number; y: number }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

const IS_CORNER: Record<ResizeHandleDirection, boolean> = {
  nw: true, n: false, ne: true, e: false, se: true, s: false, sw: true, w: false,
};

export function resizeHandlePositions(
  rect: { left: number; top: number; width: number; height: number },
): Record<ResizeHandleDirection, { left: number; top: number }> {
  const { left, top } = rect;
  const width = Math.max(rect.width, MIN_HANDLE_SPREAD);
  const height = Math.max(rect.height, MIN_HANDLE_SPREAD);
  const midX = left + width / 2;
  const midY = top + height / 2;
  const right = left + width;
  const bottom = top + height;
  return {
    nw: { left, top },
    n: { left: midX, top },
    ne: { left: right, top },
    e: { left: right, top: midY },
    se: { left: right, top: bottom },
    s: { left: midX, top: bottom },
    sw: { left, top: bottom },
    w: { left, top: midY },
  };
}

export function resizeDragSize(args: {
  direction: ResizeHandleDirection;
  startWidth: number;
  startHeight: number;
  deltaX: number;
  deltaY: number;
  scale: number;
  lockAspect: boolean;
}): { width: number; height: number } {
  const { direction, startWidth, startHeight, deltaX, deltaY, lockAspect } = args;
  const scale = args.scale > 0 ? args.scale : 1;
  const sign = DELTA_SIGN[direction];

  const scaledDeltaX = (deltaX / scale) * sign.x;
  const scaledDeltaY = (deltaY / scale) * sign.y;

  let width = startWidth + scaledDeltaX;
  let height = startHeight + scaledDeltaY;

  if (lockAspect && IS_CORNER[direction] && startWidth > 0 && startHeight > 0) {
    const ratio = startWidth / startHeight;
    if (Math.abs(scaledDeltaX) >= Math.abs(scaledDeltaY)) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
  }

  width = Math.max(MIN_SIZE, Math.round(width));
  height = Math.max(MIN_SIZE, Math.round(height));

  return { width, height };
}

const PX_VALUE = /^(-?\d+(?:\.\d+)?)px$/;

function parsePx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = PX_VALUE.exec(value.trim());
  if (!match?.[1]) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function rectScaleAxis(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function cssAxisPx(
  size: number,
  startSize: number,
  base: string | undefined,
  computed: string | undefined,
  scale: number | undefined,
): string {
  const k = rectScaleAxis(scale);
  const baseCss = parsePx(base);
  const computedCss = parsePx(computed);
  // Applying the drag as a delta on the element's current CSS size keeps
  // box-sizing out of the math: padding/border constants cancel in the delta.
  // The anchor is the inline/base value, EXCEPT when the computed value
  // disagrees with it — then layout clamped or ignored the base (max-width,
  // min-content, a stale clamped commit) and anchoring on it creates a dead
  // zone; the computed value is what actually renders. Computed also covers
  // non-px bases (auto, %, fit-content) where the delta form would otherwise
  // be unavailable.
  const anchor = baseCss !== undefined && (computedCss === undefined || Math.abs(baseCss - computedCss) <= 1)
    ? baseCss
    : computedCss ?? baseCss;
  const value = anchor !== undefined ? anchor + (size - startSize) / k : size / k;
  return `${Math.max(1, Math.round(value))}px`;
}

// Margin bases come from getComputedStyle via the bridge, so they are px in
// practice; an empty string means "no information", which is safe to treat as
// 0. A non-px value (an inline `auto`) means compensation could jump the box —
// skip it for that axis.
function marginBasePx(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return 0;
  return parsePx(value);
}

/**
 * Convert a drag result from rect space (getBoundingClientRect px, which
 * ancestor CSS transforms — e.g. a deck's fit-to-canvas scale — inflate by
 * rectScale) into the CSS width/height property space the inspector shows and
 * the source file stores. Per-axis: edge handles commit one axis, corners both.
 */
export function resizeCssCommitStyles(args: {
  direction: ResizeHandleDirection;
  size: { width: number; height: number };
  startSize: { width: number; height: number };
  baseStyles?: { width?: string; height?: string };
  /** Post-layout getComputedStyle width/height (px), snapshotted at drag start. */
  computedSize?: { width?: string; height?: string };
  /** Drag-start margins (computed px from the bridge) for west/north anchoring. */
  baseMargins?: { marginLeft?: string; marginRight?: string; marginTop?: string; marginBottom?: string };
  rectScale?: { x: number; y: number };
  flexItemAxis?: 'row' | 'column' | null;
}): Partial<ManualEditStyles> {
  const { direction, size, startSize, baseStyles, computedSize, baseMargins, rectScale, flexItemAxis } = args;
  const styles: Partial<ManualEditStyles> = {};
  if (DELTA_SIGN[direction].x !== 0) {
    styles.width = cssAxisPx(size.width, startSize.width, baseStyles?.width, computedSize?.width, rectScale?.x);
  }
  if (DELTA_SIGN[direction].y !== 0) {
    styles.height = cssAxisPx(size.height, startSize.height, baseStyles?.height, computedSize?.height, rectScale?.y);
  }
  // West/north drags: width/height alone always grow an in-flow element
  // east/south (CSS sizes have no anchor side), so the grabbed edge would sit
  // still while the cursor walks away. Shift the box back by the same CSS
  // delta via the margin so the grabbed edge tracks the pointer and the
  // opposite edge stays fixed. When the opposite margin carries a nonzero
  // (auto-centering) used value, pin it too — otherwise the still-auto side
  // absorbs all the slack and the box jumps.
  if (baseMargins && styles.width !== undefined && DELTA_SIGN[direction].x < 0) {
    const marginLeft = marginBasePx(baseMargins.marginLeft);
    if (marginLeft !== undefined) {
      const deltaCss = (size.width - startSize.width) / rectScaleAxis(rectScale?.x);
      styles.marginLeft = `${Math.round(marginLeft - deltaCss)}px`;
      const marginRight = marginBasePx(baseMargins.marginRight);
      if (marginRight) styles.marginRight = `${Math.round(marginRight)}px`;
    }
  }
  if (baseMargins && styles.height !== undefined && DELTA_SIGN[direction].y < 0) {
    const marginTop = marginBasePx(baseMargins.marginTop);
    if (marginTop !== undefined) {
      const deltaCss = (size.height - startSize.height) / rectScaleAxis(rectScale?.y);
      styles.marginTop = `${Math.round(marginTop - deltaCss)}px`;
      const marginBottom = marginBasePx(baseMargins.marginBottom);
      if (marginBottom) styles.marginBottom = `${Math.round(marginBottom)}px`;
    }
  }
  // A main-axis size on a flex item is only a suggestion: flex-grow/shrink win
  // and the drag result silently snaps back. Pin the item (flex: none — the
  // Figma "fill → fixed" semantic) so the written size actually holds. Cross
  // axis needs no pin: an explicit size already beats align-items stretch.
  if (
    (flexItemAxis === 'row' && styles.width !== undefined) ||
    (flexItemAxis === 'column' && styles.height !== undefined)
  ) {
    styles.flex = 'none';
  }
  return styles;
}

/** Parse a `translate` CSS value ('', undefined, 'none' -> {0,0}; missing/non-px token -> 0 for that axis). */
export function parseTranslate(value: string | undefined): { x: number; y: number } {
  if (!value || value.trim() === '' || value.trim() === 'none') return { x: 0, y: 0 };
  const tokens = value.trim().split(/\s+/);
  return { x: parsePx(tokens[0]) ?? 0, y: parsePx(tokens[1]) ?? 0 };
}

// A CSS px result below this magnitude serializes to 0 on that axis, so the
// translate collapses to '' when both axes vanish. Guards against a fractional
// residue (e.g. 0.0004) surviving as a nonzero token.
const TRANSLATE_ZERO_EPSILON = 1e-3;

/** Round to at most 3 decimals and strip a signed zero. */
function fractionalPx(value: number): number {
  const rounded = Number.parseFloat(value.toFixed(3));
  return rounded === 0 ? 0 : rounded;
}

/**
 * Fold a rect-space move delta onto the base translate, converting to CSS px via
 * rectScale. `fractional` is a per-axis flag: a free (un-snapped) axis rounds to
 * a whole px like every other move commit, while a snapped axis keeps up to
 * three decimals so the element's edge lands exactly on the sub-pixel target
 * edge it magnetically aligned to.
 */
export function moveCssCommitStyles(args: {
  deltaRect: { x: number; y: number };
  baseTranslate: string | undefined;
  rectScale?: { x: number; y: number };
  fractional?: { x?: boolean; y?: boolean };
}): Pick<ManualEditStyles, 'translate'> {
  const base = parseTranslate(args.baseTranslate);
  const rawX = base.x + args.deltaRect.x / rectScaleAxis(args.rectScale?.x);
  const rawY = base.y + args.deltaRect.y / rectScaleAxis(args.rectScale?.y);
  const x = args.fractional?.x ? fractionalPx(rawX) : Math.round(rawX);
  const y = args.fractional?.y ? fractionalPx(rawY) : Math.round(rawY);
  const collapsed = Math.abs(x) < TRANSLATE_ZERO_EPSILON && Math.abs(y) < TRANSLATE_ZERO_EPSILON;
  return { translate: collapsed ? '' : `${x}px ${y}px` };
}
