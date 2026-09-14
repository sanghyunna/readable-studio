import type { WebContents } from "electron";

/** Chromium advances page zoom by this multiplicative ratio per zoom level. */
export const CHROMIUM_ZOOM_STEP_RATIO = 1.2;
export const CHROMIUM_DEFAULT_ZOOM_FACTOR = 1;

/** Readable Studio's default: one Chromium zoom step above Chromium's default. */
export const DESKTOP_BASELINE_ZOOM_FACTOR = CHROMIUM_DEFAULT_ZOOM_FACTOR * CHROMIUM_ZOOM_STEP_RATIO;

type ZoomableWebContents = Pick<WebContents, "setZoomFactor">;

export function applyDesktopBaselineZoom(webContents: ZoomableWebContents): void {
  webContents.setZoomFactor(DESKTOP_BASELINE_ZOOM_FACTOR);
}
