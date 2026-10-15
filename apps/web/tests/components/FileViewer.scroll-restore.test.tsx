// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const html = '<!doctype html><html><body><main>Scroll restore</main></body></html>';
const file: ProjectFile = { name: 'scroll.html', path: 'scroll.html', type: 'file', size: html.length, mtime: 1, mime: 'text/html', kind: 'html' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(snapshotTop = 0) {
  const frames = new Map<number, FrameRequestCallback>();
  const timers: TimerHandler[] = [];
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html)));
  await act(async () => {
    render(<FileViewer projectId="scroll-restore" projectKind="prototype" file={file} liveHtml={html} />);
  });
  const initialFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const report = (frame: HTMLIFrameElement, top: number) => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { type: 'readable-studio:preview-scroll', frameLeft: 0, frameTop: top, canvasLeft: 0, canvasTop: top },
  }));
  act(() => { report(initialFrame, snapshotTop); });
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await act(async () => { fireEvent.load(frame); });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const host = frame.closest('.viewer-body') as HTMLElement;
  const hostScroll = vi.fn();
  Object.defineProperty(host, 'scrollTo', { configurable: true, value: hostScroll });
  const step = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  // Capture the restore callbacks directly: their identity guard, not elapsed
  // time, is the behavior under test.
  vi.spyOn(window, 'setTimeout').mockImplementation(((callback: () => void) => {
    timers.push(callback);
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  step();
  step();
  expect(timers.length).toBeGreaterThan(0);
  post.mockClear();
  hostScroll.mockClear();
  const runPendingRestore = () => act(() => {
    for (const callback of timers) {
      if (typeof callback === 'function') callback();
    }
  });
  const request = () => act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { type: 'readable-studio:preview-scroll-request' },
    }));
  });
  return { report: (top: number) => act(() => { report(frame, top); }), post, hostScroll, runPendingRestore, request };
}

describe('FileViewer pending preview scroll restore', () => {
  it('retires the zero snapshot after accepted selection scroll and uses the new position for late requests', async () => {
    const editor = await mount();
    editor.report(1285);
    editor.runPendingRestore();
    expect(editor.hostScroll).not.toHaveBeenCalled();
    expect(editor.post).not.toHaveBeenCalled();
    editor.request();
    expect(editor.post).toHaveBeenCalledExactlyOnceWith({
      type: 'readable-studio:preview-scroll-restore',
      frameLeft: 0, frameTop: 1285, canvasLeft: 0, canvasTop: 1285,
    }, '*');
  });

  it('keeps a matching accepted report pending for the host callbacks', async () => {
    const editor = await mount(613);
    editor.report(613);
    editor.runPendingRestore();
    expect(editor.hostScroll).toHaveBeenCalled();
    expect(editor.post).toHaveBeenCalledWith({
      type: 'readable-studio:preview-scroll-restore',
      frameLeft: 0, frameTop: 613, canvasLeft: 0, canvasTop: 613,
    }, '*');
  });

  it('ignores an initial zero report while a nonzero restore is pending', async () => {
    const editor = await mount(613);
    editor.report(0);
    editor.request();
    expect(editor.post).toHaveBeenCalledExactlyOnceWith({
      type: 'readable-studio:preview-scroll-restore',
      frameLeft: 0, frameTop: 613, canvasLeft: 0, canvasTop: 613,
    }, '*');
    editor.runPendingRestore();
    expect(editor.hostScroll).toHaveBeenCalled();
  });
});
