// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from '../edit-mode/bridge-dom';

const source = '<!doctype html><html><body><p data-readable-id="first">First shape</p><p data-readable-id="second">Second shape</p></body></html>';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  const writes: string[] = [];
  const file = { name: 'keyboard.html', path: 'keyboard.html', type: 'file' as const, size: 100, mtime: 1, mime: 'text/html', kind: 'html' as const };
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    return new Response(source);
  }));
  render(<FileViewer projectId="keyboard" projectKind="prototype" liveHtml={source} file={file} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const dom = new JSDOM(`${source}${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  for (const element of dom.window.document.querySelectorAll('[data-readable-id]')) {
    element.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 170, bottom: 60, width: 160, height: 50, toJSON: () => ({}) });
  }
  const send = (data: object, sender = frame.contentWindow) => window.dispatchEvent(new MessageEvent('message', { source: sender, data }));
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => { send(message); });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    if (!/^readable-edit-duplicate-/.test(message.type)) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message, source: dom.window.parent }));
    }
  });
  await act(async () => { fireEvent.load(frame); });
  const first = dom.window.document.querySelector('[data-readable-id="first"]')!;
  await act(async () => { first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  const surface = () => {
    const element = document.querySelector<HTMLElement>('[data-readable-edit-primary-surface]')
      ?? document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]');
    expect(element).not.toBeNull();
    return element!;
  };
  const key = async (value: string, options: KeyboardEventInit = {}, element = surface()) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    await act(async () => { element.dispatchEvent(event); });
    return event;
  };
  const save = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  return { dom, frame, post, send, first, surface, key, writes, save };
}

describe('PowerPoint object shortcuts from the host selection surface', () => {
  it.each(['Enter', 'F2'])('%s enters the selected shape through the existing text bridge', async (key) => {
    const editor = await mount();
    expect((await editor.key(key)).defaultPrevented).toBe(true);
    expect(editor.first.getAttribute('contenteditable')).toBe('true');
    expect(editor.dom.window.getSelection()?.toString()).toBe('First shape');
    expect(editor.writes).toEqual([]);
  });

  it('Tab and Shift+Tab use visible preview object order from the host surface', async () => {
    const editor = await mount();
    expect((await editor.key('Tab')).defaultPrevented).toBe(true);
    expect(editor.dom.window.document.querySelector('[data-readable-edit-selected]')?.getAttribute('data-readable-id')).toBe('second');
    expect((await editor.key('Tab', { shiftKey: true })).defaultPrevented).toBe(true);
    expect(editor.dom.window.document.querySelector('[data-readable-edit-selected]')?.getAttribute('data-readable-id')).toBe('first');
    expect(editor.writes).toEqual([]);
  });

  it('Backspace is one canonical deletion with Undo/Redo and explicit Save', async () => {
    const editor = await mount();
    expect((await editor.key('Backspace')).defaultPrevented).toBe(true);
    expect(editor.writes).toEqual([]);
    const first = () => editor.dom.window.document.querySelector('[data-readable-id="first"]');
    await waitFor(() => expect(first()).toBeNull());
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await waitFor(() => expect(first()?.textContent).toBe('First shape'));
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    expect(first()?.textContent).toBe('First shape');
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }); });
    await waitFor(() => expect(first()).toBeNull());
    await editor.save();
    expect(editor.writes).toHaveLength(1);
    expect(new DOMParser().parseFromString(editor.writes[0]!, 'text/html').body.textContent).toBe('Second shape');
  });

  it('Ctrl+D follows validated duplicate geometry acknowledgements and creates one Undo entry', async () => {
    const editor = await mount();
    expect((await editor.key('d', { ctrlKey: true })).defaultPrevented).toBe(true);
    const latest = (type: string) => editor.post.mock.calls.map(([message]) => message).filter((message) => message.type === type).at(-1);
    await waitFor(() => expect(latest('readable-edit-duplicate-create')).toBeTruthy());
    const create = latest('readable-edit-duplicate-create');
    expect(create.originalId).toBe('first');
    expect(create.duplicateRootId).not.toBe('first');
    await act(async () => { editor.send({
      type: 'readable-edit-duplicate-preview', documentEpoch: create.documentEpoch,
      transactionId: create.transactionId, sequence: create.sequence, ok: true,
      rect: { x: 10, y: 10, width: 160, height: 50 }, placementOffset: { x: 0, y: 0 },
    }); });
    await waitFor(() => expect(latest('readable-edit-duplicate-update')).toBeTruthy());
    const update = latest('readable-edit-duplicate-update');
    await act(async () => { editor.send({
      type: 'readable-edit-duplicate-preview', documentEpoch: update.documentEpoch,
      transactionId: update.transactionId, sequence: update.sequence, ok: true,
      rect: { x: 34, y: 34, width: 160, height: 50 }, placementOffset: { x: 0, y: 0 },
    }); });
    expect(editor.writes).toEqual([]);
    const duplicateInPreview = () => editor.dom.window.document.querySelector(`[data-readable-id="${create.duplicateRootId}"]`);
    await waitFor(() => expect(duplicateInPreview()).not.toBeNull());
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await waitFor(() => expect(duplicateInPreview()).toBeNull());
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    expect(duplicateInPreview()).toBeNull();
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }); });
    await waitFor(() => expect(duplicateInPreview()).not.toBeNull());
    await editor.save();
    expect(editor.writes).toHaveLength(1);
    const saved = new DOMParser().parseFromString(editor.writes[0]!, 'text/html');
    const original = saved.querySelector<HTMLElement>('[data-readable-id="first"]')!;
    const duplicate = saved.querySelector<HTMLElement>(`[data-readable-id="${create.duplicateRootId}"]`)!;
    expect(original.textContent).toBe('First shape');
    expect(original.style.translate).toBe('');
    expect(duplicate.textContent).toBe('First shape');
    expect(duplicate.style.translate).not.toBe('');
    expect(saved.querySelectorAll(`[data-readable-id="${create.duplicateRootId}"]`)).toHaveLength(1);
  });

  it.each([{ isComposing: true }, { altKey: true }])('keeps non-owned host shortcut native: %j', async (options) => {
    const editor = await mount();
    expect((await editor.key('Enter', options)).defaultPrevented).toBe(false);
    expect(editor.first.hasAttribute('contenteditable')).toBe(false);
    expect(editor.writes).toEqual([]);
  });
});
