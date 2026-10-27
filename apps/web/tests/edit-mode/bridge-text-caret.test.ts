import { expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from './bridge-dom';

it('keeps a stale text click point inside its requested shape instead of selecting adjacent text', () => {
  const dom = new JSDOM(`<p data-readable-id="copy">Copy</p><p id="adjacent">Keep this text</p>${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: 'http://localhost',
  });
  const target = dom.window.document.querySelector('[data-readable-id="copy"]')!;
  const adjacent = dom.window.document.querySelector('#adjacent')!;
  const outside = dom.window.document.createRange();
  outside.selectNodeContents(adjacent);
  outside.collapse(true);
  Object.defineProperty(dom.window.document, 'caretRangeFromPoint', { value: () => outside });

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
    type: 'readable-edit-begin-text-edit', id: 'copy', textEditPoint: { clientX: 200, clientY: 300 },
  } }));

  expect(target.contains(dom.window.getSelection()!.anchorNode)).toBe(true);
  expect(adjacent.textContent).toBe('Keep this text');
});

function textClickFixture() {
  const dom = new JSDOM(`<p data-readable-id="copy" style="width:400px;height:40px">Alpha Bravo</p>${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: 'http://localhost',
  });
  const target = dom.window.document.querySelector<HTMLElement>('[data-readable-id="copy"]')!;
  target.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 400, 40);
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [new dom.window.DOMRect(0, 0, 400, 40)] });
  const clicked = dom.window.document.createRange();
  clicked.setStart(target.firstChild!, 8);
  clicked.collapse(true);
  Object.defineProperty(dom.window.document, 'caretRangeFromPoint', { value: () => clicked.cloneRange() });
  Object.defineProperty(dom.window.document, 'elementFromPoint', { value: () => target });
  Object.defineProperty(dom.window.document, 'elementsFromPoint', { value: () => [target] });
  const post = vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'readable-edit-select' || !message.beginTextEdit) return;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
      type: 'readable-edit-begin-text-edit', id: 'copy',
      ...(message.textEditPoint ? { textEditPoint: message.textEditPoint } : {}),
    } }));
  });
  return { dom, target, post };
}

it('preserves the native noncollapsed text drag when entering the editor', () => {
  const { dom, target, post } = textClickFixture();
  const dragged = dom.window.document.createRange();
  dragged.setStart(target.firstChild!, 0);
  dragged.setEnd(target.firstChild!, 5);
  dom.window.getSelection()!.addRange(dragged);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 10 }));
  const entry = post.mock.calls.map(([message]) => message).find((message) => message.beginTextEdit);
  expect(entry).toBeDefined();
  expect(entry).not.toHaveProperty('textEditPoint');
  expect(dom.window.getSelection()!.toString()).toBe('Alpha');
  expect(target.getAttribute('contenteditable')).toBe('true');
  dom.window.close();
});

it('keeps an explicit overlay click ahead of a stale select-all range', () => {
  const { dom, target, post } = textClickFixture();
  const selected = dom.window.document.createRange();
  selected.selectNodeContents(target);
  dom.window.getSelection()!.addRange(selected);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'copy' } }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
    type: 'readable-edit-click', selectedId: 'copy', clientX: 80, clientY: 10,
  } }));
  const entry = post.mock.calls.map(([message]) => message).find((message) => message.beginTextEdit);
  expect(entry?.textEditPoint).toEqual({ clientX: 80, clientY: 10 });
  expect(dom.window.getSelection()!.isCollapsed).toBe(true);
  expect(dom.window.getSelection()!.anchorOffset).toBe(8);
  expect(target.textContent).toBe('Alpha Bravo');
  dom.window.close();
});
