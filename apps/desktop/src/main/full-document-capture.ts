import { BrowserWindow, nativeImage, screen, type WebContents } from 'electron';
import type { ReadableStudioHostCaptureResult } from '@readable-studio/host';

export type PreviewSource = { srcdoc: string; src: string; sandbox: string | null; baseUrl: string; width: number; height: number };
export type FrameMetrics = { height: number; width: number; clientWidth: number; viewportHeight: number };
export type CaptureSurface = {
  dpr: number;
  getPreview(clip: Electron.Rectangle): Promise<PreviewSource | null>;
  createWindow(preview: PreviewSource): Promise<{
    frame: { executeJavaScript(script: string): Promise<unknown> };
    resizeFrame(height: number): Promise<void>;
    screenshot(width: number, height: number): Promise<{ dataUrl: string; width: number; height: number }>;
    close(): void;
  }>;
};

// Chromium/Skia bitmap dimensions and memory vary with the GPU. Stay below the
// 16384-pixel texture edge and 100M RGBA pixels (~400MB). Reject rather than
// returning a cropped/empty screenshot on machines with smaller surfaces.
const MAX_EDGE_PX = 16384;
const MAX_PIXELS = 100_000_000;
const metricsScript = `(() => ({
  height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight),
  width: innerWidth, clientWidth: document.documentElement.clientWidth, viewportHeight: innerHeight
}))()`;

function limitError(width: number, height: number): { ok: false; code: 'CAPTURE_TOO_LARGE'; reason: string } | null {
  if (width <= MAX_EDGE_PX && height <= MAX_EDGE_PX && width * height <= MAX_PIXELS) return null;
  return { ok: false, code: 'CAPTURE_TOO_LARGE', reason: `Image is ${width} x ${height} pixels, above the capture limit (16384 per side, 100 million pixels). Export a shorter document or reduce display scaling.` };
}

/** Only called for scrollable HTML; fixed-size slides use the unchanged capturePage(clip) path. */
export async function captureFullDocument(surface: CaptureSurface, clip: Electron.Rectangle): Promise<ReadableStudioHostCaptureResult | { ok: false; code: 'CAPTURE_TOO_LARGE' | 'CAPTURE_REFLOWED' | 'CAPTURE_PREVIEW_NOT_FOUND' | 'CAPTURE_SCROLLBAR_BLOCKED' | 'CAPTURE_TRUNCATED'; reason: string }> {
  const preview = await surface.getPreview(clip);
  if (!preview) return { ok: false, code: 'CAPTURE_PREVIEW_NOT_FOUND', reason: 'No preview iframe at the requested capture rectangle' };
  const window = await surface.createWindow(preview);
  try {
    const frame = window.frame;
    const initial = await frame.executeJavaScript(metricsScript) as FrameMetrics;
    const step = Math.max(1, initial.viewportHeight);
    // Materialize lazy image loads, IntersectionObserver content and
    // content-visibility:auto while the frame still has its original height.
    // The rAF pair gives observers/layout one render opportunity at each stop.
    for (let y = 0; y < initial.height; y += step) {
      await frame.executeJavaScript(`new Promise(resolve => { scrollTo(0, ${y}); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`);
    }
    await frame.executeJavaScript('new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(resolve); })');
    const before = await frame.executeJavaScript(metricsScript) as FrameMetrics;
    const cssHeight = before.height;
    const width = Math.ceil(preview.width * surface.dpr);
    const height = Math.ceil(cssHeight * surface.dpr);
    const error = limitError(width, height);
    if (error) return error;
    // Transparent paint, not display:none/width:0: reserve the original
    // classic scrollbar gutter so text line breaks and content width persist.
    await frame.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = 'html { overflow-y: scroll !important; } html, body, * { scrollbar-color: transparent transparent !important; } ::-webkit-scrollbar, ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-track { background: transparent !important; }'; document.documentElement.append(s); })()`);
    const after = await frame.executeJavaScript('({ width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor })') as { width: number; clientWidth: number; scrollbarColor: string };
    if (!/^(transparent|rgba\(0, 0, 0, 0\))/.test(after.scrollbarColor)) {
      return { ok: false, code: 'CAPTURE_SCROLLBAR_BLOCKED', reason: 'Preview security policy prevented hiding its scrollbar; image export was canceled rather than including it.' };
    }
    if (after.width !== before.width || after.clientWidth !== before.clientWidth) {
      return { ok: false, code: 'CAPTURE_REFLOWED', reason: 'Scrollbar suppression changed the preview width; image export was canceled to avoid reflowing the document.' };
    }
    await window.resizeFrame(cssHeight);
    // Expanding the frame once places fixed/sticky elements at scroll origin
    // exactly once, instead of stitching multiple viewports with duplicates.
    const expanded = await frame.executeJavaScript(metricsScript) as FrameMetrics;
    if (expanded.width !== before.width || expanded.clientWidth !== before.clientWidth) {
      return { ok: false, code: 'CAPTURE_REFLOWED', reason: 'Expanding the preview changed its content width; image export was canceled to avoid reflowing the document.' };
    }
    if (expanded.height > cssHeight) {
      const grownHeight = Math.ceil(expanded.height * surface.dpr);
      const grownError = limitError(width, grownHeight);
      if (grownError) return grownError;
      await window.resizeFrame(expanded.height);
    }
    const finalHeight = Math.max(cssHeight, expanded.height);
    const shot = await window.screenshot(preview.width, finalHeight);
    const expectedWidth = Math.ceil(preview.width * surface.dpr);
    const expectedHeight = Math.ceil(finalHeight * surface.dpr);
    if (shot.width !== expectedWidth || shot.height !== expectedHeight) {
      return { ok: false, code: 'CAPTURE_TRUNCATED', reason: `Image was truncated (${shot.width} x ${shot.height}, expected ${expectedWidth} x ${expectedHeight}). Export a shorter document or reduce display scaling.` };
    }
    return { ok: true, dataUrl: shot.dataUrl, w: shot.width, h: shot.height };
  } finally {
    window.close();
  }
}

export async function routeCaptureRequest<T>(
  fullDocument: boolean,
  legacyCapture: () => Promise<T>,
  fullCapture: () => Promise<T>,
): Promise<T> {
  return fullDocument ? fullCapture() : legacyCapture();
}

export function electronCaptureSurface(contents: WebContents, clip: Electron.Rectangle): CaptureSurface {
  return {
    dpr: screen.getDisplayMatching((() => {
      const bounds = BrowserWindow.fromWebContents(contents)?.getBounds();
      return { ...clip, x: clip.x + (bounds?.x ?? 0), y: clip.y + (bounds?.y ?? 0) };
    })()).scaleFactor,
    async getPreview(rect) {
      const result = await contents.executeJavaScript(`(() => {
        const iframe = document.elementsFromPoint(${rect.x + rect.width / 2}, ${rect.y + rect.height / 2})
          .find(el => el.tagName === 'IFRAME');
        if (!iframe) return null;
        return { srcdoc: iframe.srcdoc, src: iframe.getAttribute('src') || '', sandbox: iframe.getAttribute('sandbox'), baseUrl: document.baseURI, width: iframe.clientWidth, height: iframe.clientHeight };
      })()`) as PreviewSource | null;
      return result;
    },
    async createWindow(preview) {
      const origin = BrowserWindow.fromWebContents(contents)?.getBounds();
      const win = new BrowserWindow({ show: false, x: origin?.x, y: origin?.y, width: Math.max(500, Math.ceil(preview.width)), height: Math.ceil(preview.height), webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        const safeBase = preview.baseUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        const sandbox = preview.sandbox === null ? '' : ` sandbox="${escape(preview.sandbox)}"`;
        const source = preview.srcdoc
          ? ` srcdoc="${escape(preview.srcdoc)}"`
          : ` src="${escape(new URL(preview.src, preview.baseUrl).href)}"`;
        const markup = `<meta name="viewport" content="width=device-width, initial-scale=1"><base href="${safeBase}"><style>html,body{margin:0}iframe{display:block;border:0;width:${preview.width}px;height:${preview.height}px}</style><iframe id="capture"${sandbox}${source}></iframe>`;
        await win.loadURL('about:blank');
        // document.write avoids Chromium's ~2MB URL cap for large srcdoc HTML.
        // Subscribe before inserting the iframe so we cannot miss its load.
        const frameLoaded = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            win.webContents.off('did-frame-finish-load', onLoad);
            reject(new Error('Preview iframe did not finish loading for image export'));
          }, 15_000);
          const onLoad = (_event: Electron.Event, isMainFrame: boolean) => {
            if (isMainFrame) return;
            clearTimeout(timeout);
            win.webContents.off('did-frame-finish-load', onLoad);
            resolve();
          };
          win.webContents.on('did-frame-finish-load', onLoad);
        });
        await win.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(markup)}); document.close();`);
        await frameLoaded;
        const child = win.webContents.mainFrame.frames[0];
        if (!child) throw new Error('Preview iframe failed to load in capture surface');
        await child.executeJavaScript('document.fonts.ready.then(() => true)');
        // Chromium can inherit a persisted zoom level for about:blank;
        // normalize after navigation so source CSS pixels map to the same
        // measured iframe width at the physical display DPR.
        win.webContents.setZoomFactor(1);
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
        win.webContents.debugger.attach('1.3');
        return {
          frame: child,
          resizeFrame: async (height: number) => {
            await win.webContents.executeJavaScript(`document.getElementById('capture').style.height = ${JSON.stringify(`${height}px`)}`);
            // Expanding only the iframe leaves pixels beyond the offscreen
            // compositor's viewport unpainted (black in Electron 41).
            win.setContentSize(Math.max(500, Math.ceil(preview.width)), Math.ceil(height));
            if (win.getContentSize()[0] < preview.width || win.getContentSize()[1] < height) {
              throw new Error(`Capture surface cannot reach ${height}px; export a shorter document or reduce display scaling.`);
            }
            await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          },
          screenshot: async (width: number, height: number) => {
            const result = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
              format: 'png', captureBeyondViewport: true,
              clip: { x: 0, y: 0, width, height, scale: 1 },
            }) as { data: string };
            const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
            const size = image.getSize();
            return { dataUrl: `data:image/png;base64,${result.data}`, width: size.width, height: size.height };
          },
          close: () => { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); },
        };
      } catch (error) {
        win.destroy();
        throw error;
      }
    },
  };
}
