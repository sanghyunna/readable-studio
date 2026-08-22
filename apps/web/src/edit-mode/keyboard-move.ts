/**
 * Pure helpers for Manual Edit keyboard object movement.
 *
 * These helpers are dependency-free and run in both the host window and the
 * preview iframe bridge, so keep them free of React, browser-only globals, and
 * project-specific state.
 */

export const MANUAL_EDIT_NUDGE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const;
export type ManualEditNudgeKey = (typeof MANUAL_EDIT_NUDGE_KEYS)[number];

export function isManualEditNudgeKey(key: string): key is ManualEditNudgeKey {
  return (MANUAL_EDIT_NUDGE_KEYS as readonly string[]).includes(key);
}

export function manualEditNudgeDelta(key: ManualEditNudgeKey): { x: number; y: number } {
  switch (key) {
    case 'ArrowLeft': return { x: -1, y: 0 };
    case 'ArrowRight': return { x: 1, y: 0 };
    case 'ArrowUp': return { x: 0, y: -1 };
    case 'ArrowDown': return { x: 0, y: 1 };
  }
}

export function manualEditNudgeDeltaFromDirection(
  direction: 'left' | 'right' | 'up' | 'down',
): { x: number; y: number } {
  switch (direction) {
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
    case 'up': return { x: 0, y: -1 };
    case 'down': return { x: 0, y: 1 };
  }
}

// ARIA roles whose own arrow-key behavior must not be hijacked for object
// movement. Kept conservative: if a role or its ancestor consumes arrows, the
// nudge command does not own the event.
const BLOCKED_ARIA_ROLES = new Set([
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'scrollbar',
  'listbox',
  'option',
  'combobox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tree',
  'treegrid',
  'treeitem',
  'grid',
  'gridcell',
  'columnheader',
  'rowheader',
  'row',
  'tab',
  'tablist',
  'radiogroup',
]);

export function isManualEditNudgeBlocked(
  target: EventTarget | null,
  options?: { isComposing?: boolean },
): boolean {
  if (options?.isComposing) return true;
  if (!(target instanceof Element)) return false;
  const el = target;

  // Native text/form controls. The issue explicitly lists inputs, textareas,
  // and selects; block the whole <input> family so caret/control behavior is
  // never intercepted.
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;

  // Contenteditable hosts, including the bridge's rich-text edit session and
  // any artifact-owned editable surface.
  if (typeof (el as HTMLElement).isContentEditable === 'boolean' && (el as HTMLElement).isContentEditable) {
    return true;
  }
  if (el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null) {
    return true;
  }

  // ARIA widgets whose behavior uses Arrow keys.
  let node: Element | null = el;
  while (node && node !== node.ownerDocument?.body) {
    const role = node.getAttribute('role')?.trim().toLowerCase();
    if (role && BLOCKED_ARIA_ROLES.has(role)) return true;
    node = node.parentElement;
  }

  return false;
}

export function isManualEditNudgeNetZero(netDelta: { x: number; y: number }): boolean {
  return netDelta.x === 0 && netDelta.y === 0;
}

export type ManualEditMoveAnnouncementSegment = {
  axis: 'x' | 'y';
  amount: number;
  key: 'manualEdit.move.left' | 'manualEdit.move.right' | 'manualEdit.move.up' | 'manualEdit.move.down';
};

export function manualEditMoveAnnouncementSegments(
  netDelta: { x: number; y: number },
): ManualEditMoveAnnouncementSegment[] {
  const segments: ManualEditMoveAnnouncementSegment[] = [];
  if (netDelta.x > 0) segments.push({ axis: 'x', amount: netDelta.x, key: 'manualEdit.move.right' });
  if (netDelta.x < 0) segments.push({ axis: 'x', amount: -netDelta.x, key: 'manualEdit.move.left' });
  if (netDelta.y > 0) segments.push({ axis: 'y', amount: netDelta.y, key: 'manualEdit.move.down' });
  if (netDelta.y < 0) segments.push({ axis: 'y', amount: -netDelta.y, key: 'manualEdit.move.up' });
  return segments;
}
