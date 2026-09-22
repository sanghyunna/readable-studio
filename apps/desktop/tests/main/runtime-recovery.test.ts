import { EventEmitter, once } from "node:events";
import * as scanProgress from '../../src/main/scan-progress.js';
import { afterEach, expect, it, vi } from "vitest";

class TestWindow extends EventEmitter {
  static readonly instances: TestWindow[] = [];
  static readonly events = new EventEmitter();
  readonly webContents = Object.assign(new EventEmitter(), {
    session: new EventEmitter(), setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(),
    reload: vi.fn(), forcefullyCrashRenderer: vi.fn(),
  });
  readonly loadFile = vi.fn().mockResolvedValue(undefined);
  readonly loadURL = vi.fn(async () => {
    TestWindow.events.emit('navigation');
    throw new Error('navigation interrupted by renderer crash');
  });
  constructor() { super(); TestWindow.instances.push(this); }
  isDestroyed(): boolean { return false; }
  close(): void { this.emit("closed"); }
}
const showMessageBox = vi.fn(() => new Promise(() => undefined));
vi.mock("electron", () => ({
  BrowserWindow: TestWindow, app: { quit: vi.fn() },
  dialog: { showMessageBox, showErrorBox: vi.fn() },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn(), removeAllListeners: vi.fn(), on: vi.fn() },
  nativeImage: {}, screen: new EventEmitter(), session: {}, shell: {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  TestWindow.instances.length = 0;
  TestWindow.events.removeAllListeners();
});

it("keeps discovery from restarting a crash loop when initial navigation failed", async () => {
  // Given: the real runtime coordinator with only the Electron native boundary faked.
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { createDesktopRuntime } = await import("../../src/main/runtime.js");
  const record = vi.fn();
  vi.spyOn(scanProgress, 'startDaemonScan').mockResolvedValue(null);
  const navigation = once(TestWindow.events, 'navigation', { signal: AbortSignal.timeout(2000) });
  const runtime = await createDesktopRuntime({ discoverUrl: async () => "http://127.0.0.1:3000", discoverDaemonUrl: async () => 'http://127.0.0.1:3001', recordCrashEvidence: record });
  await navigation;
  const window = TestWindow.instances[0];
  if (!window) throw new Error("main window not created");
  try {
    // When
    for (let count = 0; count < 3; count++) {
      window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 7 });
    }
    await vi.advanceTimersByTimeAsync(4_000);
    // Then
    expect(window.webContents.reload).toHaveBeenCalledTimes(2);
    expect(window.loadURL).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ event: "recovery-blocked" });
    expect(showMessageBox).toHaveBeenCalledTimes(3);
  } finally {
    await runtime.close();
  }
});
