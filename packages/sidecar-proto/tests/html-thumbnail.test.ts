import { describe, expect, it } from 'vitest';
import { normalizeDesktopSidecarMessage } from '../src/index.js';

const input = { url: 'http://127.0.0.1:17456/template/cover.html', width: 1920, height: 1080, outWidth: 480, outHeight: 270, timeoutMs: 10000 };

describe('HTML thumbnail sidecar message', () => {
  it('preserves the desktop request envelope', () => {
    expect(normalizeDesktopSidecarMessage({ type: 'render-html-thumbnail', input }))
      .toEqual({ type: 'render-html-thumbnail', input });
  });

  it.each([
    { url: 'file:///secret.html' }, { url: 'https://example.com/' },
    { url: 'http://example.com/' }, { width: 0 }, { height: -1 },
    { outWidth: 480.5 }, { outHeight: Infinity }, { timeoutMs: 0 },
    { width: 20000 }, { timeoutMs: 10001 }, { unknown: true },
  ])('rejects invalid thumbnail input %j', (invalid) => {
    expect(() => normalizeDesktopSidecarMessage({ type: 'render-html-thumbnail', input: { ...input, ...invalid } })).toThrow();
  });
});
