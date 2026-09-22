import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import * as scanProgress from "../../src/main/scan-progress.js";

class TestWindow extends EventEmitter {
  static readonly instances: TestWindow[] = [];
  destroyed = false;
  readonly contents = Object.assign(new EventEmitter(), {
    session: new EventEmitter(),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn<() => Promise<unknown>>(() => new Promise(() => undefined)),
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
  });
  readonly loadFile = vi.fn().mockResolvedValue(undefined);
  readonly loadURL = vi.fn().mockResolvedValue(undefined);
  readonly show = vi.fn();
  readonly focus = vi.fn();
  constructor() { super(); TestWindow.instances.push(this); }
  get webContents() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.contents;
  }
  isDestroyed(): boolean { return this.destroyed; }
  close(): void {
    this.destroyed = true;
    this.contents.emit("destroyed");
    this.emit("closed");
  }
}

const dialogs = vi.hoisted(() => ({ showMessageBox: vi.fn(), showErrorBox: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: TestWindow, app: { quit: vi.fn() }, dialog: dialogs,
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn(), removeAllListeners: vi.fn(), on: vi.fn() },
  nativeImage: {}, screen: new EventEmitter(), session: {}, shell: {},
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  TestWindow.instances.length = 0;
});

it.each(["splash visible", "probe active"] as const)("finishes Windows user-close teardown when %s", async (state) => {
  // Given: real desktop coordinator and an adopted packaged splash, native boundary only faked.
  vi.useFakeTimers();
  vi.spyOn(scanProgress, "startDaemonScan").mockResolvedValue(null);
  vi.spyOn(scanProgress, "readDaemonScan").mockResolvedValue(null);
  const { createDesktopRuntime, createSplashWindow } = await import("../../src/main/runtime.js");
  const splash = createSplashWindow();
  const closed = Promise.withResolvers<void>();
  const requestQuit = vi.fn(() => { void runtime.close().then(closed.resolve, closed.reject); });
  const runtime = await createDesktopRuntime({
    discoverUrl: async () => null,
    discoverDaemonUrl: async () => null,
    splashWindow: splash.window,
    splashStartedAt: splash.startedAt,
    requestQuit,
  });
  const main = TestWindow.instances[1];
  const splashWindow = TestWindow.instances[0];
  if (!main || !splashWindow) throw new TypeError("Expected main and adopted splash windows");
  expect(main.show).not.toHaveBeenCalled();
  if (state === "probe active") main.contents.emit("dom-ready");

  // When: native destruction precedes closed; the later shutdown callback disposes again.
  try {
    expect(() => main.close()).not.toThrow();
    await closed.promise;
    await runtime.close();
    await vi.runAllTimersAsync();

    // Then: the closed listener still requests app shutdown, and no recovery work survives.
    expect(requestQuit).toHaveBeenCalledOnce();
    expect(splashWindow.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(main.contents.listenerCount("dom-ready")).toBe(0);
    expect(main.contents.listenerCount("render-process-gone")).toBe(0);
    expect(main.contents.reload).not.toHaveBeenCalled();
    expect(dialogs.showMessageBox).not.toHaveBeenCalled();
    expect(dialogs.showErrorBox).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});
