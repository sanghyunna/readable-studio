import { JSDOM } from 'jsdom';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  nativeImage: {},
  screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
}));

import { electronCaptureSurface } from '../../src/main/full-document-capture.js';

describe('preview lookup beneath export overlays', () => {
  it('extracts the iframe source even when the dialog backdrop covers its center', async () => {
    const dom = new JSDOM('<iframe srcdoc="<p>Preview</p>" sandbox="allow-scripts"></iframe><div class="modal-backdrop viewer-modal-backdrop image-export-backdrop"></div>', { url: 'https://studio.test/', runScripts: 'outside-only' });
    try {
      const { document } = dom.window;
      const iframe = document.querySelector('iframe')!;
      const backdrop = document.querySelector('div')!;
      Object.defineProperties(iframe, { clientWidth: { value: 482 }, clientHeight: { value: 701 } });
      document.elementFromPoint = vi.fn(() => backdrop);
      document.elementsFromPoint = vi.fn(() => [backdrop, iframe, document.body, document.documentElement]);
      const contents = { executeJavaScript: async (script: string) => dom.window.eval(script) } as unknown as WebContents;
      const clip = { x: 790, y: 190, width: 482, height: 701 };
      expect(await electronCaptureSurface(contents, clip).getPreview(clip)).toEqual({
        srcdoc: '<p>Preview</p>', src: '', sandbox: 'allow-scripts', baseUrl: 'https://studio.test/', width: 482, height: 701,
      });
      expect(document.elementsFromPoint).toHaveBeenCalledWith(1031, 540.5);
    } finally {
      dom.window.close();
    }
  });
});
