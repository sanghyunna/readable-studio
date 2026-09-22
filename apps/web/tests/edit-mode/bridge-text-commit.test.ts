import { expect, it, vi } from 'vitest';
import { JSDOM } from './bridge-dom';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';

it.each(['Enter', 'Escape'])('commits text once when %s removes focus from the inline editor', (key) => {
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
