import { expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { T } from '@/timeouts';

export type ZoomMetrics = {
  zoom: number;
  pinchScale: number;
  dpr: number;
  width: number;
  height: number;
};

type SettingsWindow = Window & {
  chrome?: {
    runtime?: { lastError?: { message?: string } };
    settingsPrivate?: {
      getDefaultZoom(callback: (factor: number) => void): void;
      setDefaultZoom(factor: number, callback: (success: boolean) => void): void;
    };
  };
};

type ResizeWindow = Window & {
  nativeZoomResize?: { done: Promise<boolean>; cancel(): void };
};

/** CDP distinguishes browser page zoom from pinch zoom and device emulation. */
export async function readZoomMetrics(page: Page, session: CDPSession): Promise<ZoomMetrics> {
  const [layout, dpr] = await Promise.all([
    session.send('Page.getLayoutMetrics'),
    page.evaluate(() => devicePixelRatio),
  ]);
  const zoom = layout.cssVisualViewport.zoom;
  expect(typeof zoom, 'Chromium must expose the observed CDP page zoom factor').toBe('number');
  return {
    zoom: zoom!,
    pinchScale: layout.cssVisualViewport.scale,
    dpr,
    width: layout.cssLayoutViewport.clientWidth,
    height: layout.cssLayoutViewport.clientHeight,
  };
}

async function settingsZoom(settings: Page, factor: number | null): Promise<number> {
  return settings.evaluate(({ requested, timeoutMs }) => new Promise<number>((resolve, reject) => {
    const chrome = (window as SettingsWindow).chrome;
    const api = chrome?.settingsPrivate;
    if (!api) throw new Error('Chromium settingsPrivate zoom API disappeared');
    const timeout = window.setTimeout(() => reject(new Error('Chromium zoom API callback timed out')), timeoutMs);
    const read = () => api.getDefaultZoom((actual) => {
      clearTimeout(timeout);
      const error = chrome?.runtime?.lastError;
      if (error) reject(new Error(error.message ?? 'getDefaultZoom failed'));
      else resolve(actual);
    });
    if (requested === null) read();
    else api.setDefaultZoom(requested, (success) => {
      const error = chrome?.runtime?.lastError;
      if (error || !success) {
        clearTimeout(timeout);
        reject(new Error(error?.message ?? `Chromium rejected page zoom ${requested}`));
      } else read();
    });
  }), { requested: factor, timeoutMs: T.medium });
}

/** Arm the exact layout resize/DPR signal BEFORE changing the browser preference. */
async function armZoomResize(page: Page, expectedDpr: number): Promise<void> {
  await page.evaluate(({ expected, timeoutMs }) => {
    const target = window as ResizeWindow;
    target.nativeZoomResize?.cancel();
    let complete: (changed: boolean) => void;
    const done = new Promise<boolean>((resolve) => { complete = resolve; });
    const finish = (changed: boolean) => {
      clearTimeout(timeout);
      observer.disconnect();
      complete(changed);
    };
    // ResizeObserver runs after layout, unlike window.resize. The app's
    // already-registered split observer can clamp its pane before measurement.
    const observer = new ResizeObserver(() => {
      if (Math.abs(devicePixelRatio - expected) < 0.01) finish(true);
    });
    const timeout = window.setTimeout(() => finish(false), timeoutMs);
    observer.observe(document.documentElement);
    target.nativeZoomResize = { done, cancel: () => finish(false) };
  }, { expected: expectedDpr, timeoutMs: T.medium });
}

export type NativeZoomCapability =
  | { supported: true; controller: NativePageZoom }
  | { supported: false; reason: string };

/**
 * The API behind Chrome Settings > Appearance > Page zoom changes Chromium's
 * HostZoomMap, not CSS zoom, deviceScaleFactor, or Emulation.setPageScaleFactor.
 * It requires a normal (persistent) profile: Chromium explicitly refuses this
 * preference in Playwright's usual off-the-record BrowserContext.
 * https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/api/settings_private.idl
 */
export class NativePageZoom {
  private constructor(
    private readonly page: Page,
    private readonly settings: Page,
    private readonly session: CDPSession,
    readonly baseline: ZoomMetrics,
  ) {}

  static async detect(page: Page): Promise<NativeZoomCapability> {
    const settings = await page.context().newPage();
    try {
      await settings.goto('chrome://settings/appearance', { waitUntil: 'domcontentloaded' });
    } catch (error) {
      await settings.close();
      // chrome-headless-shell has no browser Settings WebUI. Other navigation
      // failures are infrastructure failures, not a reason to skip coverage.
      if (error instanceof Error && /net::ERR_INVALID_URL/.test(error.message)) {
        return { supported: false, reason: `Browser Settings WebUI unavailable: ${error.message}` };
      }
      throw error;
    }
    const hasApi = await settings.evaluate(() => {
      const api = (window as SettingsWindow).chrome?.settingsPrivate;
      return typeof api?.getDefaultZoom === 'function' && typeof api?.setDefaultZoom === 'function';
    });
    if (!hasApi) {
      await settings.close();
      return { supported: false, reason: 'This Chromium build has no Settings page-zoom API (for example chrome-headless-shell).' };
    }
    const initialZoom = await settingsZoom(settings, null);
    // A disposable persistent profile must start at 100%. Zero means an
    // off-the-record profile; accepting that would silently turn this into a no-op.
    expect(initialZoom, 'Native zoom requires a fresh non-incognito profile').toBeCloseTo(1, 4);
    await page.bringToFront();
    const session = await page.context().newCDPSession(page);
    const baseline = await readZoomMetrics(page, session);
    expect(baseline.zoom).toBeCloseTo(1, 4);
    expect(baseline.pinchScale).toBeCloseTo(1, 4);
    const controller = new NativePageZoom(page, settings, session, baseline);
    try {
      // Even the 100% case must first prove that native zoom actually changes.
      await controller.set(1.25);
      await controller.set(1);
    } catch (error) {
      await controller.close();
      throw error;
    }
    return { supported: true, controller };
  }

  async set(factor: number): Promise<ZoomMetrics> {
    const before = await readZoomMetrics(this.page, this.session);
    const changing = Math.abs(before.zoom - factor) > 0.001;
    if (changing) await armZoomResize(this.page, this.baseline.dpr * factor);
    try {
      expect(await settingsZoom(this.settings, factor), 'Browser zoom preference readback').toBeCloseTo(factor, 4);
      if (changing) {
        const resized = await this.page.evaluate(() => (window as ResizeWindow).nativeZoomResize!.done);
        expect(resized, `No renderer resize/DPR change after native page zoom ${factor}`).toBe(true);
      }
      const actual = await readZoomMetrics(this.page, this.session);
      expect(actual.zoom, 'Observed page zoom, not requested/emulated scale').toBeCloseTo(factor, 4);
      expect(actual.dpr / this.baseline.dpr, 'Native zoom must change CSS-to-device pixel ratio').toBeCloseTo(factor, 3);
      expect(actual.pinchScale, 'Pinch zoom is not browser page zoom').toBeCloseTo(1, 4);
      expect(Math.abs(actual.width * factor - this.baseline.width), 'Native zoom must reflow the same physical viewport').toBeLessThanOrEqual(2);
      expect(Math.abs(actual.height * factor - this.baseline.height)).toBeLessThanOrEqual(2);
      if (changing) expect(actual.zoom).not.toBeCloseTo(before.zoom, 3);
      return actual;
    } finally {
      if (changing) await this.page.evaluate(() => (window as ResizeWindow).nativeZoomResize?.cancel());
    }
  }

  async close(): Promise<void> {
    // The entire disposable profile is closed by the spec fixture, so neither
    // the browser preference nor per-origin zoom can leak to another test.
    await this.session.detach();
    await this.settings.close();
  }
}
