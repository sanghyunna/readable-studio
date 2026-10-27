// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { applyManualEditPreviewSource } from '../../src/edit-mode/preview-source-sync';
import { MANUAL_EDIT_RICH_TEXT_FORMAT_CSS } from '../../src/edit-mode/rich-text-formatting';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

const marker = 'data-readable-text-format-style';
const css = MANUAL_EDIT_RICH_TEXT_FORMAT_CSS;
const stylesheet = `<style ${marker}="1">${css}</style>`;
const formatted = '<span data-readable-text-format="" style="font-weight: 400 !important">Original</span>';
const full = '<!doctype html><html><head><title>Document</title></head><body><main data-readable-id="root"><p data-readable-id="title">Original</p><p>Keep</p></main></body></html>';
const fragment = '<main data-readable-id="root"><h1>Original</h1><p>Keep</p></main>';

function fixture(source: string) {
  // The private, inert DOM proves stylesheet identity; Chromium owns CSS rendering QA.
  const document = new DOMParser().parseFromString(source, 'text/html');
  const style = document.createElement('style');
  style.setAttribute(marker, '1');
  style.textContent = css;
  document.head.prepend(style);
  document.querySelector('main')!.setAttribute('data-readable-source-path', 'path-0');
  Array.from(document.querySelector('main')!.children).forEach((node, index) => {
    node.setAttribute('data-readable-source-path', `path-0-${index}`);
  });
  if (!document.querySelector('h1')?.hasAttribute('data-readable-id')) document.querySelector('h1')?.setAttribute('data-readable-id', 'path-0-0');
  const sync = (before: string, after: string, id = 'title') => applyManualEditPreviewSource(
    document, before, after, id, id, 'main,p,h1', 'main,h1', css,
  );
  return { document, style, sync };
}

describe('managed rich-text stylesheet preview bootstrap', () => {
  it.each([
    { name: 'full HTML head', before: full, after: full.replace('<head>', `<head>${stylesheet}`).replace('Original', formatted), id: 'title' },
    { name: 'managed fragment promotion to full HTML', before: fragment, after: `<!doctype html><html><head>${stylesheet}</head><body>${fragment.replace('Original', formatted)}</body></html>`, id: 'path-0-0' },
  ])('keeps the first format, Undo and Redo in the same document for $name', ({ before, after, id }) => {
    const h = fixture(before);
    const body = h.document.body;
    const root = h.document.querySelector('main')!;
    const target = root.firstElementChild!;
    const sibling = target.nextElementSibling!;
    target.innerHTML = formatted;
    const liveSpan = target.firstElementChild;

    expect(h.sync(before, after, id)).toBe(true);
    expect(target.firstElementChild).toBe(liveSpan);
    expect(h.sync(after, before, id)).toBe(true);
    expect(target.innerHTML).toBe('Original');
    expect(h.sync(before, after, id)).toBe(true);
    expect(target.querySelector('[data-readable-text-format]')).not.toBeNull();
    expect(h.document.body).toBe(body);
    expect(h.document.querySelector('main')).toBe(root);
    expect(root.firstElementChild).toBe(target);
    expect(target.nextElementSibling).toBe(sibling);
    expect(sibling.getAttribute('data-readable-source-path')).toBe('path-0-1');
    expect(h.document.querySelectorAll(`[${marker}]`)).toHaveLength(1);
    expect(h.document.querySelector(`[${marker}]`)).toBe(h.style);
    expect(h.style.parentElement).toBe(h.document.head);
    expect(h.style.hasAttribute('data-readable-source-path')).toBe(false);
    expect(before).not.toContain(marker);
    expect(after).toContain(stylesheet);
  });

  it('continues ordinary source replay when only the runtime owns the stylesheet', () => {
    const h = fixture(full);
    expect(h.sync(full, full.replace('Original', 'Updated'))).toBe(true);
    expect(h.document.querySelector('[data-readable-id="title"]')!.textContent).toBe('Updated');
    expect(h.document.querySelector(`[${marker}]`)).toBe(h.style);
  });

  it('rejects intermediate BODY stylesheet placement even when the runtime rule moved to HEAD', () => {
    const before = `${fragment.replace('Original', formatted)}${stylesheet}`;
    const document = new DOMParser().parseFromString(buildSrcdoc(before, { editBridge: true }), 'text/html');
    const style = document.querySelector(`[${marker}]`)!;
    expect(Array.from(style.attributes, (item) => [item.name, item.value])).toEqual([[marker, '1']]);
    document.head.prepend(style);
    const heading = document.querySelector('h1')!;
    const sibling = document.querySelector('main')!.lastElementChild!;
    const after = before.replace('Original', 'Updated');
    expect(applyManualEditPreviewSource(document, before, after, 'path-0-0', 'path-0-0', 'main,p,h1,span', 'main,h1', css)).toBe(false);
    expect(heading.textContent).toBe('Original');
    expect(document.querySelector('h1')).toBe(heading);
    expect(document.querySelector('main')!.lastElementChild).toBe(sibling);
    expect(document.querySelector(`[${marker}]`)).toBe(style);
    expect(style.hasAttribute('data-readable-source-path')).toBe(false);
  });

  it('preserves an authored leading stylesheet and path-only target through fragment promotion history', () => {
    const before = '<style>@layer authored{b{font-size:40px!important;color:purple!important}}</style><div><b>Text</b></div>';
    const text = formatted.replace('Original', 'Text');
    const after = `<!doctype html><html><head>${stylesheet}</head><body>${before.replace('<b>Text</b>', text)}</body></html>`;
    const document = new DOMParser().parseFromString(buildSrcdoc(before, { editBridge: true }), 'text/html');
    const target = document.querySelector('div')!;
    const authoredStyle = document.body.querySelector('style')!;
    expect(target.getAttribute('data-readable-source-path')).toBe('path-1');
    const ownedStyle = document.createElement('style');
    ownedStyle.setAttribute(marker, '1');
    ownedStyle.textContent = css;
    document.head.prepend(ownedStyle);
    target.innerHTML = text;
    const sync = (oldSource: string, newSource: string) => applyManualEditPreviewSource(
      document, oldSource, newSource, 'path-1', 'path-1', 'div,b,span', '[id]', css,
    );

    expect(sync(before, after)).toBe(true);
    expect(sync(after, before)).toBe(true);
    expect(target.querySelector('b')!.textContent).toBe('Text');
    expect(sync(before, after)).toBe(true);
    expect(target.querySelector('[data-readable-text-format]')!.textContent).toBe('Text');
    expect(document.querySelector('div')).toBe(target);
    expect(target.getAttribute('data-readable-source-path')).toBe('path-1');
    expect(document.body.firstElementChild).toBe(authoredStyle);
    expect(document.body.children.item(1)).toBe(target);
    expect(document.querySelector(`[${marker}]`)).toBe(ownedStyle);
  });

  it.each(['Visible tail', '<aside>Authored tail</aside>'])('rejects authored content following the canonical stylesheet: %s', (tail) => {
    const body = fragment.replace('Original', formatted);
    const before = `${body}${stylesheet}${tail}`;
    const after = before.replace('Original', 'Updated');
    const h = fixture(`${body}${tail}`);
    expect(h.sync(before, after, 'path-0-0')).toBe(false);
    expect(h.document.querySelector('h1')!.textContent).toBe('Original');
  });

  it.each([
    { name: 'changed stylesheet text', change: (source: string) => source.replace(css, `${css} `) },
    { name: 'extra stylesheet attribute', change: (source: string) => source.replace(`<style ${marker}="1">`, `<style ${marker}="1" media="all">`) },
    { name: 'duplicate canonical marker', change: (source: string) => source.replace('</head>', `${stylesheet}</head>`) },
    { name: 'wrong marker value', change: (source: string) => source.replace(`${marker}="1"`, `${marker}="2"`) },
    { name: 'late owned stylesheet', change: (source: string) => source.replace(stylesheet, '').replace('</head>', `${stylesheet}</head>`) },
    { name: 'unrelated head change', change: (source: string) => source.replace('<title>Document</title>', '<title>Changed</title>') },
  ])('rejects $name before changing the rendered target', ({ change }) => {
    const h = fixture(full);
    const after = change(full.replace('<head>', `<head>${stylesheet}`).replace('Original', formatted));
    expect(h.sync(full, after)).toBe(false);
    expect(h.document.querySelector('[data-readable-id="title"]')!.innerHTML).toBe('Original');
    expect(h.document.querySelector(`[${marker}]`)).toBe(h.style);
  });

  it.each(['missing', 'changed text', 'extra attribute', 'duplicate'] as const)('requires the exact single live stylesheet: %s', (variant) => {
    const h = fixture(full);
    if (variant === 'missing') h.style.remove();
    if (variant === 'changed text') h.style.textContent += ' ';
    if (variant === 'extra attribute') h.style.setAttribute('id', 'lookalike');
    if (variant === 'duplicate') h.document.head.append(h.style.cloneNode(true));
    const after = full.replace('<head>', `<head>${stylesheet}`).replace('Original', formatted);
    expect(h.sync(full, after)).toBe(false);
    expect(h.document.querySelector('[data-readable-id="title"]')!.innerHTML).toBe('Original');
  });

  it('rejects a fragment stylesheet placed before authored content', () => {
    const h = fixture(fragment);
    expect(h.sync(fragment, `${stylesheet}${fragment.replace('Original', formatted)}`, 'path-0-0')).toBe(false);
    expect(h.document.querySelector('h1')!.innerHTML).toBe('Original');
  });

  it('rejects first-format CSS added at the fragment BODY tail', () => {
    const h = fixture(fragment);
    expect(h.sync(fragment, `${fragment.replace('Original', formatted)}${stylesheet}`, 'path-0-0')).toBe(false);
    expect(h.document.querySelector('h1')!.innerHTML).toBe('Original');
  });

  it('rejects modifications to an existing canonical managed stylesheet', () => {
    const before = full.replace('<head>', `<head>${stylesheet}`);
    const h = fixture(full);
    expect(h.sync(before, before.replace(css, `${css} `).replace('Original', formatted))).toBe(false);
    expect(h.document.querySelector('[data-readable-id="title"]')!.innerHTML).toBe('Original');
  });

  it('rejects stylesheet removal while durable formatting markers survive', () => {
    const before = full.replace('<head>', `<head>${stylesheet}`).replace('Original', formatted);
    const after = before.replace(stylesheet, '').replace('Original', 'Updated');
    const h = fixture(full);
    h.document.querySelector('[data-readable-id="title"]')!.innerHTML = formatted;
    expect(h.sync(before, after)).toBe(false);
    expect(h.document.querySelector('[data-readable-id="title"]')!.innerHTML).toBe(formatted);
    expect(h.document.querySelector(`[${marker}]`)).toBe(h.style);
  });
});
