// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import * as movement from '../../src/edit-mode/movement-session';
import type { ProjectFile } from '../../src/types';
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

const html = '<!doctype html><html><body><main data-readable-id="parent"><section data-readable-id="child"><div data-readable-id="leaf">Nested</div></section></main><div data-readable-id="parent-lookalike">Sibling</div></body></html>';
const file: ProjectFile = { name: 'structural.html', path: 'structural.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
function target(id: string, parentId: string | null = null): ManualEditTarget {
  return {
    id, parentId, ancestorIds: parentId === 'child' ? ['child', 'parent'] : parentId ? [parentId] : [],
    kind: 'container', label: id, tagName: 'div', className: '', text: id,
    rect: { x: 10, y: 10, width: 160, height: 48 }, fields: {}, attributes: {},
    styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<div></div>',
  };
}
const targets = [target('leaf', 'child'), target('parent-lookalike'), target('child', 'parent'), target('parent')];

afterEach(() => {
  cleanup();
  controls.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(source = html, deck = false) {
  vi.useFakeTimers();
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source)));
  const props = { projectId: 'structural-context', projectKind: 'prototype' as const, file, liveHtml: source, isDeck: deck };
  const view = render(<FileViewer {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const documentEpoch = manualEditFrameEpoch(frame);
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { documentEpoch, ...data } }));
  const select = async (next = target('parent')) => {
    await act(async () => { send({ type: 'readable-edit-select', target: next }); });
  };
  await act(async () => { send({ type: 'readable-edit-targets', targets }); });
  await select();
  const host = frame.closest('.viewer-body') as HTMLElement;
  expect(host).not.toBeNull();
  const step = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  step();
  step();
  act(() => { vi.advanceTimersByTime(260); });
  post.mockClear();
  host.scrollLeft = 31;
  host.scrollTop = 417;
  const scrollTo = vi.fn((left: number, top: number) => { host.scrollLeft = left; host.scrollTop = top; });
  Object.defineProperty(host, 'scrollTo', { configurable: true, value: scrollTo });
  const patch = async (kind: 'remove-element' | 'set-inner-html' | 'set-style') => {
    await act(async () => {
      if (kind === 'remove-element') controls.current!.onApplyPatch({ id: 'parent', kind }, 'Remove');
      else if (kind === 'set-inner-html') controls.current!.onApplyPatch({ id: 'parent', kind, html: '<section>Changed</section>' }, 'Change');
      else controls.current!.onApplyPatch({ id: 'parent', kind, styles: { color: '#123456' } }, 'Style');
    });
  };
  return { view, props, frame, post, send, select, host, scrollTo, step, patch };
}

describe('FileViewer structural edit context', () => {
  it('exposes the nested targets as eligible snap candidates before removal', async () => {
    const candidates = vi.spyOn(movement, 'buildManualEditMovementCandidates');
    const editor = await mount();
    await editor.select(target('parent-lookalike'));
    const interior = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      fireEvent.pointerDown(interior, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(interior, { pointerId: 1, clientX: 130, clientY: 100 });
    });
    expect(candidates.mock.results.at(-1)!.value.candidates.map((item: { id: string }) => item.id)).toEqual(['leaf', 'child', 'parent']);
  });

  it.each(['remove-element', 'set-inner-html'] as const)('preserves host/frame/canvas scroll through an in-place %s edit', async (kind) => {
    const editor = await mount();
    const before = editor.frame.srcdoc;
    const doc = editor.frame.contentWindow!.document;
    const scrolling = document.createElement('div');
    scrolling.scrollTo = vi.fn();
    scrolling.scrollLeft = 19;
    scrolling.scrollTop = 613;
    Object.defineProperty(doc, 'scrollingElement', { configurable: true, value: scrolling });
    const canvas = doc.createElement('div');
    canvas.scrollTo = vi.fn();
    canvas.className = 'design-canvas';
    canvas.scrollLeft = 23;
    canvas.scrollTop = 811;
    doc.body.appendChild(canvas);
    await editor.patch(kind);
    editor.step();
    editor.step();
    expect(editor.frame.srcdoc).toBe(before);
    expect([editor.host.scrollLeft, editor.host.scrollTop]).toEqual([31, 417]);
    expect([scrolling.scrollLeft, scrolling.scrollTop]).toEqual([19, 613]);
    expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([23, 811]);
    expect(editor.scrollTo).not.toHaveBeenCalled();
    expect(scrolling.scrollTo).not.toHaveBeenCalled();
    expect(canvas.scrollTo).not.toHaveBeenCalled();
    expect(editor.post.mock.calls.some(([message]) => message.type === 'readable-studio:preview-scroll-restore')).toBe(false);
  });

  it('removes transitive descendants from snap targets and clears a removed hover before discovery', async () => {
    const candidates = vi.spyOn(movement, 'buildManualEditMovementCandidates');
    const editor = await mount();
    await act(async () => { editor.send({ type: 'readable-edit-hover', target: target('leaf', 'child') }); });
    expect(screen.getByTestId('manual-edit-hover-open')).toBeTruthy();
    await editor.patch('remove-element');
    expect(screen.queryByTestId('manual-edit-hover-open')).toBeNull();
    expect(document.querySelector('[data-readable-edit-selected-surface]')).toBeNull();
    const parsed = new DOMParser().parseFromString(manualEditCanonicalSource(editor.frame), 'text/html');
    expect(parsed.querySelector('[data-readable-id="leaf"]')).toBeNull();
    await editor.select(target('parent-lookalike'));
    const interior = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      fireEvent.pointerDown(interior, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(interior, { pointerId: 1, clientX: 130, clientY: 100 });
    });
    expect(candidates).toHaveBeenCalled();
    expect(candidates.mock.calls.at(-1)![0].map((item) => item.id)).toEqual(['parent-lookalike']);
    expect(candidates.mock.results.at(-1)!.value.candidates).toEqual([]);
  });

  it('retains an unrelated hover when removing the nested parent', async () => {
    const editor = await mount();
    await act(async () => { editor.send({ type: 'readable-edit-hover', target: target('parent-lookalike') }); });
    await editor.patch('remove-element');
    const hover = screen.getByTestId('manual-edit-hover-open');
    await act(async () => { fireEvent.click(hover); });
    expect(editor.post.mock.calls.map(([message]) => message)).toContainEqual(expect.objectContaining({
      type: 'readable-edit-select-target', id: 'parent-lookalike',
      documentEpoch: expect.any(String), actionSeq: expect.any(Number),
    }));
  });

  it('does not refreeze or restore scroll for a style patch', async () => {
    const editor = await mount();
    const before = editor.frame.srcdoc;
    await editor.patch('set-style');
    editor.step();
    editor.step();
    expect(editor.frame.srcdoc).toBe(before);
    expect(editor.scrollTo).not.toHaveBeenCalled();
    expect(editor.post.mock.calls.some(([message]) => message.type === 'readable-studio:preview-scroll-restore')).toBe(false);
  });

  it('keeps protected rejection source, scroll and targets unchanged', async () => {
    const editor = await mount('<html><body><main data-readable-id="parent">Only child</main></body></html>');
    const before = editor.frame.srcdoc;
    await editor.patch('remove-element');
    expect(editor.frame.srcdoc).toBe(before);
    expect(editor.host.scrollTop).toBe(417);
    expect(editor.scrollTo).not.toHaveBeenCalled();
    const candidates = vi.spyOn(movement, 'buildManualEditMovementCandidates');
    const interior = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      fireEvent.pointerDown(interior, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(interior, { pointerId: 1, clientX: 130, clientY: 100 });
    });
    expect(candidates.mock.calls.at(-1)![0]).toEqual(targets);
  });

  it('does not restore a previous document from queued frames or stale load', async () => {
    const editor = await mount();
    await editor.patch('set-inner-html');
    editor.post.mockClear();
    await act(async () => {
      editor.view.rerender(<FileViewer {...editor.props} file={{ ...file, name: 'next.html', path: 'next.html' }} liveHtml="<html><body>Next</body></html>" />);
    });
    editor.host.scrollTop = 0;
    fireEvent.load(editor.frame);
    editor.step();
    editor.step();
    act(() => { vi.advanceTimersByTime(260); });
    expect(editor.host.scrollTop).toBe(0);
    expect(editor.post.mock.calls.some(([message]) => message.type === 'readable-studio:preview-scroll-restore')).toBe(false);
  });

  it.each(['remove-element', 'set-inner-html'] as const)('keeps non-first slide after %s', async (kind) => {
    const editor = await mount(html, true);
    await act(async () => { editor.send({ type: 'readable-studio:slide-state', active: 2, count: 4 }); });
    const before = editor.frame.srcdoc;
    await editor.patch(kind);
    expect(editor.frame.srcdoc).toBe(before);
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });
});
