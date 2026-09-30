/** Keep native hit testing in the host document for the lifetime of a drag.
 * Chromium can route moves into a sandboxed/OOPIF preview despite pointer
 * capture on a host overlay. Capture still delivers events to the original
 * control; this transparent surface prevents crossing the browsing context.
 */
export function createPointerDragShield(target: HTMLElement): HTMLDivElement {
  const doc = target.ownerDocument;
  const shield = doc.createElement('div');
  shield.dataset.readablePointerDragShield = '';
  shield.setAttribute('aria-hidden', 'true');
  shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;touch-action:none';
  shield.style.cursor = doc.defaultView!.getComputedStyle(target).cursor;
  doc.body.appendChild(shield);
  return shield;
}
