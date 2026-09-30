import { editWidthRelease } from '@readable-studio/html-edit';
import type { ManualEditDuplicatePlan } from './types';

/** Rebase validated ownership onto a source-backed copy, retaining its appearance and restore baseline. */
export function rewriteClonedWidthReleases(root: Element, plan: ManualEditDuplicatePlan): string | null {
  const inspected = editWidthRelease(plan.expectedSource, { kind: 'inspect' });
  if (!inspected.ok) return `${inspected.conflict.code}: ${inspected.conflict.reason}`;
  const used = new Set(inspected.records.map(record => record.id));
  const elements = [root, ...root.querySelectorAll('[data-readable-width-release]')];
  for (const original of inspected.records) {
    const targetId = plan.manualIdMap[original.targetId];
    if (!targetId) continue; // This record belongs outside the copied subtree.
    const element = elements.find(node => node.getAttribute('data-readable-id') === targetId);
    if (!element) return 'WIDTH_RELEASE_CONFLICT: target-missing';
    let id = `${original.id}-copy`;
    let suffix = 2;
    while (used.has(id)) id = `${original.id}-copy-${suffix++}`;
    used.add(id);
    element.setAttribute('data-readable-width-release', JSON.stringify({ ...original, id, targetId }));

    // The duplicate's translate write uses CSSOM, which discards duplicate and
    // unsupported max-width fallbacks. Reconstitute the validated owned cascade
    // after that write; do not rebase before onto the released appearance.
    const style = element.ownerDocument.createElement('span').style;
    style.cssText = element.getAttribute('style') ?? '';
    for (const declaration of original.after) style.removeProperty(declaration.property);
    const owned = original.after.map(({ property, value, priority }) => `${property}: ${value}${priority ? ' !important' : ''};`).join(' ');
    element.setAttribute('style', `${style.cssText} ${owned}`.trim());
  }
  return null;
}
