// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';
import { JSDOM } from './bridge-dom';

async function fixture(source: string) {
  const dom = new JSDOM(buildSrcdoc(source, { editBridge: true }), { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window.parent }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'preview-epoch' });
  const sync = (beforeSource: string, afterSource: string, beforeId: string | null, afterId: string | null) => {
    send({ type: 'readable-edit-preview-source', documentEpoch: 'preview-epoch', requestId: 1, beforeSource, afterSource, beforeId, afterId });
  };
  return { dom, document: dom.window.document, sync };
}

describe('source-backed direct-edit preview synchronization', () => {
  it('updates the edited text without replacing the document, slide, or unchanged text nodes', async () => {
    const before = '<html><body><section data-readable-id="slide" class="slide"><h1 data-readable-id="title">Original</h1><p data-readable-id="other">Keep caret</p></section></body></html>';
    const after = before.replace('Original', 'Updated');
    const h = await fixture(before);
    const slide = h.document.querySelector('section')!;
    const title = h.document.querySelector('h1')!;
    const other = h.document.querySelector('p')!;
    const listener = vi.fn();
    title.addEventListener('authored-listener', listener);
    slide.classList.add('active');
    (slide as HTMLElement).style.transform = 'translateX(-1920px)';
    const text = other.firstChild!;
    const range = h.document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    h.dom.window.getSelection()!.addRange(range);

    h.sync(before, after, 'title', 'title');

    expect(title.textContent).toBe('Updated');
    expect(h.document.querySelector('h1')).toBe(title);
    expect(h.document.querySelector('section')).toBe(slide);
    expect(slide.className).toBe('slide active');
    expect((slide as HTMLElement).style.transform).toBe('translateX(-1920px)');
    expect(h.dom.window.getSelection()!.anchorNode).toBe(text);
    expect(h.dom.window.getSelection()!.anchorOffset).toBe(3);
    title.dispatchEvent(new h.dom.window.Event('authored-listener'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('changes only authored class tokens and style properties, including removals and priorities', async () => {
    const before = '<html><body><p data-readable-id="text" class="old slide" style="color: red; --accent: blue !important">Title</p></body></html>';
    const after = '<html><body><p data-readable-id="text" class="new slide" style="--accent: green">Title</p></body></html>';
    const h = await fixture(before);
    const target = h.document.querySelector('p')!;
    target.classList.add('active');
    target.style.transform = 'translateX(200px)';
    h.sync(before, after, 'text', 'text');
    expect(target.classList.contains('old')).toBe(false);
    expect(target.classList.contains('new')).toBe(true);
    expect(target.classList.contains('active')).toBe(true);
    expect(target.style.color).toBe('');
    expect(target.style.getPropertyValue('--accent')).toBe('green');
    expect(target.style.getPropertyPriority('--accent')).toBe('');
    expect(target.style.transform).toBe('translateX(200px)');
  });

  it('deletes and restores a path-only target while preserving and rebasing its following sibling', async () => {
    const before = '<html><body><main><p>Remove me</p><p>Keep me</p></main></body></html>';
    const after = '<html><body><main><p>Keep me</p></main></body></html>';
    const h = await fixture(before);
    const kept = h.document.querySelectorAll('p')[1]!;
    h.sync(before, after, 'path-0-0', null);
    expect(h.document.querySelectorAll('p')).toHaveLength(1);
    expect(h.document.querySelector('p')).toBe(kept);
    expect(kept.getAttribute('data-readable-source-path')).toBe('path-0-0');

    h.sync(after, before, null, 'path-0-0');
    expect(Array.from(h.document.querySelectorAll('p'), (node) => node.textContent)).toEqual(['Remove me', 'Keep me']);
    expect(h.document.querySelectorAll('p')[1]).toBe(kept);
    expect(kept.getAttribute('data-readable-source-path')).toBe('path-0-1');
  });

  it('promotes an existing duplicate preview rather than adding another duplicate', async () => {
    const before = '<html><body><main data-readable-id="root"><p data-readable-id="original">Title</p><p data-readable-id="other">Other</p></main></body></html>';
    const after = before.replace('<p data-readable-id="other">', '<p data-readable-id="duplicate" style="translate: 20px 20px">Title</p><p data-readable-id="other">');
    const h = await fixture(before);
    const preview = h.document.querySelector('p')!.cloneNode(true) as HTMLElement;
    preview.setAttribute('data-readable-id', 'duplicate');
    preview.setAttribute('data-readable-edit-transient', 'true');
    preview.style.translate = '20px 20px';
    h.document.querySelector('main')!.insertBefore(preview, h.document.querySelectorAll('p')[1]!);
    h.sync(before, after, null, 'duplicate');
    expect(h.document.querySelectorAll('[data-readable-id="duplicate"]')).toHaveLength(1);
    expect(h.document.querySelector('[data-readable-id="duplicate"]')).toBe(preview);
    expect(preview.hasAttribute('data-readable-edit-transient')).toBe(false);
    expect(preview.style.translate).toBe('20px 20px');
  });

  it('rejects a changed script before applying any visible changes', async () => {
    const before = '<html><body><p data-readable-id="title">Original</p><script>window.example = 1;</script></body></html>';
    const after = before.replace('Original', 'Updated').replace('example = 1', 'example = 2');
    const h = await fixture(before);
    const post = vi.spyOn(h.dom.window.parent, 'postMessage');
    h.sync(before, after, 'title', 'title');
    expect(h.document.querySelector('p')!.textContent).toBe('Original');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-preview-source-applied', requestId: 1, ok: false }), '*');
  });

  it('restores an inline target before its authored text sibling without replacing the sibling', async () => {
    const before = '<html><body><p data-readable-id="paragraph">Before <span data-readable-id="word">word</span> after</p></body></html>';
    const after = before.replace('<span data-readable-id="word">word</span>', '');
    const h = await fixture(before);
    const paragraph = h.document.querySelector('p')!;
    const tail = paragraph.lastChild!;
    h.sync(before, after, 'word', null);
    expect(paragraph.textContent).toBe('Before  after');
    h.sync(after, before, null, 'word');
    expect(paragraph.textContent).toBe('Before word after');
    expect(paragraph.lastChild).toBe(tail);
    expect(paragraph.querySelector('span')!.nextSibling).toBe(tail);
  });

  it('replays body style history without restarting the page or changing runtime styles', async () => {
    const before = '<html><body style="background-color: red"><p data-readable-id="title">Title</p></body></html>';
    const after = before.replace('background-color: red', 'background-color: blue');
    const h = await fixture(before);
    h.document.body.style.transform = 'translateX(20px)';
    const text = h.document.querySelector('p')!;
    h.sync(before, after, '__body__', '__body__');
    expect(h.document.body.style.backgroundColor).toBe('blue');
    expect(h.document.body.style.transform).toBe('translateX(20px)');
    expect(h.document.querySelector('p')).toBe(text);
  });

  it('updates a nested authored font style without replacing its text or sibling', async () => {
    const before = '<html><body><p data-readable-id="title"><span style="font-weight: 400">Original</span><span>Keep</span></p></body></html>';
    const after = before.replace('font-weight: 400', 'font-weight: 700');
    const h = await fixture(before);
    const target = h.document.querySelector('span')!;
    const text = target.firstChild;
    const sibling = target.nextSibling;
    h.sync(before, after, 'title', 'title');
    expect(target.style.fontWeight).toBe('700');
    expect(target.firstChild).toBe(text);
    expect(target.nextSibling).toBe(sibling);
    h.sync(after, before, 'title', 'title');
    expect(target.style.fontWeight).toBe('400');
  });

  it('acknowledges an already edited line break while preserving the active caret', async () => {
    const before = '<html><body><p data-readable-id="title"><span>Hello</span>world</p></body></html>';
    const after = before.replace('</span>world', '</span><br>world');
    const h = await fixture(before);
    const target = h.document.querySelector('p')!;
    const text = target.lastChild!;
    target.insertBefore(h.document.createElement('br'), text);
    const range = h.document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    h.dom.window.getSelection()!.addRange(range);
    h.sync(before, after, 'title', 'title');
    expect(target.querySelectorAll('br')).toHaveLength(1);
    expect(target.lastChild).toBe(text);
    expect(h.dom.window.getSelection()!.anchorNode).toBe(text);
    expect(h.dom.window.getSelection()!.anchorOffset).toBe(2);
  });

  it('rebases a generated heading identity before accepting the next path-only edit', async () => {
    const before = '<html><body><main><p>Remove me</p><h1>Keep me</h1></main></body></html>';
    const after = before.replace('<p>Remove me</p>', '');
    const next = after.replace('Keep me', 'Next edit');
    const h = await fixture(before);
    const heading = h.document.querySelector('h1')!;
    expect(heading.getAttribute('data-readable-id')).toBe('path-0-1');
    h.sync(before, after, 'path-0-0', null);
    expect(heading.getAttribute('data-readable-id')).toBe('path-0-0');
    h.sync(after, next, 'path-0-0', 'path-0-0');
    expect(heading.textContent).toBe('Next edit');
    expect(h.document.querySelector('h1')).toBe(heading);
  });

  it('restores the generated heading identity for comment and inspect discovery', async () => {
    const before = '<html><body><main><h1>Restore title</h1><p>Keep me</p></main></body></html>';
    const after = before.replace('<h1>Restore title</h1>', '');
    const h = await fixture(before);
    h.sync(before, after, 'path-0-0', null);
    h.sync(after, before, null, 'path-0-0');
    const heading = h.document.querySelector('h1')!;
    expect(heading.getAttribute('data-readable-id')).toBe('path-0-0');
    expect(Array.from(h.document.querySelectorAll('[data-readable-id], [data-screen-label]'))).toContain(heading);
    expect(h.document.querySelector('p')!.hasAttribute('data-readable-id')).toBe(false);
    expect(before).not.toContain('data-readable-id');
  });

  it('keeps the legacy edit script inert and mapped while replaying a text edit', async () => {
    const before = '<html><body><p data-readable-id="title">Original</p><script src="assets/readable-direct-edit.js?version=1"></script></body></html>';
    const after = before.replace('Original', 'Updated');
    const h = await fixture(before);
    const legacy = h.document.querySelector('script[src]')!;
    expect(legacy.getAttribute('type')).toBe('application/x-readable-disabled-script');
    const body = h.document.body;
    const post = vi.spyOn(h.dom.window.parent, 'postMessage');
    h.sync(before, after, 'title', 'title');
    expect(h.document.querySelector('p')!.textContent).toBe('Updated');
    expect(h.document.body).toBe(body);
    expect(h.document.querySelector('script[src]')).toBe(legacy);
    expect(legacy.getAttribute('type')).toBe('application/x-readable-disabled-script');
    expect(legacy.hasAttribute('data-readable-disabled-edit-bridge')).toBe(true);
    expect(legacy.getAttribute('src')).toBe('assets/readable-direct-edit.js?version=1');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-preview-source-applied', ok: true }), '*');
  });

  it('rebases a generated SVG identity that has no discovery source-path annotation', async () => {
    const before = '<html><body><main><p>Remove me</p><svg role="img" aria-label="Icon"><path id="shape" d="M0 0h10v10z"></path></svg></main></body></html>';
    const after = before.replace('<p>Remove me</p>', '');
    const h = await fixture(before);
    const shape = h.document.querySelector('path')!;
    expect(shape.getAttribute('data-readable-id')).toBe('path-0-1-0');
    expect(shape.hasAttribute('data-readable-source-path')).toBe(false);
    h.sync(before, after, 'path-0-0', null);
    expect(shape.getAttribute('data-readable-id')).toBe('path-0-0-0');
    expect(shape.getAttribute('id')).toBe('shape');
    h.sync(after, before, null, 'path-0-0');
    expect(shape.getAttribute('data-readable-id')).toBe('path-0-1-0');
    expect(h.document.querySelector('path')).toBe(shape);
  });

  it('keeps script nodes excluded from automatic target identities', async () => {
    const before = '<html><body><p data-readable-id="title">Original</p><script id="authored-script">window.marker = 1;</script></body></html>';
    const after = before.replace('Original', 'Updated');
    const h = await fixture(before);
    const script = h.document.querySelector('#authored-script')!;
    expect(script.hasAttribute('data-readable-id')).toBe(false);
    h.sync(before, after, 'title', 'title');
    expect(h.document.querySelector('p')!.textContent).toBe('Updated');
    expect(script.hasAttribute('data-readable-id')).toBe(false);
    expect(script.hasAttribute('data-readable-source-path')).toBe(false);
    expect(h.document.querySelector('#authored-script')).toBe(script);
  });
});
