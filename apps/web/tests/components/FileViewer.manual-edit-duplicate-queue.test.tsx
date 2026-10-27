// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from '../edit-mode/bridge-dom';

const source = '<!doctype html><html><body><p data-readable-id="first" style="width:160px;height:50px">First shape</p><p data-readable-id="second" style="width:160px;height:50px">Second shape</p></body></html>';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(deferFirstSave = false) {
  const writes: string[] = [];
  let releaseSave!: (response: Response) => void;
  const pendingSave = new Promise<Response>((resolve) => { releaseSave = resolve; });
  let announceSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { announceSave = resolve; });
  const file = { name: 'duplicate-queue.html', path: 'duplicate-queue.html', type: 'file' as const, size: 100, mtime: 1, mime: 'text/html', kind: 'html' as const };
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      announceSave();
      if (deferFirstSave && writes.length === 1) return pendingSave;
      return Response.json({ file });
    }
    return new Response(source);
  }));
  render(<FileViewer projectId="duplicate-queue" projectKind="prototype" liveHtml={source} file={file} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const dom = new JSDOM(`${source}${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: 'http://localhost',
    beforeParse(window) {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        const values = (this.style.translate || '0px 0px').split(/\s+/).map(Number.parseFloat);
        const x = 10 + (values[0] || 0);
        const y = 10 + (values[1] || 0);
        return { x, y, left: x, top: y, right: x + 160, bottom: y + 50, width: 160, height: 50, toJSON: () => ({}) };
      };
    },
  });
  await dom.loaded;
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => { send(message); });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    // Geometry is acknowledged explicitly below; all canonical source and
    // selection messages run through the actual injected bridge.
    if (!/^readable-edit-duplicate-/.test(message.type)) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message, source: dom.window.parent }));
    }
  });
  await act(async () => { fireEvent.load(frame); });
  await act(async () => {
    dom.window.document.querySelector('[data-readable-id="first"]')!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  const surface = () => document.querySelector<HTMLElement>('[data-readable-edit-primary-surface]')
    ?? document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]');
  const creates = () => post.mock.calls.map(([message]) => message).filter((message) => message.type === 'readable-edit-duplicate-create');
  const acknowledge = async (index: number) => {
    await waitFor(() => expect(creates()).toHaveLength(index + 1));
    const create = creates()[index]!;
    await act(async () => { send({
      type: 'readable-edit-duplicate-preview', documentEpoch: create.documentEpoch,
      transactionId: create.transactionId, sequence: create.sequence, ok: true,
      rect: { x: 10 + index * 16, y: 10 + index * 16, width: 160, height: 50 }, placementOffset: { x: 0, y: 0 },
    }); });
    const updates = () => post.mock.calls.map(([message]) => message).filter((message) =>
      message.type === 'readable-edit-duplicate-update' && message.transactionId === create.transactionId);
    await waitFor(() => expect(updates().length).toBeGreaterThan(0));
    const update = updates().at(-1)!;
    await act(async () => { send({
      type: 'readable-edit-duplicate-preview', documentEpoch: update.documentEpoch,
      transactionId: update.transactionId, sequence: update.sequence, ok: true,
      rect: { x: 26 + index * 16, y: 26 + index * 16, width: 160, height: 50 }, placementOffset: { x: 0, y: 0 },
    }); });
    await waitFor(() => expect(dom.window.document.querySelector(`[data-readable-id="${create.duplicateRootId}"]`)).not.toBeNull());
    await waitFor(() => expect(dom.window.document.querySelector('[data-readable-edit-selected]')?.getAttribute('data-readable-id')).toBe(create.duplicateRootId));
    return create;
  };
  const history = (redo = false) => act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: redo }); });
  const duplicate = () => {
    const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, repeat: false, bubbles: true, cancelable: true });
    surface()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  const select = (id: string) => act(async () => {
    dom.window.document.querySelector(`[data-readable-id="${id}"]`)!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  const selectedId = () => post.mock.calls.map(([message]) => message)
    .filter((message) => message.type === 'readable-edit-selected-target').at(-1)?.id;
  const startSave = async () => {
    await act(async () => { fireEvent.keyDown(surface()!, { key: 'Enter' }); });
    const first = dom.window.document.querySelector('[data-readable-id="first"]')!;
    expect(first.getAttribute('contenteditable')).toBe('true');
    await act(async () => {
      first.textContent = 'Changed first shape';
      first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await saveStarted;
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Changed first shape');
  };
  const failSave = () => act(async () => { releaseSave(Response.json({ message: 'disk unavailable' }, { status: 500 })); });
  return { dom, writes, surface, creates, acknowledge, history, duplicate, select, selectedId, startSave, failSave };
}

it('serializes two distinct Ctrl+D presses before geometry ACK into successive canonical clones and separate Undo entries', async () => {
  const editor = await mount();
  await act(async () => {
    const surface = editor.surface();
    expect(surface).not.toBeNull();
    for (let index = 0; index < 2; index++) {
      const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, repeat: false, bubbles: true, cancelable: true });
      surface!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  const first = await editor.acknowledge(0);
  expect(first.originalId).toBe('first');
  const second = await editor.acknowledge(1);
  expect(second.originalId).toBe(first.duplicateRootId);
  expect(second.duplicateRootId).not.toBe(first.duplicateRootId);
  const find = (id: string) => editor.dom.window.document.querySelector<HTMLElement>(`[data-readable-id="${id}"]`);
  expect(['', 'none']).toContain(find('first')?.style.translate);
  expect(find(first.duplicateRootId)?.style.translate).toBe('16px 16px');
  expect(find(second.duplicateRootId)?.style.translate).toBe('32px 32px');
  expect(editor.writes).toEqual([]);

  await editor.history();
  await waitFor(() => expect(find(second.duplicateRootId)).toBeNull());
  expect(find(first.duplicateRootId)).not.toBeNull();
  await editor.history();
  await waitFor(() => expect(find(first.duplicateRootId)).toBeNull());
  expect(find('first')?.textContent).toBe('First shape');
  await editor.history(true);
  await waitFor(() => expect(find(first.duplicateRootId)).not.toBeNull());
  await editor.history(true);
  await waitFor(() => expect(find(second.duplicateRootId)).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  expect(editor.writes).toHaveLength(1);
  const saved = new DOMParser().parseFromString(editor.writes[0]!, 'text/html');
  const original = saved.querySelector<HTMLElement>('[data-readable-id="first"]')!;
  expect(original.textContent).toBe('First shape');
  expect(original.style.translate).toBe('');
  expect(original.style.width).toBe('160px');
  expect(original.style.height).toBe('50px');
  expect(saved.querySelector<HTMLElement>(`[data-readable-id="${first.duplicateRootId}"]`)?.style.translate).toBe('16px 16px');
  expect(saved.querySelector<HTMLElement>(`[data-readable-id="${second.duplicateRootId}"]`)?.style.translate).toBe('32px 32px');
  expect(saved.querySelector('[data-readable-id="second"]')?.textContent).toBe('Second shape');
  const ids = Array.from(saved.querySelectorAll('[data-readable-id]'), (node) => node.getAttribute('data-readable-id'));
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
});

it('keeps the redone clone selected when Redo follows Undo before Undo restored its selection', async () => {
  const editor = await mount();
  await act(async () => { editor.duplicate(); });
  const created = await editor.acknowledge(0);
  const find = (id: string) => editor.dom.window.document.querySelector<HTMLElement>(`[data-readable-id="${id}"]`);
  await act(async () => {
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  });
  await waitFor(() => expect(find(created.duplicateRootId)).not.toBeNull());
  // Let every queued target broadcast and selection round trip settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(editor.dom.window.document.querySelector('[data-readable-edit-selected]')?.getAttribute('data-readable-id')).toBe(created.duplicateRootId);
  expect(editor.selectedId()).toBe(created.duplicateRootId);
});

it('applies an arrow nudge pressed right after Tab to the newly cycled object', async () => {
  const editor = await mount();
  const find = (id: string) => editor.dom.window.document.querySelector<HTMLElement>(`[data-readable-id="${id}"]`);
  const key = (type: 'keydown' | 'keyup', name: string) => editor.dom.window.document.dispatchEvent(
    new editor.dom.window.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
  // The host is still committing the Tab selection when the arrow arrives.
  await act(async () => {
    key('keydown', 'Tab');
    key('keydown', 'ArrowRight');
    key('keyup', 'ArrowRight');
  });
  await waitFor(() => expect(find('second')?.style.translate).toBe('1px 0px'));
  expect(['', 'none']).toContain(find('first')?.style.translate);
  expect(editor.selectedId()).toBe('second');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  expect(editor.writes).toHaveLength(1);
  const saved = new DOMParser().parseFromString(editor.writes[0]!, 'text/html');
  expect(saved.querySelector<HTMLElement>('[data-readable-id="second"]')?.style.translate).toBe('1px 0px');
  expect(saved.querySelector<HTMLElement>('[data-readable-id="first"]')?.style.translate).toBe('');
});

it('does not inherit the old selection preflight when a deferred Save ends and Ctrl+D targets a new shape', async () => {
  const editor = await mount(true);
  await editor.startSave();
  vi.useFakeTimers();
  try {
    await act(async () => { editor.duplicate(); });
    expect(editor.creates()).toEqual([]);
    await editor.failSave();
    await editor.select('second');
    expect(editor.selectedId()).toBe('second');
    await act(async () => { editor.duplicate(); });
    // Complete the new context's zero-delay preparation, before A's50ms poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(editor.creates()).toHaveLength(1);
    expect(editor.creates()[0].originalId).toBe('second');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(editor.creates()).toHaveLength(1);
    expect(editor.writes).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps Ctrl+D queued through a deferred Save beyond the old120s deadline and resumes from save state', async () => {
  const editor = await mount(true);
  await editor.startSave();
  vi.useFakeTimers();
  try {
    await act(async () => { editor.duplicate(); });
    expect(editor.creates()).toEqual([]);
    // Move only the test clock; a single existing poll observes the old deadline.
    vi.setSystemTime(Date.now() + 120_001);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(editor.creates()).toEqual([]);
    await editor.failSave();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(editor.creates()).toHaveLength(1);
    expect(editor.creates()[0].originalId).toBe('first');
    expect(editor.writes).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
