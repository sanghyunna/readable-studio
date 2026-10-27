import { expect, it, vi } from 'vitest';
import { JSDOM } from './bridge-dom';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';

it('keeps Enter inside the text editor for a new paragraph instead of committing the shape', () => {
  const dom = new JSDOM(
    `<h1 data-readable-id="copy"><b>제 1막, OO를 OO합니다.</b></h1>${buildManualEditBridge(true)}`,
    { runScripts: 'dangerously', url: 'http://localhost' },
  );
  const target = dom.window.document.querySelector('h1')!;
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'readable-edit-begin-text-edit', id: 'copy' },
  }));
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  target.dispatchEvent(enter);

  expect(target.getAttribute('contenteditable')).toBe('true');
  expect(enter.defaultPrevented).toBe(false);
  expect(postMessage.mock.calls.filter(([message]) => /readable-edit-(?:text|html)-commit/.test(message.type))).toEqual([]);
});

it('keeps a Korean composition Escape inside the native editor', () => {
  const dom = new JSDOM(`<p data-readable-id="copy">한글</p>${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-begin-text-edit', id: 'copy' } }));
  const target = dom.window.document.querySelector('p')!;
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
  target.dispatchEvent(escape);
  expect(target.getAttribute('contenteditable')).toBe('true');
  expect(escape.defaultPrevented).toBe(false);
});

it('stamps text commits with the document epoch that owns the edit session', () => {
  const dom = new JSDOM(`<p data-readable-id="copy">Original</p>${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'document-a' });
  send({ type: 'readable-edit-begin-text-edit', id: 'copy' });
  const target = dom.window.document.querySelector('p')!;
  target.textContent = 'Changed';
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'readable-edit-text-commit', value: 'Changed', documentEpoch: 'document-a', sequence: expect.any(Number),
  }), '*');
});

it('does not commit a stale text session after the document epoch changes', () => {
  const dom = new JSDOM(`<p data-readable-id="copy">Original</p>${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'document-a' });
  send({ type: 'readable-edit-begin-text-edit', id: 'copy' });
  const target = dom.window.document.querySelector('p')!;
  target.textContent = 'Old draft';
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'document-b' });
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
  target.dispatchEvent(new dom.window.FocusEvent('blur'));

  expect(postMessage.mock.calls.filter(([message]) => /readable-edit-(?:text|html)-commit/.test(message.type))).toEqual([]);
});

it('ignores stale flush commands and stamps the matching acknowledgement with its epoch', () => {
  const dom = new JSDOM(`<p data-readable-id="copy">Original</p>${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'document-b' });
  send({ type: 'readable-edit-begin-text-edit', id: 'copy' });
  const target = dom.window.document.querySelector('p')!;
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
  send({ type: 'readable-edit-end-text-edit', requestId: 1, documentEpoch: 'document-a' });
  expect(target.getAttribute('contenteditable')).toBe('true');
  expect(postMessage.mock.calls.filter(([message]) => message.type === 'readable-edit-text-flushed')).toEqual([]);
  send({ type: 'readable-edit-end-text-edit', requestId: 2, documentEpoch: 'document-b' });
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'readable-edit-text-flushed', requestId: 2, documentEpoch: 'document-b', sequence: expect.any(Number),
  }), '*');
});

it.each(['Escape'])('commits text once when %s removes focus from the inline editor', (key) => {
  // Given Chromium's synchronous blur when a focused editor loses contenteditable.
  const dom = new JSDOM(
    `<p data-readable-id="copy">Original</p>${buildManualEditBridge(true)}`,
    { runScripts: 'dangerously', url: 'http://localhost' },
  );
  const target = dom.window.document.querySelector('p');
  if (!target) throw new Error('Missing text fixture');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'readable-edit-begin-text-edit', id: 'copy' },
  }));
  target.textContent = 'Changed';
  const removeAttribute = target.removeAttribute.bind(target);
  vi.spyOn(target, 'removeAttribute').mockImplementation((name) => {
    const wasEditable = target.hasAttribute('contenteditable');
    removeAttribute(name);
    if (name === 'contenteditable' && wasEditable) {
      target.dispatchEvent(new dom.window.FocusEvent('blur'));
    }
  });
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

  // When committing with the keyboard while the browser synchronously blurs.
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));

  // Then one user edit contributes exactly one canonical-source history entry.
  const commits = postMessage.mock.calls.filter(([message]) => message.type === 'readable-edit-text-commit');
  expect(commits).toEqual([[{ type: 'readable-edit-text-commit', id: 'copy', value: 'Changed' }, '*']]);
});
