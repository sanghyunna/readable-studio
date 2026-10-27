import { describe, expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from './bridge-dom';

function fixture(extra = '') {
  const dom = new JSDOM(
    `<p data-readable-id="first">First shape</p><p data-readable-id="hidden" style="display:none">Hidden shape</p><p data-readable-id="second">Second shape</p>${extra}${buildManualEditBridge(true)}`,
    { runScripts: 'dangerously', url: 'http://localhost' },
  );
  for (const element of dom.window.document.querySelectorAll('[data-readable-id]')) {
    element.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 170, bottom: 60, width: 160, height: 50, toJSON: () => ({}) });
  }
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'keyboard-document' },
  }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'readable-edit-selected-target', id: 'first', revision: 7 },
  }));
  const post = vi.spyOn(dom.window.parent, 'postMessage');
  const key = (value: string, options: KeyboardEventInit = {}, target: Element | Document = dom.window.document) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };
  return { dom, post, key };
}

describe('PowerPoint object keyboard commands in the preview', () => {
  it.each(['Enter', 'F2'])('%s enters the selected text shape through the ordinary selection funnel', (key) => {
    const editor = fixture();
    const event = editor.key(key);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-select', target: expect.objectContaining({ id: 'first' }), beginTextEdit: true, selectAll: true,
    }), '*');
  });

  it.each(['Enter', 'F2'])('%s selects all text when the host authorizes keyboard text entry', (key) => {
    const editor = fixture();
    editor.key(key);
    editor.dom.window.dispatchEvent(new editor.dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-begin-text-edit', id: 'first', selectAll: true }, source: editor.dom.window.parent,
    }));
    expect(editor.dom.window.getSelection()?.toString()).toBe('First shape');
  });

  it('Backspace removes only the selected object and suppresses held-key repeats', () => {
    const editor = fixture();
    for (const repeat of [false, true, true]) {
      expect(editor.key('Backspace', { repeat }).defaultPrevented).toBe(true);
    }
    const deletes = editor.post.mock.calls.filter(([message]) => message.type === 'readable-edit-delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.[0]).toEqual(expect.objectContaining({ targetId: 'first', revision: 7 }));
  });

  it('Tab and Shift+Tab cycle visible objects, skip hidden shapes and wrap', () => {
    const editor = fixture();
    expect(editor.key('Tab').defaultPrevented).toBe(true);
    expect(editor.key('Tab').defaultPrevented).toBe(true);
    expect(editor.key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(editor.post.mock.calls.filter(([message]) => message.type === 'readable-edit-select')
      .map(([message]) => message.target.id)).toEqual(['second', 'first', 'second']);
  });

  it('Ctrl+D requests one validated duplicate with the current document and selection identities', () => {
    const editor = fixture();
    expect(editor.key('d', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(editor.key('d', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    const duplicates = editor.post.mock.calls.filter(([message]) => message.type === 'readable-edit-duplicate');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.[0]).toEqual(expect.objectContaining({
      targetId: 'first', revision: 7, documentEpoch: 'keyboard-document',
    }));
  });

  it.each([
    ['input', '<input id="native">'],
    ['editable text', '<div contenteditable="true"><span id="native">Text</span></div>'],
    ['ARIA widget', '<div role="combobox"><span id="native">Choice</span></div>'],
  ])('keeps object shortcuts native in %s', (_label, markup) => {
    const editor = fixture(markup);
    const native = editor.dom.window.document.getElementById('native')!;
    for (const key of ['Enter', 'F2', 'Backspace', 'Tab', 'd']) {
      expect(editor.key(key, { ctrlKey: key === 'd' }, native).defaultPrevented).toBe(false);
    }
    expect(editor.post.mock.calls.filter(([message]) => /readable-edit-(?:select|delete|duplicate)$/.test(message.type))).toEqual([]);
  });

  it('leaves object shortcuts untouched during IME composition', () => {
    const editor = fixture();
    for (const key of ['Enter', 'F2', 'Backspace', 'Tab', 'd']) {
      expect(editor.key(key, { isComposing: true, ctrlKey: key === 'd' }).defaultPrevented).toBe(false);
    }
    expect(editor.post.mock.calls.filter(([message]) => /readable-edit-(?:select|delete|duplicate)$/.test(message.type))).toEqual([]);
  });
});
