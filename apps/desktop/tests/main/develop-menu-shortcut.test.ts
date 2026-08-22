import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  register: vi.fn(),
  setApplicationMenu: vi.fn(),
  showErrorBox: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
    setApplicationMenu: electronMocks.setApplicationMenu,
  },
  app: { name: "Readable Studio" },
  dialog: { showErrorBox: electronMocks.showErrorBox },
  globalShortcut: {
    register: electronMocks.register,
    unregister: electronMocks.unregister,
  },
  shell: {},
}));

import { installDesktopMenu } from "../../src/main/index.js";

const runtime = {} as Parameters<typeof installDesktopMenu>[0];

function hasDevelopMenu(template: MenuItemConstructorOptions[]): boolean {
  return template.some((item) => item.label === "Develop");
}

describe("Develop menu shortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.buildFromTemplate.mockImplementation((template: MenuItemConstructorOptions[]) => template);
  });

  it("continues without a dialog when the global shortcut is already registered elsewhere", () => {
    electronMocks.register.mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const dispose = installDesktopMenu(runtime);

    expect(dispose).toEqual(expect.any(Function));
    expect(electronMocks.showErrorBox).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    dispose();
    expect(electronMocks.unregister).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("registers the shortcut and toggles the Develop menu", async () => {
    let toggleDevelopMenu: (() => void) | undefined;
    electronMocks.register.mockImplementation((_accelerator: string, callback: () => void) => {
      toggleDevelopMenu = callback;
      return true;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ config: {} }), { status: 200 })));

    const dispose = installDesktopMenu(runtime, {
      discoverDaemonUrl: async () => "http://127.0.0.1:8787",
    });
    const initialTemplate = electronMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
    expect(hasDevelopMenu(initialTemplate)).toBe(false);

    toggleDevelopMenu?.();
    await vi.waitFor(() => {
      const latestTemplate = electronMocks.buildFromTemplate.mock.lastCall?.[0] as MenuItemConstructorOptions[];
      expect(hasDevelopMenu(latestTemplate)).toBe(true);
    });

    toggleDevelopMenu?.();
    const hiddenTemplate = electronMocks.buildFromTemplate.mock.lastCall?.[0] as MenuItemConstructorOptions[];
    expect(hasDevelopMenu(hiddenTemplate)).toBe(false);

    dispose();
    expect(electronMocks.unregister).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
