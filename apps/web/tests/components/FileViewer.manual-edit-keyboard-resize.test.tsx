// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

const source = '<!doctype html><html><body><div data-readable-id="shape" style="width:100px;height:50px">Shape</div></body></html>';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(centerTranslate?: string) {
  const file = { name: 'resize-keys.html', path: 'resize-keys.html', type: 'file' as const, size: 100, mtime: 1, mime: 'text/html', kind: 'html' as const };
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    return new Response(source);
  }));
  render(<FileViewer projectId="keyboard-resize" projectKind="prototype" liveHtml={source} file={file} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'readable-edit-preview-style' || !message.resize) return;
    const request = message.resize;
    const requested = request.requested;
    send({
      ...request, type: 'readable-edit-preview-style-applied', id: 'shape', version: message.version, ok: true,
      rect: { x: 10 - (requested.width - 100) / 2, y: 10 - (requested.height - 50) / 2, ...requested },
      centerStyles: { translate: centerTranslate ?? `${-(requested.width - 100) / 2}px ${-(requested.height - 50) / 2}px` },
      resize: { ...request, constraints: [], decision: 'ordinary', announce: true },
    });
  });
  const target: ManualEditTarget = {
    id: 'shape', kind: 'container', label: 'Shape', tagName: 'div', className: '', text: 'Shape',
    rect: { x: 10, y: 10, width: 100, height: 50 }, cssSize: { width: '100px', height: '50px' },
    fields: {}, attributes: {}, styles: { ...emptyManualEditStyles(), width: '100px', height: '50px' },
    isLayoutContainer: false, outerHtml: '<div data-readable-id="shape" style="width:100px;height:50px">Shape</div>',
  };
  await act(async () => { fireEvent.load(frame); send({ type: 'readable-edit-select', target }); });
  const surface = () => document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]')!;
  const key = (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    surface().dispatchEvent(event);
    return event;
  };
  const save = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  return { post, writes, key, save, surface };
}

describe('PowerPoint object arrow modifiers', () => {
  it('Ctrl+Arrow nudges instead of being ignored and remains one canonical undoable edit', async () => {
    const editor = await mount();
    await act(async () => {
      expect(editor.key('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(true);
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight', ctrlKey: true });
    });
    await editor.save();
    expect(editor.writes).toHaveLength(1);
    const shape = new DOMParser().parseFromString(editor.writes[0]!, 'text/html').querySelector<HTMLElement>('[data-readable-id="shape"]')!;
    expect(shape.style.translate).toBe('1px 0px');
    expect(shape.style.width).toBe('100px');
  });

  it('duplicates from the newly centered placement instead of a previous nudge preview', async () => {
    const editor = await mount('-4px 0px');
    await act(async () => {
      editor.key('ArrowRight', { ctrlKey: true });
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight', ctrlKey: true });
    });
    await act(async () => {
      editor.key('ArrowRight', { shiftKey: true });
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight' });
    });
    await act(async () => { editor.key('d', { ctrlKey: true }); });
    const create = () => editor.post.mock.calls.map(([message]) => message).find((message) => message.type === 'readable-edit-duplicate-create');
    await waitFor(() => expect(create()).toBeTruthy());
    expect(create().baselineTranslate).toBe('-4px 0px');
  });

  it('held Shift+Right grows width by10% per key around its center, with one Undo for the held burst', async () => {
    const editor = await mount();
    await act(async () => {
      expect(editor.key('ArrowRight', { shiftKey: true }).defaultPrevented).toBe(true);
      expect(editor.key('ArrowRight', { shiftKey: true, repeat: true }).defaultPrevented).toBe(true);
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight' });
    });
    const finals = editor.post.mock.calls.filter(([message]) => message.resize?.stage === 'finalize');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[0].resize.requested).toEqual(expect.objectContaining({ width: 121, height: 50, fromCenter: true }));
    expect(editor.writes).toEqual([]);
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }); });
    await editor.save();
    expect(editor.writes).toHaveLength(1);
    const shape = new DOMParser().parseFromString(editor.writes[0]!, 'text/html').querySelector<HTMLElement>('[data-readable-id="shape"]')!;
    expect(shape.style.width).toBe('121px');
    expect(shape.style.height).toBe('50px');
    expect(shape.style.translate).toBe('-10.5px 0px');
  });

  it.each([
    ['ArrowUp', '55px', '0px -2.5px'],
    ['ArrowDown', '45px', '0px 2.5px'],
  ])('uses the documented OfficeArt vertical resize convention for Shift+%s', async (key, height, translate) => {
    const editor = await mount();
    await act(async () => {
      editor.key(key, { shiftKey: true });
      fireEvent.keyUp(editor.surface(), { key });
    });
    await editor.save();
    expect(editor.writes).toHaveLength(1);
    const shape = new DOMParser().parseFromString(editor.writes[0]!, 'text/html').querySelector<HTMLElement>('[data-readable-id="shape"]')!;
    expect(shape.style.width).toBe('100px');
    expect(shape.style.height).toBe(height);
    expect(shape.style.translate).toBe(translate);
  });

  it('Escape cancels a held Shift resize and suppresses its repeats until keyup', async () => {
    const editor = await mount();
    await act(async () => {
      editor.key('ArrowRight', { shiftKey: true });
      editor.key('Escape');
      editor.key('ArrowRight', { shiftKey: true, repeat: true });
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight' });
    });
    expect(editor.post.mock.calls.filter(([message]) => message.resize?.stage === 'cancel')).toHaveLength(1);
    expect(editor.post.mock.calls.filter(([message]) => message.resize?.stage === 'finalize')).toHaveLength(0);
    expect(editor.writes).toEqual([]);
  });

  it('rejects malformed centered placement acknowledgement without saving partial dimensions', async () => {
    const editor = await mount('calc(10px) 0px');
    await act(async () => {
      editor.key('ArrowRight', { shiftKey: true });
      fireEvent.keyUp(editor.surface(), { key: 'ArrowRight' });
    });
    expect(editor.writes).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeNull();
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const shape = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector<HTMLElement>('[data-readable-id="shape"]')!;
    expect(shape.style.width).toBe('100px');
    expect(shape.style.translate).toBe('');
  });
});
