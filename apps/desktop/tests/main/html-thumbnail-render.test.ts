import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlThumbnailRenderer, type ThumbnailWindow } from '../../src/main/html-thumbnail-render.js';

const input = { url: 'http://127.0.0.1:17456/cover.html', width: 1920, height: 1080, outWidth: 480, outHeight: 270, timeoutMs: 10000 };

function fixture() {
  const image = { toPNG: vi.fn(() => Buffer.from('png')), resize: vi.fn() };
  image.resize.mockReturnValue(image);
  const window: ThumbnailWindow = {
    loadURL: vi.fn(async () => {}),
    destroy: vi.fn(),
    webContents: {
      executeJavaScript: vi.fn(async () => true),
      capturePage: vi.fn(async () => image),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
  const factory = vi.fn(() => window);
  return { window, factory, image, render: createHtmlThumbnailRenderer(factory) };
}

afterEach(() => vi.useRealTimers());

describe('hidden HTML thumbnail renderer', () => {
  it('uses a hidden sandboxed viewport, resizes and destroys after capture', async () => {
    const f = fixture();
    expect(await f.render(input)).toEqual({ ok: true, imageBase64: Buffer.from('png').toString('base64'), mime: 'image/png' });
    expect(f.factory).toHaveBeenCalledWith(expect.objectContaining({
      show: false, focusable: false, skipTaskbar: true, useContentSize: true, width: 1920, height: 1080,
      webPreferences: expect.objectContaining({ offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true }),
    }));
    expect(f.window.loadURL).toHaveBeenCalledWith(input.url);
    expect(f.image.resize).toHaveBeenCalledWith({ width: 480, height: 270, quality: 'good' });
    expect(f.window.destroy).toHaveBeenCalledOnce();
  });

  it('encodes WebP when supported', async () => {
    const f = fixture();
    Object.assign(f.image, { toWebP: () => Buffer.from('webp') });
    expect(await f.render(input)).toEqual({ ok: true, imageBase64: Buffer.from('webp').toString('base64'), mime: 'image/webp' });
  });

  it('captures the current page when fonts or animation frames reach the deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    vi.mocked(f.window.webContents.executeJavaScript).mockImplementation(() => {
      entered.resolve();
      return new Promise(() => {});
    });
    const result = f.render(input);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(input.timeoutMs);
    expect((await result).ok).toBe(true);
    expect(f.window.destroy).toHaveBeenCalledOnce();
  });

  it('destroys after load or capture failure', async () => {
    for (const stage of ['load', 'capture'] as const) {
      const f = fixture();
      if (stage === 'load') vi.mocked(f.window.loadURL).mockRejectedValue(new Error('load failed'));
      else vi.mocked(f.window.webContents.capturePage).mockRejectedValue(new Error('capture failed'));
      expect(await f.render(input)).toMatchObject({ ok: false, code: 'THUMBNAIL_RENDER_FAILED' });
      expect(f.window.destroy).toHaveBeenCalledOnce();
    }
  });

  it('destroys even when capture never settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    vi.mocked(f.window.webContents.capturePage).mockImplementation(() => {
      entered.resolve();
      return new Promise(() => {});
    });
    const result = f.render(input);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(input.timeoutMs);
    expect(await result).toMatchObject({ ok: false, code: 'THUMBNAIL_RENDER_TIMEOUT' });
    expect(f.window.destroy).toHaveBeenCalledOnce();
  });

  it('creates only one window at a time, including after failure', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(f.window.loadURL).mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const first = f.render(input);
    await entered.promise;
    const second = f.render(input);
    expect(f.factory).toHaveBeenCalledTimes(1);
    release.reject(new Error('failed'));
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.window.destroy).toHaveBeenCalledTimes(2);
  });
});
