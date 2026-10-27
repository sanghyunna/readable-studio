// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyManualEditPatch } from '../../src/edit-mode/source-patches';
import type { ManualEditPatch } from '../../src/edit-mode/types';

const declarations = [
  { property: 'width', value: 'min(500px, 100%)', priority: '' as const },
  ...['100%', '-moz-available', 'stretch'].map(value => ({ property: 'max-width', value, priority: '' as const })),
];
function release(source: string) {
  return applyManualEditPatch(source, { kind: 'set-width-release', id: 'copy', expectedSource: source,
    preferredCssPx: 500, declarations, causes: ['own-max-width'], provenance: [] } as ManualEditPatch);
}
function element(source: string) { return new DOMParser().parseFromString(source, 'text/html').querySelector('p')!; }

describe('canonical width release (no layout assertions)', () => {
  it('records an own measure release without changing the shared rule or emitting importance', () => {
    const source = '<style>.measure{max-width:65ch}</style><p data-readable-id="copy" class="measure">Copy</p>';
    const result = release(source);
    expect(result.ok).toBe(true);
    const el = element(result.source);
    const record = JSON.parse(el.getAttribute('data-readable-width-release')!);
    expect(record.schema).toBe('readable.width-release.v1');
    expect(record.after).toEqual(declarations);
    expect(record.before).toEqual([]);
    expect(result.source).toContain('.measure{max-width:65ch}');
    expect(result.source).not.toContain('!important');
  });
  it.each(['', 'style="width:120px !important; max-width:200px; color:red"'])('restores prior declaration presence and priority after reopening: %s', (style) => {
    const source = `<p data-readable-id="copy" ${style}>Copy</p>`;
    const applied = release(source);
    expect(applied.ok).toBe(true);
    expect(element(applied.source).hasAttribute('data-readable-width-release')).toBe(true);
    const restored = applyManualEditPatch(applied.source, { kind: 'restore-width-release', id: 'copy' } as ManualEditPatch);
    expect(restored.ok).toBe(true);
    const before = element(source), after = element(restored.source);
    for (const property of ['width', 'max-width', 'color']) {
      expect(after.style.getPropertyValue(property)).toBe(before.style.getPropertyValue(property));
      expect(after.style.getPropertyPriority(property)).toBe(before.style.getPropertyPriority(property));
    }
    expect(after.hasAttribute('data-readable-width-release')).toBe(false);
  });
  it('preserves the ordered fallback cascade when an unrelated color is edited after release', () => {
    // Given
    const applied = release('<p data-readable-id="copy" style="max-width:65ch; color:red">Copy</p>');
    expect(applied.ok).toBe(true);
    // When
    const colored = applyManualEditPatch(applied.source, { kind: 'set-style', id: 'copy', styles: { color: 'blue' } });
    // Then: inspect persisted source, not the browser-collapsed CSSOM.
    expect(colored.ok).toBe(true);
    const el = element(colored.source);
    expect(el.getAttribute('style')).toContain('max-width: 100%; max-width: -moz-available; max-width: stretch;');
    expect(el.style.color).toBe('blue');
    expect(JSON.parse(el.getAttribute('data-readable-width-release')!).after).toEqual(declarations);
    const restored = applyManualEditPatch(colored.source, { kind: 'restore-width-release', id: 'copy' });
    expect(restored.ok).toBe(true);
    expect(element(restored.source).style.maxWidth).toBe('65ch');
    expect(element(restored.source).style.color).toBe('blue');
  });
  it('refuses an unmeasured competing sizing patch on a released target', () => {
    const applied = release('<p data-readable-id="copy">Copy</p>');
    expect(applied.ok).toBe(true);
    const result = applyManualEditPatch(applied.source, { kind: 'set-style', id: 'copy', styles: { width: '900px' } });
    expect(result.ok).toBe(false);
    expect(result.source).toBe(applied.source);
  });

  it('commits centered release atomically while leaving translation movable and restorable sizing owned', () => {
    const source = '<p data-readable-id="copy" style="width:200px;max-width:200px;height:80px;translate:10px 20px">Copy</p>';
    const applied = applyManualEditPatch(source, { kind: 'set-width-release', id: 'copy', expectedSource: source,
      preferredCssPx: 500, declarations: [...declarations,
        { property: 'height', value: '120px', priority: '' },
        { property: 'translate', value: '10px 0px', priority: '' }],
      causes: ['own-max-width'], provenance: [] });
    expect(applied.ok).toBe(true);
    expect(element(applied.source).style.translate).toBe('10px 0px');
    const firstRecord = JSON.parse(element(applied.source).getAttribute('data-readable-width-release')!);
    expect(firstRecord.after.some((entry: { property: string }) => entry.property === 'translate')).toBe(false);

    const updated = applyManualEditPatch(applied.source, { kind: 'set-width-release', id: applied.selection?.targetId ?? 'copy',
      expectedSource: applied.source, preferredCssPx: 500,
      declarations: [...declarations, { property: 'height', value: '140px', priority: '' },
        { property: 'translate', value: '15px -10px', priority: '' }],
      causes: ['own-max-width'], provenance: [] });
    expect(updated.ok).toBe(true);
    expect(element(updated.source).style.translate).toBe('15px -10px');
    const moved = applyManualEditPatch(updated.source, { kind: 'set-style', id: updated.selection?.targetId ?? 'copy', styles: { translate: '35px 25px' } });
    expect(moved.ok).toBe(true);
    const restored = applyManualEditPatch(moved.source, { kind: 'restore-width-release', id: 'copy' });
    expect(restored.ok).toBe(true);
    const after = element(restored.source);
    expect(after.style.width).toBe('200px');
    expect(after.style.maxWidth).toBe('200px');
    expect(after.style.height).toBe('80px');
    expect(after.style.translate).toBe('35px 25px');
    expect(after.hasAttribute('data-readable-width-release')).toBe(false);
  });

  it.each(['NaNpx 0px', 'calc(10px + 1%) 0px', '0px 0px 1px'])('rejects an invalid centered release without a partial sizing commit: %s', (translate) => {
    const source = '<p data-readable-id="copy" style="width:200px;max-width:200px;translate:10px 20px">Copy</p>';
    const result = applyManualEditPatch(source, { kind: 'set-width-release', id: 'copy', expectedSource: source,
      preferredCssPx: 500, declarations: [...declarations, { property: 'translate', value: translate, priority: '' }],
      causes: ['own-max-width'], provenance: [] });
    expect(result.ok).toBe(false);
    expect(result.source).toBe(source);
  });

  it('keeps the allocated source-path identity when applying a centered release', () => {
    const source = '<p style="width:200px;max-width:200px">Copy</p>';
    const result = applyManualEditPatch(source, { kind: 'set-width-release', id: 'path-0', expectedSource: source,
      preferredCssPx: 500, declarations: [...declarations, { property: 'translate', value: '-15px 0px', priority: '' }],
      causes: ['own-max-width'], provenance: [] });
    expect(result.ok).toBe(true);
    expect(result.selection?.targetId).toBeTruthy();
    const after = element(result.source);
    expect(after.getAttribute('data-readable-id')).toBe(result.selection?.targetId);
    expect(after.style.translate).toBe('-15px 0px');
    expect(after.hasAttribute('data-readable-width-release')).toBe(true);
  });
});
