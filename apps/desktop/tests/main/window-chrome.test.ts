import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const runtimeSource = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");
const splashSource = readFileSync(new URL("../../assets/splash.html", import.meta.url), "utf8");
const splashVideo = readFileSync(new URL("../../assets/splash.mp4", import.meta.url));

describe("desktop BrowserWindow chrome options", () => {
  test("hides Electron's native menu bar in the Windows/Linux app window", () => {
    const browserWindowBlock = /new BrowserWindow\(\{([\s\S]*?)minWidth: 900,([\s\S]*?)webPreferences:/.exec(runtimeSource)?.[0] ?? "";

    expect(browserWindowBlock).toContain("autoHideMenuBar: true");
  });

  test("keeps macOS traffic-light controls clear of the web tab strip", () => {
    expect(runtimeSource).toContain("--app-chrome-traffic-space: 96px !important;");
    expect(runtimeSource).toContain("--app-chrome-traffic-margin: 12px !important;");
    expect(runtimeSource).toContain("flex: 0 0 96px !important;");
    expect(runtimeSource).toContain("width: 96px !important;");
  });

  test("keeps the visible renderer responsive when Chromium misclassifies visibility", () => {
    const browserWindowBlock = /new BrowserWindow\(\{([\s\S]*?)minWidth: 900,([\s\S]*?)width: 1280,/.exec(runtimeSource)?.[0] ?? "";

    expect(browserWindowBlock).toContain("backgroundThrottling: false");
  });

  test("ships the original looping video with centered cover playback", () => {
    const videoElement = /<video(?<attributes>[\s\S]*?)><\/video>/.exec(splashSource)?.groups?.attributes ?? "";
    const videoStyles = /video \{([\s\S]*?)\}/.exec(splashSource)?.[0] ?? "";

    expect(createHash("sha256").update(splashVideo).digest("hex")).toBe(
      "52696eec8ebf9541fb892356df88b1ece5a6d0f122fc362837f66020eaba96c4",
    );
    expect(videoElement).toContain('src="splash.mp4"');
    for (const attribute of ["autoplay", "muted", "loop", "playsinline"]) {
      expect(videoElement).toMatch(new RegExp(`\\s${attribute}(?:\\s|$)`));
    }
    expect(videoStyles).toContain("height: 100%");
    expect(videoStyles).toContain("object-fit: cover");
    expect(videoStyles).toContain("object-position: center center");
    expect(videoStyles).toContain("width: 100%");
  });
});
