import { describe, expect, it, vi } from 'vitest';
import { renderHtmlThumbnail } from '../src/desktop-render-client.js';

describe('desktop thumbnail client', () => {
  it('returns desktop-unavailable when no desktop pipe is connected', async () => {
    expect(await renderHtmlThumbnail('http://127.0.0.1:17456/cover.html', { namespace: 'thumbnail-test-no-desktop' }))
      .toMatchObject({ ok: false, code: 'desktop-unavailable' });
  });

  it('sends the desktop message and returns decoded image bytes', async () => {
    const request = vi.fn(async () => ({ ok: true as const, imageBase64: Buffer.from('png').toString('base64'), mime: 'image/png' as const }));
    expect(await renderHtmlThumbnail('http://127.0.0.1:17456/cover.html', { namespace: 'thumbnail-test', request }))
      .toEqual(Buffer.from('png'));
    expect(request).toHaveBeenCalledWith(expect.stringContaining('thumbnail-test'), {
      type: 'render-html-thumbnail',
      input: { url: 'http://127.0.0.1:17456/cover.html', width: 1920, height: 1080, outWidth: 480, outHeight: 270, timeoutMs: 10000 },
    }, { timeoutMs: 12000 });
  });

  it('preserves renderer errors instead of treating them as disconnection', async () => {
    const request = vi.fn(async () => ({ ok: false as const, code: 'THUMBNAIL_RENDER_FAILED' as const, error: 'bad page' }));
    expect(await renderHtmlThumbnail('http://127.0.0.1:17456/cover.html', { request }))
      .toEqual({ ok: false, code: 'THUMBNAIL_RENDER_FAILED', error: 'bad page' });
  });

  it('starts the IPC deadline only when a queued page is sent', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async () => {
      enter();
      await released;
      return { ok: true as const, imageBase64: Buffer.from('png').toString('base64'), mime: 'image/png' as const };
    });
    const first = renderHtmlThumbnail('http://127.0.0.1:17456/first.html', { request });
    await entered;
    const second = renderHtmlThumbnail('http://127.0.0.1:17456/second.html', { request });
    const callsWhileFirstIsPending = request.mock.calls.length;
    release();
    await Promise.all([first, second]);
    expect(callsWhileFirstIsPending).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
