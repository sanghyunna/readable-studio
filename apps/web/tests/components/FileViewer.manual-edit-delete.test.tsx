// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { getEn } from '../../src/i18n/locales/en';
import type { ProjectFile } from '../../src/types';
import * as patches from '../../src/edit-mode/source-patches';
import { manualEditCanonicalSource, manualEditFrameEpoch } from './manual-edit-frame-messages';

const controls = vi.hoisted(() => ({
  current: null as ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar> | null,
}));
vi.mock('../../src/components/ManualEditShapeToolbar', async (original) => {
  const actual = await original<typeof import('../../src/components/ManualEditShapeToolbar')>();
  return { ...actual, ManualEditShapeToolbar: (props: ComponentProps<typeof actual.ManualEditShapeToolbar>) => {
    controls.current = props;
    return <actual.ManualEditShapeToolbar {...props} />;
  } };
});
import { FileViewer } from '../../src/components/FileViewer';

const en = getEn();
const html = '<!doctype html><html><body><div style="width: 160px; color: #111111">First</div><div>Second</div></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = {
  id: 'path-0', kind: 'container', label: 'First', tagName: 'div', className: '', text: 'First',
  rect: { x: 10, y: 10, width: 160, height: 48 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<div>First</div>',
};
afterEach(() => {
  cleanup();
  controls.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById('delete-inspector')?.remove();
});

async function mount(source = html, selected = target, holdSave = false, portal = false) {
  const writes: string[] = [];
  let releaseSave!: (response: Response) => void;
  const saveResponse = new Promise<Response>((resolve) => { releaseSave = resolve; });
  let announceSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { announceSave = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      announceSave();
      if (holdSave) return saveResponse;
      return Response.json({ file });
    }
    if (String(input).includes('/deployments')) return Response.json({ deployments: [] });
    return new Response(source);
  }));
  if (portal) {
    const host = document.createElement('div');
    host.id = 'delete-inspector';
    document.body.appendChild(host);
  }
  const props = { projectId: 'delete-host', projectKind: 'prototype' as const, file, liveHtml: source,
    ...(portal ? { manualEditPortalId: 'delete-inspector' } : {}) };
  const view = render(<FileViewer {...props} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  let documentEpoch = manualEditFrameEpoch(frame);
  const send = (data: object, sender = frame.contentWindow) => window.dispatchEvent(new MessageEvent('message', { source: sender, data: { documentEpoch, ...data } }));
  const select = async (next = selected, beginTextEdit = false) => {
    documentEpoch = manualEditFrameEpoch(frame);
    await act(async () => { send({ type: 'readable-edit-select', target: next, beginTextEdit }); });
  };
  await select();
  const revision = () => {
    const message = post.mock.calls.map(([value]) => value as { type: string; revision: number })
      .filter((value) => value.type === 'readable-edit-selected-target').at(-1);
    expect(message).toBeTruthy();
    return message!.revision;
  };
  const remove = () => send({ type: 'readable-edit-delete', targetId: selected.id, revision: revision() });
  const surface = () => {
    const element = document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]');
    expect(element).not.toBeNull();
    return element!;
  };
  const parsed = () => new DOMParser().parseFromString(manualEditCanonicalSource(frame), 'text/html');
  const text = () => Array.from(parsed().body.children).filter((node) => node.tagName === 'DIV').map((node) => node.textContent);
  const undo = () => act(async () => { send({ type: 'readable-edit-undo', redo: false }); });
  const redo = () => act(async () => { send({ type: 'readable-edit-undo', redo: true }); });
  const finalizeResize = (ok = true) => {
    const message = post.mock.calls.map(([value]) => value).filter((value) => value.resize?.stage === 'finalize').at(-1);
    expect(message).toBeTruthy();
    send({
      ...message.resize, type: 'readable-edit-preview-style-applied', id: selected.id, version: message.version, ok,
      rect: { ...selected.rect, ...message.resize.requested },
      resize: { ...message.resize, constraints: [], causes: [], decision: 'ordinary', announce: true },
    });
  };
  return { view, props, frame, post, send, select, revision, remove, surface, parsed, text, undo, redo, writes, finalizeResize, saveStarted, releaseSave };
}

describe('FileViewer shared delete transaction', () => {
  it.each(['host', 'iframe', 'toolbar'] as const)('deletes once from %s, preserves positional sibling, undo/redo and explicit Save', async (origin) => {
    const editor = await mount();
    const revision = editor.revision();
    await act(async () => {
      if (origin === 'host') {
        for (const repeat of [false, true, true]) fireEvent.keyDown(editor.surface(), { key: 'Delete', repeat });
      } else if (origin === 'iframe') {
        for (let index = 0; index < 3; index++) editor.remove();
      } else {
        controls.current!.onApplyPatch({ kind: 'remove-element', id: target.id }, en['manualEdit.deleteElement']);
      }
    });
    expect(editor.text()).toEqual(['Second']);
    expect(editor.writes).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { editor.send({ type: 'readable-edit-delete', targetId: target.id, revision }); });
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    expect(editor.text()).toEqual(['First', 'Second']);
    await editor.undo();
    expect(editor.text()).toEqual(['First', 'Second']);
    await editor.redo();
    expect(editor.text()).toEqual(['Second']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.saveChanges'] })); });
    expect(editor.writes).toHaveLength(1);
    expect(new DOMParser().parseFromString(editor.writes[0]!, 'text/html').body.textContent).toBe('Second');
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
    await editor.select();
    expect(controls.current!.canUndo).toBe(false);
  });

  it.each(['text', 'link'] as const)('deletes object-selected %s from the host', async (kind) => {
    const editor = await mount(html, { ...target, kind });
    await act(async () => { fireEvent.keyDown(editor.surface(), { key: 'Delete' }); });
    expect(editor.text()).toEqual(['Second']);
  });

  it.each([false, true])('keeps toolbar confirmation and flushes pending edits (portal: %s)', async (portal) => {
    const editor = await mount(html, target, false, portal);
    if (portal) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(en['manualEdit.groupAppearance']) }));
    } else {
      act(() => { controls.current!.onStyleField('color', '#123456'); });
      fireEvent.click(screen.getByRole('button', { name: en['manualEdit.shape.more'] }));
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.deleteElement'] })); });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.deleteElement'] })); });
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    expect(editor.text()).toEqual(['First', 'Second']);
    if (!portal) expect(editor.parsed().body.querySelector('div')!.style.color).toBe('rgb(18, 52, 86)');
    expect(editor.writes).toEqual([]);
  });

  it('rejects a stale toolbar callback rather than deleting the new selection', async () => {
    const editor = await mount();
    const applyFromOldRender = controls.current!.onApplyPatch;
    await editor.select({ ...target, id: 'path-1' });
    await act(async () => { applyFromOldRender({ kind: 'remove-element', id: target.id }, en['manualEdit.deleteElement']); });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { controls.current!.onApplyPatch({ kind: 'remove-element', id: 'path-1' }, en['manualEdit.deleteElement']); });
    expect(editor.text()).toEqual(['First']);
  });

  it.each([
    '<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"><span></span></div>',
    '<div role="textbox"><span></span></div>', '<div role="combobox"><span></span></div>',
    '<div role="slider"><span></span></div>', '<div role="spinbutton"><span></span></div>',
  ])('keeps native Delete for host descendants: %s', async (markup) => {
    const editor = await mount();
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    editor.surface().appendChild(holder);
    const native = holder.querySelector('span') ?? holder.firstElementChild!;
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    await act(async () => { native.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(editor.text()).toEqual(['First', 'Second']);
  });

  it.each([{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }])('ignores non-owned host Delete %j', async (options) => {
    const editor = await mount();
    await act(async () => { fireEvent.keyDown(editor.surface(), { key: 'Delete', ...options }); });
    expect(editor.text()).toEqual(['First', 'Second']);
  });

  it('rejects stale identity and foreign iframe, then releases the latch for a valid command', async () => {
    const editor = await mount();
    await act(async () => {
      editor.send({ type: 'readable-edit-delete', targetId: 'path-1', revision: editor.revision() });
      editor.send({ type: 'readable-edit-delete', targetId: target.id, revision: editor.revision() - 1 });
      editor.send({ type: 'readable-edit-delete', targetId: target.id, revision: editor.revision() }, window);
    });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
  });

  it('does not flush the newly requested selection after the first await', async () => {
    const editor = await mount();
    const revision = editor.revision();
    editor.post.mockClear();
    await act(async () => {
      editor.send({ type: 'readable-edit-delete', targetId: target.id, revision });
      editor.send({ type: 'readable-edit-select', target: { ...target, id: 'path-1' } });
    });
    expect(editor.text()).toEqual(['First', 'Second']);
    expect(editor.post.mock.calls.some(([message]) => message.type === 'readable-edit-click-cancel')).toBe(false);
    await act(async () => { editor.send({ type: 'readable-edit-delete', targetId: 'path-1', revision: editor.revision() }); });
    expect(editor.text()).toEqual(['First']);
  });

  it('rejects same-position replacement during the first await before a preview effect runs', async () => {
    const editor = await mount();
    await act(async () => {
      editor.remove();
      controls.current!.onApplyPatch({ id: target.id, kind: 'set-outer-html', html: '<div>Replacement</div>' }, 'Replace');
    });
    expect(editor.text()).toEqual(['Replacement', 'Second']);
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
  });

  it('holds one delete through deferred text flush and ignores repeated commands', async () => {
    const editor = await mount();
    await editor.select({ ...target, kind: 'text' }, true);
    await act(async () => { editor.remove(); editor.remove(); editor.remove(); });
    expect(editor.text()).toEqual(['First', 'Second']);
    const requests = editor.post.mock.calls.map(([message]) => message).filter((message) => message.type === 'readable-edit-end-text-edit');
    expect(requests).toHaveLength(1);
    await act(async () => { editor.send({ type: 'readable-edit-text-flushed', requestId: requests[0].requestId }); });
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    expect(editor.text()).toEqual(['First', 'Second']);
  });

  it('rejects a document switch while the session flush is pending', async () => {
    const editor = await mount();
    await editor.select({ ...target, kind: 'text' }, true);
    await act(async () => { editor.remove(); });
    const request = editor.post.mock.calls.map(([message]) => message).find((message) => message.type === 'readable-edit-end-text-edit');
    expect(request).toBeTruthy();
    await act(async () => {
      editor.view.rerender(<FileViewer {...editor.props} file={{ ...file, name: 'next.html', path: 'next.html' }} liveHtml={html.replace('First', 'New first')} />);
      editor.send({ type: 'readable-edit-text-flushed', requestId: request.requestId });
    });
    expect(editor.text()).toEqual(['New first', 'Second']);
    expect(editor.writes).toEqual([]);
  });

  it('rejects revision advancement during a text flush and accepts a fresh command', async () => {
    const editor = await mount();
    await editor.select({ ...target, kind: 'text' }, true);
    await act(async () => { editor.remove(); });
    const request = editor.post.mock.calls.map(([message]) => message).find((message) => message.type === 'readable-edit-end-text-edit');
    expect(request).toBeTruthy();
    await act(async () => { editor.send({ type: 'readable-edit-text-commit', id: target.id, value: 'Edited first' }); });
    await act(async () => { editor.send({ type: 'readable-edit-text-flushed', requestId: request.requestId }); });
    expect(editor.text()).toEqual(['Edited first', 'Second']);
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    expect(editor.text()).toEqual(['Edited first', 'Second']);
  });

  it('keeps a new selection after the session flush without deleting it or the old target', async () => {
    const editor = await mount();
    await editor.select({ ...target, kind: 'text' }, true);
    await act(async () => { editor.remove(); });
    await act(async () => { editor.send({ type: 'readable-edit-select', target: { ...target, id: 'path-1' } }); });
    const requests = editor.post.mock.calls.map(([message]) => message).filter((message) => message.type === 'readable-edit-end-text-edit');
    expect(requests).toHaveLength(2);
    await act(async () => {
      for (const request of requests) editor.send({ type: 'readable-edit-text-flushed', requestId: request.requestId });
    });
    expect(editor.text()).toEqual(['First', 'Second']);
    expect(controls.current!.target.id).toBe('path-1');
    await act(async () => { editor.send({ type: 'readable-edit-delete', targetId: 'path-1', revision: editor.revision() }); });
    expect(editor.text()).toEqual(['First']);
  });

  it('leaves active inline editing and keys outside the selected host surface native', async () => {
    const editor = await mount();
    await act(async () => {
      editor.send({ type: 'readable-edit-selection-state', editing: true, hasSelection: false, bold: false, italic: false, underline: false });
    });
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    await act(async () => { editor.surface().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Delete' }); });
    expect(editor.text()).toEqual(['First', 'Second']);
  });

  it('does not delete during Save or retry after persistence settles', async () => {
    const editor = await mount(html, target, true);
    act(() => { controls.current!.onStyleField('color', '#123456'); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['manualEdit.saveChanges'] }));
      await editor.saveStarted;
    });
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { editor.releaseSave(Response.json({ file })); });
    expect(editor.writes).toHaveLength(1);
    expect(editor.text()).toEqual(['First', 'Second']);
  });

  it.each([false, true])('rejects Delete during a synchronous history refresh (redo: %s)', async (redo) => {
    const editor = await mount();
    await act(async () => { controls.current!.onApplyPatch({ kind: 'set-style', id: target.id, styles: { color: '#123456' } }, 'Style'); });
    if (redo) await editor.undo();
    const apply = vi.spyOn(patches, 'applyManualEditPatch');
    let attempts = 0;
    editor.post.mockImplementation((message) => {
      if (message.type !== 'readable-edit-preview-source' || message.beforeId !== target.id || message.afterId !== target.id) return;
      attempts++;
      editor.send({ type: 'readable-edit-delete', targetId: target.id, revision: editor.revision(), documentEpoch: message.documentEpoch });
    });
    if (redo) await editor.redo();
    else await editor.undo();
    expect(attempts).toBeGreaterThan(0);
    expect(apply.mock.calls.filter(([, patch]) => patch.kind === 'remove-element')).toHaveLength(0);
    expect(editor.text()).toEqual(['First', 'Second']);
    editor.post.mockImplementation(() => {});
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
  });

  it.each(['move', 'resize'] as const)('does not delete while pointer %s owns the gesture', async (gesture) => {
    const editor = await mount();
    const surface = gesture === 'resize' ? screen.getByLabelText('Resize bottom-right corner')
      : screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 140 });
    });
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { fireEvent.pointerCancel(surface, { pointerId: 1 }); });
    const cancel = editor.post.mock.calls.map(([message]) => message).filter((message) => message.resize?.stage === 'cancel').at(-1);
    if (cancel) await act(async () => { editor.send({ ...cancel.resize, type: 'readable-edit-preview-style-applied', id: target.id, version: cancel.version, ok: true }); });
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
  });

  it('preserves a failed resize flush error and selection, then releases the latch', async () => {
    const editor = await mount();
    await act(async () => { controls.current!.onStyleField('width', '240'); });
    await act(async () => { editor.remove(); editor.remove(); });
    await act(async () => { editor.finalizeResize(false); });
    expect(editor.text()).toEqual(['First', 'Second']);
    expect(controls.current!.target.id).toBe(target.id);
    expect(controls.current!.error).toBe(en['manualEdit.error.previewStyleFailed']);
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['First', 'Second']);
    expect(controls.current!.error).toBe(en['manualEdit.error.previewStyleFailed']);
    await act(async () => { controls.current!.onStyleField('width', '220'); });
    await act(async () => { editor.finalizeResize(); });
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
    expect(editor.writes).toEqual([]);
  });

  it('does not flush or cancel a duplicate awaiting geometry, and accepts a later command', async () => {
    const editor = await mount();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    let announceCreate!: (message: { documentEpoch: string; transactionId: string; sequence: number }) => void;
    const created = new Promise<{ documentEpoch: string; transactionId: string; sequence: number }>((resolve) => { announceCreate = resolve; });
    editor.post.mockImplementation((message) => {
      if (message.type === 'readable-edit-duplicate-create') announceCreate(message);
    });
    const surface = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    let request!: Awaited<typeof created>;
    await act(async () => {
      fireEvent.pointerDown(surface, { pointerId: 4, clientX: 100, clientY: 100, ctrlKey: true });
      fireEvent.pointerMove(surface, { pointerId: 4, clientX: 130, clientY: 140, ctrlKey: true });
      request = await created;
      fireEvent.pointerUp(surface, { pointerId: 4, clientX: 130, clientY: 140, ctrlKey: true });
    });
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['First', 'Second']);
    expect(editor.post.mock.calls.filter(([message]) => message.type === 'readable-edit-duplicate-remove')).toHaveLength(0);
    expect(controls.current!.target.id).toBe(target.id);
    await act(async () => { editor.send({ ...request, type: 'readable-edit-duplicate-preview', ok: false }); });
    expect(controls.current!.error).toBe(en['manualEdit.error.duplicatePreviewFailed']);
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
    expect(editor.writes).toEqual([]);
  });

  it.each(['color', 'width'] as const)('flushes pending %s before delete so Undo preserves the edit', async (property) => {
    const editor = await mount();
    await act(async () => { controls.current!.onStyleField(property, property === 'width' ? '240' : '#123456'); });
    if (property === 'width') {
      await act(async () => { editor.remove(); });
      expect(editor.text()).toEqual(['First', 'Second']);
      await act(async () => { editor.finalizeResize(); });
    } else {
      await act(async () => { editor.remove(); });
    }
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    const first = editor.parsed().body.querySelector('div')!;
    expect(first.style[property]).toBe(property === 'width' ? '240px' : 'rgb(18, 52, 86)');
    await editor.redo();
    expect(editor.text()).toEqual(['Second']);
    expect(editor.writes).toEqual([]);
  });

  it('flushes a keyboard nudge before Delete and preserves it on Undo', async () => {
    const editor = await mount();
    await act(async () => {
      fireEvent.keyDown(editor.surface(), { key: 'ArrowRight' });
      fireEvent.keyDown(editor.surface(), { key: 'Delete' });
    });
    expect(editor.text()).toEqual(['Second']);
    await editor.undo();
    expect(editor.parsed().body.querySelector('div')!.style.translate).toBe('1px 0px');
    await editor.redo();
    expect(editor.text()).toEqual(['Second']);
  });

  it.each(['root', 'last-child'])('keeps the canonical generic error for %s rejection', async (guard) => {
    const editor = await mount(guard === 'root' ? html.replace('<html>', '<html data-readable-id="root">') : '<html><body><div>First</div></body></html>', guard === 'root' ? { ...target, id: 'root', tagName: 'html' } : target);
    await act(async () => { editor.remove(); });
    expect(screen.getAllByRole('alert').some((node) => node.textContent === en['manualEdit.error.applyFailed'])).toBe(true);
    expect(editor.writes).toEqual([]);
    expect(editor.parsed().body.textContent).toContain('First');
  });

  it('Discard restores original bytes without a write', async () => {
    const editor = await mount();
    const apply = vi.spyOn(patches, 'applyManualEditPatch');
    await act(async () => { editor.remove(); });
    expect(editor.text()).toEqual(['Second']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.discardChanges'] })); });
    expect(editor.text()).toEqual(['First', 'Second']);
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
    await editor.select();
    apply.mockClear();
    await act(async () => { editor.remove(); });
    expect(apply.mock.calls[0]?.[0]).toBe(html);
    expect(editor.writes).toEqual([]);
  });
});
