// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { installMockReadableStudioHost } from '@readable-studio/host/testing';
import type { ReadableStudioHostCaptureOptions } from '@readable-studio/host';
import { FileViewer } from '../../src/components/FileViewer';
import { ANNOTATION_EVENT, type AnnotationEventDetail } from '../../src/components/PreviewDrawOverlay';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('annotates a 20000px document using visible pixels instead of full-document export', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON: () => ({}) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(cb => cb(new Blob(['png'], { type: 'image/png' })));
  vi.stubGlobal('Image', class { onload?: () => void; set src(_: string) { queueMicrotask(() => this.onload?.()); } });
  const capture = vi.fn(async (options?: ReadableStudioHostCaptureOptions & { fullDocument?: boolean }) => options?.fullDocument
    ? { ok: false as const, code: 'CAPTURE_TOO_LARGE', reason: '20000 exceeds 16384' }
    : { ok: true as const, dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 });
  const restore = installMockReadableStudioHost({ host: { capture: { page: capture } } });
  let listener: EventListener | undefined;
  try {
    const { container, getByTestId } = render(<FileViewer projectId="p" projectKind="prototype"
      file={{ name: 'long.html', path: 'long.html', type: 'file', size: 1024, mtime: 1, kind: 'html', mime: 'text/html' }}
      liveHtml='<html><body><main style="height:20000px">Long document</main></body></html>' />);
    fireEvent.click(getByTestId('draw-overlay-toggle'));
    const input = container.querySelector<HTMLInputElement>('.preview-draw-note-input')!;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: 'Change the visible region' } });
    const event = new Promise<AnnotationEventDetail>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Annotation event missing')), 2000);
      listener = e => {
        window.clearTimeout(timeout);
        const detail = (e as CustomEvent<AnnotationEventDetail>).detail;
        detail.ack?.({ ok: true, outcome: 'accepted' });
        resolve(detail);
      };
      window.addEventListener(ANNOTATION_EVENT, listener, { once: true });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      while (frames.length) frames.shift()!(0);
      const detail = await event;
      expect(detail.file).toBeInstanceOf(File);
      expect(detail.action).toBe('send');
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ clip: { width: 320, height: 200 } });
    expect(capture.mock.calls[0]?.[0]?.fullDocument).not.toBe(true);
    expect(input.value).toBe('');
  } finally {
    if (listener) window.removeEventListener(ANNOTATION_EVENT, listener);
    restore();
  }
});
