import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../..");

function runtimeSource(): string {
  return readFileSync(join(desktopRoot, "src/main/runtime.ts"), "utf8");
}

function between(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  expect(start, `${startNeedle} not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end, `${endNeedle} not found after ${startNeedle}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("desktop pet window lifecycle", () => {
  it("does not create the pet BrowserWindow during desktop runtime startup", () => {
    const runtime = runtimeSource();
    const startupBeforeLazyHelper = between(
      runtime,
      "export async function createDesktopRuntime",
      "const ensureDesktopPetWindow",
    );

    expect(startupBeforeLazyHelper).not.toContain("createDesktopPetWindow(");
    expect(startupBeforeLazyHelper).toContain("let petWindow: BrowserWindow | null = null");
  });

  it("creates or reuses exactly one pet window when the saved preference is enabled", () => {
    const runtime = runtimeSource();
    const helper = between(runtime, "const ensureDesktopPetWindow", "const isDesktopPetEnabled");

    expect(helper).toContain("if (petWindow == null || petWindow.isDestroyed())");
    expect(helper).toContain("petWindow = createDesktopPetWindow(preloadPath, options.osLocale)");
    expect(helper).toContain("currentPetUrl = null");
    expect(helper).toContain("const nextPetUrl = desktopPetUrl(baseUrl)");
    expect(helper).toContain("if (nextPetUrl !== currentPetUrl)");
    expect(helper).toContain("await petWindow.loadURL(nextPetUrl)");
  });

  it("restores existing enabled-pet preference and picks up later toggles", () => {
    const runtime = runtimeSource();
    const enabledProbe = between(runtime, "const isDesktopPetEnabled", "ipcMain.removeAllListeners");
    const tick = between(runtime, "const tick = async", "void tick()");

    expect(enabledProbe).toContain('localStorage.getItem("readable-studio:config")');
    expect(enabledProbe).toContain("JSON.parse(raw)?.pet?.enabled === true");
    expect(tick).toContain("if (await isDesktopPetEnabled())");
    expect(tick).toContain("await ensureDesktopPetWindow(url)");
    expect(tick).toContain("await ensureDesktopPetWindow(currentUrl)");
    expect(tick).toContain("petWindow.hide()");
  });

  it("treats pre-creation pet IPC and shutdown as safe no-ops", () => {
    const runtime = runtimeSource();
    const petIpc = between(runtime, 'ipcMain.on("desktop-pet:set-visible"', "ipcMain.removeHandler('readable-studio:print-pdf')");
    const close = between(runtime, "async close()", "console() {");

    expect(petIpc).toContain("petWindow != null && !petWindow.isDestroyed()");
    expect(petIpc).toContain("event.sender === window.webContents");
    expect(petIpc).toContain("if (!ownedPetWindow && !mainWindow) return");
    expect(close).toContain("if (petWindow != null && !petWindow.isDestroyed()) petWindow.close()");
  });
});
