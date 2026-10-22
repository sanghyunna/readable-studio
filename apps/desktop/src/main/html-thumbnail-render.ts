import type { BrowserWindowConstructorOptions } from 'electron';
import type { DesktopRenderHtmlThumbnailInput, DesktopRenderHtmlThumbnailResult } from '@readable-studio/sidecar-proto';

type ThumbnailImage = {
  resize(options: { width: number; height: number; quality: 'good' }): ThumbnailImage;
  toPNG(): Buffer;
  toWebP?: () => Buffer;
};

export type ThumbnailWindow = {
  loadURL(url: string): Promise<unknown>;
  destroy(): void;
  webContents: {
    executeJavaScript(script: string): Promise<unknown>;
    capturePage(): Promise<ThumbnailImage>;
    setZoomFactor(factor: number): void;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  };
};

/** The same offscreen, sandboxed capture surface used for full-document exports. */
export function hiddenCaptureWindowOptions(width: number, height: number): BrowserWindowConstructorOptions {
  return {
    width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  };
}

const readyScript = `(async () => {
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;

export function createHtmlThumbnailRenderer(
  createWindow: (options: BrowserWindowConstructorOptions) => ThumbnailWindow,
): (input: DesktopRenderHtmlThumbnailInput) => Promise<DesktopRenderHtmlThumbnailResult> {
  let queue: Promise<unknown> = Promise.resolve();
  const render = async (input: DesktopRenderHtmlThumbnailInput): Promise<DesktopRenderHtmlThumbnailResult> => {
    let window: ThumbnailWindow | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const deadline = Date.now() + input.timeoutMs;
    const bounded = <T>(operation: Promise<T>, ms: number, atTimeout: () => T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          try { resolve(atTimeout()); } catch (error) { reject(error); }
        }, ms);
        timers.add(timer);
        operation.then(resolve, reject).finally(() => { clearTimeout(timer); timers.delete(timer); });
      });
    try {
      // The desktop factory supplies an isolated session with the same
      // offline-CDN resolver and a daemon-origin network restriction.
      window = createWindow(hiddenCaptureWindowOptions(input.width, input.height));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const activeWindow = window;
      const ready = (async () => {
        await activeWindow.loadURL(input.url);
        activeWindow.webContents.setZoomFactor(1);
        await activeWindow.webContents.executeJavaScript(readyScript);
      })();
      await bounded(ready, input.timeoutMs, () => undefined);
      // At the readiness deadline capture what has painted. Keep that final
      // capture bounded too, so a wedged compositor cannot hold the queue.
      const remaining = deadline - Date.now();
      const image = await bounded(window.webContents.capturePage(), Math.max(remaining, 30_000), () => {
        throw new Error('THUMBNAIL_RENDER_TIMEOUT');
      });
      const resized = image.resize({ width: input.outWidth, height: input.outHeight, quality: 'good' });
      const webp = resized.toWebP;
      const bytes = webp ? webp.call(resized) : resized.toPNG();
      return { ok: true, imageBase64: bytes.toString('base64'), mime: webp ? 'image/webp' : 'image/png' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: message === 'THUMBNAIL_RENDER_TIMEOUT' ? 'THUMBNAIL_RENDER_TIMEOUT' : 'THUMBNAIL_RENDER_FAILED' };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      window?.destroy();
    }
  };
  return input => {
    const result = queue.then(() => render(input));
    queue = result.catch(() => undefined);
    return result;
  };
}
