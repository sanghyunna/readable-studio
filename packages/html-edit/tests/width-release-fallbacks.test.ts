import { describe, expect, it } from 'vitest';
import { parseFragment } from 'parse5';
import { editWidthRelease, type WidthReleaseDeclaration, type WidthReleaseResult } from '../src/index.js';

const target = { targetId: 'copy', tag: 'p' };
const fallback = ['100%', '-moz-available', 'stretch'];
const declarations: WidthReleaseDeclaration[] = [
  { property: 'width', value: 'min(720px, 100%)', priority: '' },
  ...fallback.map(value => ({ property: 'max-width', value, priority: '' as const })),
];
function success(result: WidthReleaseResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.conflict.reason);
  return result;
}
function style(source: string) {
  const node = parseFragment(source).childNodes[0];
  if (!node || !('attrs' in node)) throw new Error('Expected target');
  return node.attrs.find(attr => attr.name === 'style')?.value;
}

describe('ordered width fallback ownership', () => {
  it('retains the complete cascade through apply, update and restore', () => {
    // Given: duplicate authored maxima, aliases and priorities need restoration.
    const source = '<p data-readable-id="copy" style="color:red; max-width:30ch; max-width:65ch !important; inline-size:40%">Copy</p>';
    const first = success(editWidthRelease(source, { kind: 'apply', target, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-width'], declarations }));
    // When: a subsequent measured width replaces the preferred size only.
    const updated = success(editWidthRelease(first.source, { kind: 'update', target, preferredCssPx: 800,
      declarations: [{ property: 'width', value: 'min(800px, 100%)', priority: '' }] }));
    const restored = success(editWidthRelease(updated.source, { kind: 'restore', target }));
    // Then: ordered fallbacks persist and the first authored baseline is recoverable.
    expect(first.record?.after.filter(item => item.property === 'max-width').map(item => item.value)).toEqual(fallback);
    expect(updated.record?.after.filter(item => item.property === 'max-width').map(item => item.value)).toEqual(fallback);
    expect(style(updated.source)).toContain('max-width: 100%; max-width: -moz-available; max-width: stretch;');
    expect(updated.record?.before).toEqual(first.record?.before);
    expect(style(restored.source)).toContain('max-width: 30ch; max-width: 65ch !important; inline-size: 40%;');
    expect(style(restored.source)).toContain('color:red;');
  });

  it('rejects reordered persisted fallbacks without mutating source', () => {
    // Given
    const source = '<p data-readable-id="copy">Copy</p>';
    const first = success(editWidthRelease(source, { kind: 'apply', target, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-width'], declarations }));
    const reordered = first.source.replace('max-width: 100%; max-width: -moz-available;', 'max-width: -moz-available; max-width: 100%;');
    // When
    const result = editWidthRelease(reordered, { kind: 'restore', target });
    // Then
    expect(result).toMatchObject({ ok: false, source: reordered, conflict: { reason: 'owned-declarations-changed' } });
  });

  it('round-trips a logical fallback release without changing unrelated bytes', () => {
    // Given
    const source = '<!-- keep -->\r\n<p data-readable-id="copy">Copy &amp; text</p>';
    const logical = declarations.map(item => ({ ...item, property: item.property === 'max-width' ? 'max-inline-size' : item.property }));
    // When
    const applied = success(editWidthRelease(source, { kind: 'apply', target, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-inline-size'], declarations: logical }));
    const restored = success(editWidthRelease(applied.source, { kind: 'restore', target }));
    // Then
    expect(applied.record?.after).toEqual(logical);
    expect(restored.source).toBe(source);
  });
});
