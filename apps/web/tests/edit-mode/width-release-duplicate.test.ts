// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editWidthRelease } from '@readable-studio/html-edit';
import { applyManualEditPatch, planManualEditDuplicate } from '../../src/edit-mode/source-patches';

function released(source: string, targetId: string) {
  const result = editWidthRelease(source, {
    kind: 'apply', target: { targetId }, expectedSource: source, preferredCssPx: 300,
    causes: ['own-max-width'], declarations: [
      { property: 'width', value: 'min(300px, 100%)', priority: '' },
      ...['100%', '-moz-available', 'stretch'].map(value => ({ property: 'max-width', value, priority: '' as const })),
    ],
  });
  if (!result.ok) throw new Error(result.conflict.reason);
  return result.source;
}

function duplicate(source: string, originalId: string) {
  const planned = planManualEditDuplicate(source, originalId);
  if (!planned.ok) throw new Error(planned.error);
  const result = applyManualEditPatch(source, {
    kind: 'duplicate-and-move', id: originalId, plan: planned.plan, finalTranslate: '0px 100px',
  });
  expect(result.ok, result.error).toBe(true);
  return { source: result.source, targetId: planned.plan.duplicateRootId, preview: planned.plan.previewHtml };
}

function records(source: string) {
  const inspected = editWidthRelease(source, { kind: 'inspect' });
  if (!inspected.ok) throw new Error(inspected.conflict.reason);
  return inspected.records;
}

describe('released element duplication', () => {
  it('keeps the release with independent identities and restores each copy when duplicated', () => {
    // Given
    const source = released('<p data-readable-id="copy" style="max-width:20ch;color:red">Copy</p>', 'copy');
    const original = records(source)[0];
    // When
    const cloned = duplicate(source, 'copy');
    // Then
    const pair = records(cloned.source);
    expect(pair).toHaveLength(2);
    expect(pair[0]).toEqual(original);
    expect(pair[1]).toEqual({ ...original, id: pair[1]?.id, targetId: cloned.targetId });
    expect(pair[1]?.id).not.toBe(original?.id);
    expect(records(cloned.preview)).toEqual([pair[1]]);
    const restored = editWidthRelease(cloned.source, { kind: 'restore', target: { targetId: cloned.targetId } });
    if (!restored.ok) throw new Error(restored.conflict.reason);
    expect(records(restored.source)).toEqual([original]);
    expect(restored.source).toContain('translate: 0px 100px');
    const restoredOriginal = editWidthRelease(restored.source, { kind: 'restore', target: { targetId: 'copy' } });
    if (!restoredOriginal.ok) throw new Error(restoredOriginal.conflict.reason);
    expect(records(restoredOriginal.source)).toEqual([]);
    const elements = new DOMParser().parseFromString(restoredOriginal.source, 'text/html').querySelectorAll('p');
    expect(Array.from(elements, el => [el.style.maxWidth, el.style.color])).toEqual([['20ch', 'red'], ['20ch', 'red']]);
  });

  it('allocates distinct ownership throughout repeated cloned subtrees', () => {
    // Given
    const source = released(released('<section data-readable-id="group"><p data-readable-id="copy">Copy</p></section>', 'copy'), 'group');
    const first = duplicate(source, 'group');
    // When
    const second = duplicate(first.source, 'group');
    // Then
    const all = records(second.source);
    expect(all).toHaveLength(6);
    expect(new Set(all.map(record => record.id)).size).toBe(6);
    expect(new Set(all.map(record => record.targetId)).size).toBe(6);
    expect(all.every(record => record.after.length === 4)).toBe(true);
  });

  it('preserves the original release when the clone is resized again', () => {
    // Given
    const source = released('<p data-readable-id="copy" style="max-width:20ch">Copy</p>', 'copy');
    const cloned = duplicate(source, 'copy');
    const original = records(source)[0];
    // When
    const updated = editWidthRelease(cloned.source, { kind: 'update', target: { targetId: cloned.targetId },
      preferredCssPx: 350, declarations: [{ property: 'width', value: 'min(350px, 100%)', priority: '' }] });
    // Then
    if (!updated.ok) throw new Error(updated.conflict.reason);
    expect(updated.records[0]).toEqual(original);
    expect(updated.record?.before).toEqual(original?.before);
    expect(updated.record?.preferredCssPx).toBe(350);
  });

  it('refuses stale owned styles rather than repairing them while planning a duplicate', () => {
    // Given
    const source = released('<p data-readable-id="copy">Copy</p>', 'copy').replace('width: min(300px, 100%)', 'width: 900px');
    // When
    const planned = planManualEditDuplicate(source, 'copy');
    // Then
    expect(planned.ok).toBe(false);
  });
});
