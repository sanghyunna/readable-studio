import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  getFocusedWindow: vi.fn(),
  register: vi.fn(),
  setApplicationMenu: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: electronMocks.getFocusedWindow,
  },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
    setApplicationMenu: electronMocks.setApplicationMenu,
  },
  app: { name: "Readable Studio" },
  dialog: { showErrorBox: vi.fn() },
  globalShortcut: {
    register: electronMocks.register,
    unregister: electronMocks.unregister,
  },
  shell: {},
}));

import { installDesktopMenu } from "../../src/main/index.js";
import {
  applyDesktopBaselineZoom,
  CHROMIUM_DEFAULT_ZOOM_FACTOR,
  CHROMIUM_ZOOM_STEP_RATIO,
  DESKTOP_BASELINE_ZOOM_FACTOR,
} from "../../src/main/zoom.js";

const runtime = {} as Parameters<typeof installDesktopMenu>[0];

function viewMenuTemplate(): MenuItemConstructorOptions[] {
  const template = electronMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
  const viewMenu = template.find((item) => item.label === "View");
  return viewMenu?.submenu as MenuItemConstructorOptions[];
}

describe("desktop zoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.buildFromTemplate.mockImplementation((template: MenuItemConstructorOptions[]) => template);
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.register.mockReturnValue(false);
  });

  it("defines the baseline as one Chromium step above the default", () => {
    expect(DESKTOP_BASELINE_ZOOM_FACTOR).toBe(CHROMIUM_DEFAULT_ZOOM_FACTOR * CHROMIUM_ZOOM_STEP_RATIO);
  });

  it("applies the baseline to a created window's web contents", () => {
    const webContents = { setZoomFactor: vi.fn() };

    applyDesktopBaselineZoom(webContents);

    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(DESKTOP_BASELINE_ZOOM_FACTOR);
  });

  it("keeps normal zoom stepping shortcuts and resets Ctrl+0 to the baseline", () => {
    installDesktopMenu(runtime);

    const viewMenu = viewMenuTemplate();
    const zoomItems = viewMenu.filter(
      (item) => item.accelerator === "CommandOrControl+0" || item.role === "zoomIn" || item.role === "zoomOut",
    );

    expect(zoomItems).toEqual([
      { label: "Reset Zoom", accelerator: "CommandOrControl+0", click: expect.any(Function) },
      { role: "zoomIn", accelerator: "CommandOrControl+Plus" },
      { role: "zoomIn", accelerator: "CommandOrControl+=", visible: false },
      { role: "zoomIn", accelerator: "CommandOrControl+numadd", visible: false },
      { role: "zoomOut", accelerator: "CommandOrControl+-" },
      { role: "zoomOut", accelerator: "CommandOrControl+numsub", visible: false },
    ]);

    const resetZoom = zoomItems[0];
    const webContents = { setZoomFactor: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue({ webContents });
    resetZoom.click?.({} as never, undefined, {} as never);

    expect(resetZoom.role).toBeUndefined();
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(DESKTOP_BASELINE_ZOOM_FACTOR);
  });
});
