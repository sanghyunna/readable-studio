import { expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from './bridge-dom';

function fixture() {
  const dom = new JSDOM(`<div data-readable-id="shape">Shape</div>${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'arrow-document' } }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'shape', revision: 3 } }));
  const post = vi.spyOn(dom.window.parent, 'postMessage');
  return { dom, post };
}

it('forwards Ctrl+Arrow through the existing selected-object nudge protocol', () => {
  const { dom, post } = fixture();
  const key = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge', direction: 'right', targetId: 'shape', revision: 3 }), '*');
});

it('forwards Shift+Arrow as a centered resize while preserving the existing arrow keyup burst end', () => {
  const { dom, post } = fixture();
  const key = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-keyboard-resize', direction: 'right', key: 'ArrowRight', targetId: 'shape', revision: 3, documentEpoch: 'arrow-document' }), '*');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge-commit', targetId: 'shape', revision: 3 }), '*');
});
