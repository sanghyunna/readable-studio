import { describe, expect, it } from 'vitest';
import { parseFragment, serialize } from 'parse5';
import {
  editWidthRelease,
  type WidthReleaseDeclaration,
  type WidthReleaseResult,
  type WidthReleaseSuccess,
} from '../src/index.js';

const declarations: WidthReleaseDeclaration[] = [
  { property: 'width', value: 'min(720px, 100%)', priority: '' },
  { property: 'max-width', value: 'stretch', priority: '' },
];
const target = { targetId: 'copy', tag: 'p' };
function success(result: WidthReleaseResult): WidthReleaseSuccess {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.conflict.reason);
  return result;
}
function apply(source: string, extra: WidthReleaseDeclaration[] = []) {
  return success(editWidthRelease(source, {
    kind: 'apply', target, expectedSource: source, preferredCssPx: 720,
    causes: ['own-max-width'], declarations: [...declarations, ...extra],
  }));
}
function restore(source: string) {
  return success(editWidthRelease(source, { kind: 'restore', target }));
}
function conflict(source: string, reason: string) {
  const result = editWidthRelease(source, { kind: 'restore', target });
  expect(result).toMatchObject({ ok: false, source, conflict: { code: 'WIDTH_RELEASE_CONFLICT', reason } });
}
function replaceRecord(source: string, mutate: (record: Record<string, unknown>) => void) {
  const fragment = parseFragment(source);
  const node = fragment.childNodes[0];
  if (!('attrs' in node)) throw new Error('Expected element');
  const attr = node.attrs.find((item) => item.name === 'data-readable-width-release');
  if (!attr) throw new Error('Expected record');
  const record = JSON.parse(attr.value) as Record<string, unknown>;
  mutate(record);
  attr.value = JSON.stringify(record);
  return serialize(fragment);
}

describe('persistent width releases', () => {
  it.each([
    '<p data-readable-id="copy">Hello &amp; goodbye</p>',
    '<!DOCTYPE HTML>\r\n<html lang=en><head><style>.copy {max-width:65ch}</style></head><body>\r\n<p data-readable-id="copy">Hello &amp; goodbye</p>\r\n</body></html>',
  ])('round-trips apply, update and restore without undo for %s', (source) => {
    const first = apply(source);
    const updated = success(editWidthRelease(first.source, {
      kind: 'update', target, preferredCssPx: 800,
      declarations: [{ property: 'width', value: 'min(800px, 100%)', priority: '' }],
    }));
    expect(updated.record?.before).toEqual([]);
    expect(updated.record?.id).toBe(first.record?.id);
    expect(updated.record?.preferredCssPx).toBe(800);
    expect(success(editWidthRelease(updated.source, { kind: 'inspect' })).records).toEqual(updated.records);
    expect(restore(updated.source).source).toBe(source);
  });

  it('restores ordered original aliases, duplicate declarations and priority', () => {
    const source = '<p data-readable-id="copy" style="width: 40%; inline-size: 12em !important; width: 17rem !important; max-width: var(--measure)">Text</p>';
    const first = apply(source);
    expect(first.record?.before).toEqual([
      { property: 'width', value: '40%', priority: '' },
      { property: 'inline-size', value: '12em', priority: 'important' },
      { property: 'width', value: '17rem', priority: 'important' },
      { property: 'max-width', value: 'var(--measure)', priority: '' },
    ]);
    const restored = restore(first.source);
    const reapplied = apply(restored.source);
    expect(reapplied.record?.before).toEqual(first.record?.before);
  });

  it('preserves unrelated document bytes and unrelated start-tag attributes', () => {
    const prefix = '<!-- keep\r\n spacing -->\r\n<section class = \'outer\'><style>.copy{max-width:65ch!important}</style>';
    const suffix = 'Text &copy;<!--inside--></p>\r\n<script>const s = "<p>";</script></section>';
    const source = prefix + '<p data-readable-id="copy" CLASS = \'copy\' title=untouched style="color: red; --measure: 65ch;">' + suffix;
    const first = apply(source);
    expect(first.source.startsWith(prefix)).toBe(true);
    expect(first.source.endsWith(suffix)).toBe(true);
    expect(first.source).toContain("CLASS = 'copy' title=untouched");
    expect(first.source).toContain('color: red; --measure: 65ch;');
  });

  it('retains text and unowned style edits made after Save', () => {
    const first = apply('<p data-readable-id="copy" style="color:red; max-width:30ch">Old</p>');
    const externallyEdited = first.source.replace('color:red', 'color:blue').replace('>Old</p>', '>New</p>');
    const result = restore(externallyEdited);
    expect(result.source).toContain('color:blue');
    expect(result.source).toContain('>New</p>');
    expect(result.source).toContain('max-width: 30ch');
  });

  it('captures whole margin shorthand/logical family and corner height only when touched', () => {
    const source = '<p data-readable-id="copy" style="margin: 1px 2px !important; margin-inline-start: 3px; margin-top: 4px; height: 5em; block-size: 6em; display:inline">Text</p>';
    const first = apply(source, [
      { property: 'margin-left', value: '30px', priority: '' },
      { property: 'height', value: '200px', priority: '' },
      { property: 'display', value: 'inline-block', priority: '' },
    ]);
    expect(first.record?.ownedFamilies).toEqual(['horizontal-size', 'margins', 'vertical-size', 'display']);
    expect(first.record?.before.map((d) => d.property)).toEqual(['margin', 'margin-inline-start', 'margin-top', 'height', 'block-size', 'display']);
    const restored = restore(first.source);
    expect(apply(restored.source, [
      { property: 'margin-left', value: '30px', priority: '' },
      { property: 'height', value: '200px', priority: '' },
      { property: 'display', value: 'inline-block', priority: '' },
    ]).record?.before).toEqual(first.record?.before);
  });

  it('adds newly touched families on update without rebasing the first before', () => {
    const first = apply('<p data-readable-id="copy" style="width:20px; display:inline">T</p>');
    const updated = success(editWidthRelease(first.source, {
      kind: 'update', target, preferredCssPx: 720,
      declarations: [{ property: 'display', value: 'inline-block', priority: '' }],
      causes: ['own-inline-display'], mode: 'auto',
    }));
    expect(updated.record?.before).toEqual([
      { property: 'width', value: '20px', priority: '' },
      { property: 'display', value: 'inline', priority: '' },
    ]);
    expect(updated.record?.causes).toEqual(['own-max-width', 'own-inline-display']);
    expect(updated.record?.mode).toBe('auto');
  });

  it('allocates durable IDs atomically against the exact positional source', () => {
    const source = '<aside data-readable-id="rw-1"></aside><p>Text</p>';
    const first = success(editWidthRelease(source, {
      kind: 'apply', target: { sourcePath: 'path-1', tag: 'p' }, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-width'], declarations,
    }));
    expect(first.selection).toEqual({ targetId: 'rw-2', tag: 'p' });
    expect(first.record?.targetId).toBe('rw-2');
    const moved = first.source.replace('<aside data-readable-id="rw-1"></aside>', '') + '<aside></aside>';
    const restored = success(editWidthRelease(moved, { kind: 'restore', target: first.selection! }));
    expect(restored.source).toContain('<p data-readable-id="rw-2">Text</p>');
  });

  it('resolves source paths relative to the browser document body even for head-bearing fragments', () => {
    const source = '<style>p{max-width:65ch}</style><p>Text</p>';
    const first = success(editWidthRelease(source, {
      kind: 'apply', target: { sourcePath: 'path-0', tag: 'p' }, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-width'], declarations,
    }));
    expect(first.source.startsWith('<style>p{max-width:65ch}</style><p ')).toBe(true);
    expect(first.selection?.tag).toBe('p');
  });

  it('supports source offsets and table fragments without document reserialization', () => {
    const source = '<!--x--><tr><td>Cell</td></tr>';
    const first = success(editWidthRelease(source, {
      kind: 'apply', target: { startTagOffset: source.indexOf('<td>'), tag: 'td' }, expectedSource: source,
      preferredCssPx: 720, causes: ['own-max-width'], declarations,
    }));
    expect(first.source.startsWith('<!--x--><tr><td')).toBe(true);
    expect(first.source.endsWith('>Cell</td></tr>')).toBe(true);
  });

  it('ignores serialization-only CSS whitespace during validation', () => {
    const first = apply('<p data-readable-id="copy">Text</p>');
    const serialized = first.source.replace('width: min(720px, 100%);', 'WIDTH : min(720px,100%) ;');
    expect(restore(serialized).records).toEqual([]);
  });

  it('distinguishes absent declarations from an authored initial value', () => {
    const first = apply('<p data-readable-id="copy" style="width: initial">Text</p>');
    expect(first.record?.before).toEqual([{ property: 'width', value: 'initial', priority: '' }]);
    expect(restore(first.source).source).toContain('width: initial');
  });

  it('escapes metadata through the HTML serializer, including attribute/script payloads', () => {
    const source = '<p data-readable-id="copy">Text</p>';
    const payload = '\"\' & <img src=x onerror=alert(1)> </script>';
    const first = success(editWidthRelease(source, {
      kind: 'apply', target, expectedSource: source, preferredCssPx: 720, declarations,
      causes: ['own-max-width'], provenance: [{ property: 'max-width', value: 'var(--measure)', priority: '', selector: payload, conditions: [payload], complete: false }],
    }));
    expect(first.source).toContain('&quot;');
    const parsed = parseFragment(first.source);
    expect(parsed.childNodes).toHaveLength(1);
    expect(success(editWidthRelease(serialize(parsed), { kind: 'inspect' })).record).toBeUndefined();
    expect(success(editWidthRelease(serialize(parsed), { kind: 'inspect' })).records[0].provenance[0].selector).toBe(payload);
    expect(restore(serialize(parsed)).source).toBe(source);
  });

  it.each([
    ['width: min(720px, 100%);', 'width: 900px;', 'owned-declarations-changed'],
    ['max-width: stretch;', 'max-width: stretch !important;', 'owned-declarations-changed'],
    ['data-readable-id="copy"', 'data-readable-id="changed"', 'target-identity-changed'],
    ['<p ', '<div ', 'target-identity-changed'],
  ])('reports conflicts for changed ownership: %s', (from, to, reason) => {
    const first = apply('<p data-readable-id="copy">Text</p>');
    conflict(first.source.replace(from, to), reason);
  });

  it('detects deleted targets, duplicate targets and duplicate release IDs', () => {
    conflict('<section></section>', 'target-missing');
    const first = apply('<p data-readable-id="copy">Text</p>');
    conflict(first.source + first.source, 'duplicate-target');
    const clone = replaceRecord(first.source.replace('data-readable-id="copy"', 'data-readable-id="clone"'), (r) => { r.targetId = 'clone'; });
    conflict(first.source + clone, 'duplicate-release');
  });

  it('rejects stale source before allocating identity or updating', () => {
    const source = '<p>Text</p>';
    expect(editWidthRelease(source, {
      kind: 'apply', target: { sourcePath: 'path-0', tag: 'p' }, expectedSource: '<p>Old</p>',
      preferredCssPx: 720, declarations, causes: ['own-max-width'],
    })).toMatchObject({ ok: false, source, conflict: { reason: 'source-changed' } });
    const first = apply('<p data-readable-id="copy">Text</p>');
    expect(editWidthRelease(first.source, { kind: 'restore', target, expectedSource: source })).toMatchObject({ ok: false, conflict: { reason: 'source-changed' } });
  });

  it.each(['{bad', 'null', '[]', '{"schema":"readable.width-release.v2"}'])('refuses malformed/future metadata: %s', (record) => {
    const source = `<p data-readable-id="copy" data-readable-width-release='${record}'>Text</p>`;
    const result = editWidthRelease(source, { kind: 'inspect' });
    expect(result).toMatchObject({ ok: false, source, conflict: { reason: record.includes('v2') ? 'unsupported-schema' : 'invalid-record' } });
  });

  it('rejects forged record fields, invalid CSS and extra schema fields', () => {
    const first = apply('<p data-readable-id="copy">Text</p>');
    for (const mutate of [
      (r: Record<string, unknown>) => { r.before = [{ property: 'flex', value: 'none', priority: '' }]; },
      (r: Record<string, unknown>) => { r.extra = true; },
      (r: Record<string, unknown>) => { r.after = [{ property: 'width', value: '1px; color:red', priority: '' }]; },
    ]) conflict(replaceRecord(first.source, mutate), 'invalid-record');
  });

  it.each([
    { property: 'flex', value: 'none', priority: '' },
    { property: '--measure', value: 'none', priority: '' },
    { property: 'overflow', value: 'visible', priority: '' },
    { property: 'max-width', value: 'none', priority: '' },
    { property: 'width', value: '900px!important', priority: '' },
    { property: 'width', value: '1px; color:red', priority: '' },
  ] as WidthReleaseDeclaration[])('never creates structural overrides or injected declarations: %j', (declaration) => {
    const source = '<p data-readable-id="copy">Text</p>';
    expect(editWidthRelease(source, {
      kind: 'apply', target, expectedSource: source, preferredCssPx: 720,
      causes: ['own-max-width'], declarations: [declaration],
    })).toMatchObject({ ok: false, source, conflict: { reason: 'invalid-operation' } });
  });

  it('preserves measured important own-cap declarations through update and restore', () => {
    const source = '<style>.copy{max-width:65ch!important}</style><p data-readable-id="copy" class="copy" style="color:red">Text</p>';
    const important = declarations.map(declaration => ({ ...declaration, priority: declaration.property === 'max-width' ? 'important' as const : declaration.priority }));
    const first = success(editWidthRelease(source, { kind: 'apply', target, expectedSource: source, preferredCssPx: 720,
      causes: ['own-max-width'], declarations: important }));
    expect(first.record!.after).toEqual(important);
    const updated = success(editWidthRelease(first.source, { kind: 'update', target, preferredCssPx: 700,
      declarations: important.map(d => d.property === 'width' ? { ...d, value: 'min(700px, 100%)' } : d) }));
    expect(updated.record!.before).toEqual(first.record!.before);
    expect(updated.record!.after.find(d => d.property === 'max-width')?.priority).toBe('important');
    const restored = restore(updated.source).source;
    // Source-owned declarations restore semantically; separators inserted next
    // to an unrelated declaration need not reproduce its original whitespace.
    expect(restored).toMatch(/^<style>\.copy\{max-width:65ch!important\}<\/style><p data-readable-id="copy" class="copy" style="color:red;\s*">Text<\/p>$/);
    expect(success(editWidthRelease(restored, { kind: 'inspect' })).records).toEqual([]);
  });

  it('does not truncate escaped JSON containing the attribute carrier closing tag', () => {
    const source = '<p data-readable-id="copy">Text</p>';
    const selector = '></span><script>never executed</script>';
    const first = success(editWidthRelease(source, {
      kind: 'apply', target, expectedSource: source, preferredCssPx: 720, declarations,
      causes: ['own-max-width'], provenance: [{ property: 'max-width', value: '65ch', priority: '', selector, conditions: [] }],
    }));
    expect(success(editWidthRelease(first.source, { kind: 'inspect' })).records[0].provenance[0].selector).toBe(selector);
    expect(restore(first.source).source).toBe(source);
  });

  it.each(['<p data-readable-id=copy title=x/>Text</p>', '<img data-readable-id=copy title="x"/>'])('preserves slash semantics in start tags: %s', (source) => {
    const tag = source.startsWith('<img') ? 'img' : 'p';
    const first = success(editWidthRelease(source, { kind: 'apply', target: { targetId: 'copy', tag }, expectedSource: source, preferredCssPx: 720, declarations, causes: ['own-max-width'] }));
    const before = parseFragment(source).childNodes[0];
    const after = parseFragment(first.source).childNodes[0];
    if (!('attrs' in before) || !('attrs' in after)) throw new Error('Expected elements');
    expect(after.attrs.find((a) => a.name === 'title')).toEqual(before.attrs.find((a) => a.name === 'title'));
    expect(success(editWidthRelease(first.source, { kind: 'inspect' })).records).toHaveLength(1);
  });

  it('keeps existing durable identity bytes untouched', () => {
    const source = "<p DATA-READABLE-ID = 'copy'>Text</p>";
    const first = apply(source);
    expect(first.source).toContain("DATA-READABLE-ID = 'copy'");
    expect(restore(first.source).source).toBe(source);
  });

  it('rejects alias reordering and releases on a reused identity', () => {
    const first = apply('<p data-readable-id="copy" style="inline-size:30px">T</p>');
    const reordered = first.source.replace('inline-size: 30px; width: min(720px, 100%);', 'width: min(720px, 100%); inline-size: 30px;');
    conflict(reordered, 'owned-declarations-changed');
    expect(editWidthRelease(first.source, { kind: 'restore', target: { ...target, releaseId: 'wr-other' } })).toMatchObject({ ok: false, conflict: { reason: 'target-identity-changed' } });
  });

  it('finds records in template content and preserves unrelated ones on restore', () => {
    const source = '<template><p data-readable-id="copy">T</p></template><p data-readable-id="other">U</p>';
    const first = apply(source);
    const second = success(editWidthRelease(first.source, { kind: 'apply', target: { targetId: 'other' }, expectedSource: first.source, preferredCssPx: 720, declarations, causes: ['own-max-width'] }));
    expect(second.record?.id).not.toBe(first.record?.id);
    expect(restore(second.source).records).toEqual([second.record]);
  });

  it('refuses duplicate owned attributes and malformed inline CSS instead of guessing', () => {
    for (const source of [
      '<p data-readable-id="copy" style="width:1px" style="width:2px">Text</p>',
      '<p data-readable-id="copy" style="width:; broken">Text</p>',
    ]) {
      expect(editWidthRelease(source, { kind: 'apply', target, expectedSource: source, preferredCssPx: 720, causes: ['own-max-width'], declarations }).ok).toBe(false);
    }
  });
});
