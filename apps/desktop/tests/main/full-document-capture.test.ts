import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { captureFullDocument, routeCaptureRequest, type CaptureSurface } from '../../src/main/full-document-capture.js';

function surface(height = 1200, dpr = 1.5) {
  const calls: string[] = [];
  const frame = { executeJavaScript: vi.fn(async (script: string) => {
    if (script.includes('scrollHeight')) return { height, width: 400, clientWidth: 385, viewportHeight: 300 };
    if (script.includes('scrollTo')) { calls.push('scroll'); return null; }
    if (script.includes('clientWidth')) return { width: 400, clientWidth: 385, scrollbarColor: 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)' };
    return null;
  }) };
  const host: CaptureSurface = {
    getPreview: vi.fn(async () => ({ srcdoc: '<div>content</div>', src: '', sandbox: 'allow-scripts', baseUrl: 'http://localhost/', width: 400, height: 300 })),
    createWindow: vi.fn(async () => ({
      frame,
      resizeFrame: vi.fn(async (h: number) => { calls.push(`resize:${h}`); }),
      screenshot: vi.fn(async (w: number, h: number) => { calls.push(`screenshot:${w}:${h}`); return { dataUrl: 'data:image/png;base64,pixels', width: Math.round(w * dpr), height: Math.round(h * dpr) }; }),
      close: vi.fn(() => { calls.push('close'); }),
    })),
    dpr,
  };
  return { host, calls };
}

describe('full document host capture', () => {
  it.each([
    { name: 'short non-scrolling', contentHeight: 539, gutter: 15 },
    { name: 'long scrolling', contentHeight: 2939, gutter: 15 },
    { name: 'long overlay-scrollbar', contentHeight: 2939, gutter: 0 },
  ])('exports a $name document without adding or losing a scrollbar gutter', async ({ contentHeight, gutter }) => {
    // Widths/height match the saved fixture measured in headless Chromium.
    // JSDOM executes the real injected CSS; only layout/painting are modeled.
    const dom = new JSDOM('<!doctype html><html><body>content</body></html>', { runScripts: 'outside-only' });
    const root = dom.window.document.documentElement;
    Object.defineProperties(dom.window, {
      innerWidth: { value: 994 },
      innerHeight: { value: 835, writable: true },
      scrollTo: { value: () => {} },
      requestAnimationFrame: { value: (callback: FrameRequestCallback) => { callback(0); return 0; } },
    });
    Object.defineProperties(root, {
      scrollHeight: { get: () => Math.max(contentHeight, dom.window.innerHeight) },
      clientWidth: { get: () => 994 - ((contentHeight > dom.window.innerHeight || dom.window.getComputedStyle(root).overflowY === 'scroll') ? gutter : 0) },
    });
    const screenshot = vi.fn(async (width: number, height: number) => ({ dataUrl: 'data:image/png;base64,pixels', width, height }));
    const host: CaptureSurface = {
      dpr: 1,
      getPreview: async () => ({ srcdoc: '', src: '', sandbox: null, baseUrl: 'about:blank', width: 994, height: 835 }),
      createWindow: async () => ({
        frame: { executeJavaScript: async script => dom.window.eval(script) as unknown },
        resizeFrame: async height => { Object.defineProperty(dom.window, 'innerHeight', { value: height }); },
        screenshot,
        close: () => dom.window.close(),
      }),
    };
    expect(await captureFullDocument(host, { x: 0, y: 0, width: 994, height: 835 }))
      .toEqual({ ok: true, dataUrl: 'data:image/png;base64,pixels', w: 994, h: Math.max(contentHeight, 835) });
    expect(screenshot).toHaveBeenCalledOnce();
  });
  it('materializes scroll content before expanding the iframe; captures the full height at DPR with no scrollbar reflow', async () => {
    const { host, calls } = surface();
    const result = await captureFullDocument(host, { x: 10, y: 20, width: 400, height: 300 });
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,pixels', w: 600, h: 1800 });
    expect(calls).toContain('screenshot:400:1200');
    expect(calls.indexOf('scroll')).toBeLessThan(calls.indexOf('resize:1200'));
    expect(calls.at(-1)).toBe('close');
  });
  it('cancels instead of exporting a scrollbar if the preview blocks transparent scrollbar styling', async () => {
    const { host, calls } = surface();
    const create = host.createWindow;
    host.createWindow = vi.fn(async preview => {
      const window = await create(preview);
      const evaluate = window.frame.executeJavaScript;
      window.frame.executeJavaScript = async script => script.includes('getComputedStyle')
        ? { width: 400, clientWidth: 385, scrollbarColor: 'auto' }
        : evaluate(script);
      return window;
    });
    expect(await captureFullDocument(host, { x: 0, y: 0, width: 400, height: 300 }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/scrollbar/) });
    expect(calls.some(call => call.startsWith('screenshot:'))).toBe(false);
    expect(calls.at(-1)).toBe('close');
  });
  it('rejects excess surface sizes with a typed actionable error and closes the surface', async () => {
    const { host, calls } = surface(12000, 2);
    const result = await captureFullDocument(host, { x: 0, y: 0, width: 400, height: 300 });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_TOO_LARGE' });
    expect(result.ok === false && result.reason).toMatch(/reduce.*height|shorter/i);
    expect(calls).not.toContain('screenshot:400:12000');
    expect(calls.at(-1)).toBe('close');
  });
  it('routes fixed-size deck captures through the original clip path, never the full-document surface', async () => {
    const legacy = vi.fn(async () => ({ ok: true, w: 1200, h: 675 }));
    const document = vi.fn(async () => ({ ok: true, w: 1200, h: 9000 }));
    expect(await routeCaptureRequest(false, legacy, document)).toEqual({ ok: true, w: 1200, h: 675 });
    expect(legacy).toHaveBeenCalledOnce();
    expect(document).not.toHaveBeenCalled();
    expect(await routeCaptureRequest(true, legacy, document)).toEqual({ ok: true, w: 1200, h: 9000 });
  });
  it('fails rather than exporting reflowed text if hiding scrollbars changes client width', async () => {
    const { host } = surface();
    const created = host.createWindow;
    host.createWindow = vi.fn(async (...args) => {
      const window = await created(args[0]);
      const evalOriginal = window.frame.executeJavaScript;
      window.frame.executeJavaScript = async (script) => script.includes('clientWidth') && !script.includes('scrollHeight')
        ? { width: 400, clientWidth: 400, scrollbarColor: 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)' }
        : evalOriginal(script);
      return window;
    });
    expect(await captureFullDocument(host, { x: 0, y: 0, width: 400, height: 300 }))
      .toMatchObject({ ok: false, code: 'CAPTURE_REFLOWED' });
  });
});
