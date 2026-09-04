// Shared placement maths for body-portaled popover layers.
//
// Menus in this app are portaled to `document.body` as fixed layers, so a
// popover is no longer a DOM descendant of its trigger: nothing about the
// anchor's offset parent, its relative container, or descendant layout can
// place it any more. Every portaled panel therefore has to be positioned from
// the anchor's measured viewport rect, clamped to a viewport gutter.
//
// This module is the single implementation of that maths. It was extracted
// verbatim from InlineModelSwitcher (which proved it against the entry top bar
// and the Hub composer footer) so SessionModeToggle can reuse it instead of
// forking a third positioning implementation.

/** Breathing room kept against every viewport edge. */
export const POPOVER_VIEWPORT_MARGIN = 12;
/** Gap between the anchor and the panel. */
export const POPOVER_ANCHOR_GAP = 8;

export function popoverHorizontalOffset(
  anchorLeft: number,
  anchorWidth: number,
  popoverWidth: number,
  viewportWidth: number,
  margin = POPOVER_VIEWPORT_MARGIN,
): number {
  // Ideal left edge: align the panel's right edge with the anchor's right edge
  // (the established look for a right-hand control), then pull it back inside
  // the viewport if that overflows either side.
  const preferredLeft = anchorLeft + anchorWidth - popoverWidth;
  const maxLeft = Math.max(margin, viewportWidth - popoverWidth - margin);
  const clampedLeft = Math.min(Math.max(preferredLeft, margin), maxLeft);
  // Returned relative to the anchor so the same maths describes both the
  // in-flow and the portaled placement.
  return clampedLeft - anchorLeft;
}

/**
 * Vertical placement for a body-level panel.
 *
 * Opens downward when there is room, otherwise flips above the anchor, and
 * clamps to the same gutter used horizontally.
 */
export function popoverVerticalOffset(
  anchorTop: number,
  anchorHeight: number,
  popoverHeight: number,
  viewportHeight: number,
  margin = POPOVER_VIEWPORT_MARGIN,
  gap = POPOVER_ANCHOR_GAP,
): number {
  const below = anchorTop + anchorHeight + gap;
  const above = anchorTop - gap - popoverHeight;
  const preferredTop =
    below + popoverHeight <= viewportHeight - margin || above < margin
      ? below
      : above;
  const maxTop = Math.max(margin, viewportHeight - popoverHeight - margin);
  return Math.min(Math.max(preferredTop, margin), maxTop);
}

/**
 * Full viewport-space placement for a portaled panel, from MEASURED boxes.
 *
 * Both dimensions must come from the panel's real rendered box
 * (`offsetWidth`/`offsetHeight`), never from a guessed constant: a panel whose
 * height varies by surface (e.g. a menu that hides its description card in the
 * composer) will otherwise be placed hundreds of pixels away from its trigger.
 */
export function placePopover(
  anchor: { left: number; top: number; width: number; height: number },
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = POPOVER_VIEWPORT_MARGIN,
  gap = POPOVER_ANCHOR_GAP,
): { left: number; top: number } {
  return {
    left:
      anchor.left +
      popoverHorizontalOffset(
        anchor.left,
        anchor.width,
        popover.width,
        viewport.width,
        margin,
      ),
    top: popoverVerticalOffset(
      anchor.top,
      anchor.height,
      popover.height,
      viewport.height,
      margin,
      gap,
    ),
  };
}
