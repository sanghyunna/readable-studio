import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRendererRecovery, RECOVERY_LIMIT, RECOVERY_WINDOW_MS, HANG_GRACE_MS } from "../../src/main/renderer-recovery.js";

const dialogs = vi.hoisted(() => ({ showMessageBox: vi.fn(), showErrorBox: vi.fn() }));
vi.mock("electron", () => ({ dialog: dialogs }));

class RecoveryWindow extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    executeJavaScript: vi.fn<() => Promise<unknown>>(() => new Promise(() => undefined)),
  });
}

function setup() {
  const window = new RecoveryWindow();
  const record = vi.fn();
  const reportCrash = vi.fn();
  const quit = vi.fn();
  const { dispose } = attachRendererRecovery(window, { record, reportCrash, quit });
  return { window, record, reportCrash, quit, dispose };
}
const crash = (window: RecoveryWindow) => window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 7 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  dialogs.showMessageBox.mockReset();
  dialogs.showMessageBox.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => vi.useRealTimers());

describe("renderer recovery", () => {
  it("offers recovery when a renderer stops answering without an Electron unresponsive event", async () => {
    // Given
    const { window, record } = setup();
    window.webContents.emit("dom-ready");
    // When
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    // Then
    expect(record).toHaveBeenCalledWith({ event: "renderer-unresponsive" });
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });

  it("does not offer recovery when a six-second busy renderer answers the probe", async () => {
    // Given
    const { window, record } = setup();
    const reply = Promise.withResolvers<unknown>();
    window.webContents.executeJavaScript.mockReturnValueOnce(reply.promise).mockResolvedValue(undefined);
    window.webContents.emit("dom-ready");
    // When
    await vi.advanceTimersByTimeAsync(6_000);
    reply.resolve(undefined);
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    // Then
    expect(record).not.toHaveBeenCalled();
    expect(dialogs.showMessageBox).not.toHaveBeenCalled();
  });

  it("closes a heartbeat-triggered recovery dialog when the pending probe answers", async () => {
    // Given
    const { window, record } = setup();
    const reply = Promise.withResolvers<unknown>();
    window.webContents.executeJavaScript.mockReturnValue(reply.promise);
    window.webContents.emit("dom-ready");
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    const options = dialogs.showMessageBox.mock.calls[0]?.[0];
    // When
    reply.resolve(undefined);
    await reply.promise;
    // Then
    expect(record).toHaveBeenCalledWith({ event: "renderer-responsive" });
    expect(options.signal.aborted).toBe(true);
  });

  it("does not mistake a navigation or closed window for a hung renderer", async () => {
    // Given
    const { window, record, dispose } = setup();
    window.webContents.emit("dom-ready");
    // When
    window.webContents.emit("did-start-navigation", {}, "about:blank", false, true);
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    dispose();
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    // Then
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reloads and reports visibly when a renderer crashes", () => {
    // Given
    const { window, record, reportCrash } = setup();
    // When
    crash(window);
    // Then
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
    expect(reportCrash).toHaveBeenCalledWith({ reason: "crashed", exitCode: 7 });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: "renderer-reload", attempt: 1 }));
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("stops automatic reloads and offers recovery when crashes exhaust the budget", () => {
    // Given
    const { window, record } = setup();
    // When
    for (let count = 0; count < RECOVERY_LIMIT + 2; count++) crash(window);
    // Then
    expect(window.webContents.reload).toHaveBeenCalledTimes(RECOVERY_LIMIT);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: "recovery-blocked" }));
    expect(dialogs.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 1, buttons: expect.arrayContaining([expect.any(String), expect.any(String)]) }));
  });

  it("allows another automatic recovery when the rolling window expires", () => {
    // Given
    const { window } = setup();
    for (let count = 0; count < RECOVERY_LIMIT; count++) crash(window);
    vi.advanceTimersByTime(RECOVERY_WINDOW_MS);
    // When
    crash(window);
    // Then
    expect(window.webContents.reload).toHaveBeenCalledTimes(RECOVERY_LIMIT + 1);
  });

  it("blocks discovery retries when the crash budget is exhausted", () => {
    // Given
    const window = new RecoveryWindow();
    const recovery = attachRendererRecovery(window, { record: vi.fn(), reportCrash: vi.fn(), quit: vi.fn() });
    // When
    for (let count = 0; count <= RECOVERY_LIMIT; count++) crash(window);
    // Then
    expect(recovery.isBlocked()).toBe(true);
  });

  it("keeps recovery blocked when a stale load finishes without a manual retry", () => {
    // Given
    const window = new RecoveryWindow();
    const recovery = attachRendererRecovery(window, { record: vi.fn(), reportCrash: vi.fn(), quit: vi.fn() });
    for (let count = 0; count <= RECOVERY_LIMIT; count++) crash(window);
    // When
    window.webContents.emit("did-finish-load");
    // Then
    expect(recovery.isBlocked()).toBe(true);
  });

  it("offers recovery without killing when unresponsiveness is sustained", () => {
    // Given
    const { window, record } = setup();
    // When
    window.emit("unresponsive");
    vi.advanceTimersByTime(HANG_GRACE_MS);
    // Then
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1);
    expect(window.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({ event: "renderer-unresponsive" });
  });

  it("does not show recovery when a brief busy period ends", () => {
    // Given
    const { window } = setup();
    // When
    window.emit("unresponsive");
    vi.advanceTimersByTime(HANG_GRACE_MS - 1);
    window.emit("responsive");
    vi.advanceTimersByTime(HANG_GRACE_MS);
    // Then
    expect(dialogs.showMessageBox).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });

  it.each(["killed", "crashed"])("restarts exactly once when user recovery causes reason %s", async (reason) => {
    // Given
    dialogs.showMessageBox.mockResolvedValue({ response: 0 });
    const { window } = setup();
    window.webContents.forcefullyCrashRenderer.mockImplementation(() => window.webContents.emit("render-process-gone", {}, { reason, exitCode: 0 }));
    // When
    window.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(HANG_GRACE_MS);
    // Then
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending hang dialog when the renderer becomes responsive", () => {
    // Given
    const { window } = setup();
    window.emit("unresponsive");
    vi.advanceTimersByTime(HANG_GRACE_MS);
    const options = dialogs.showMessageBox.mock.calls[0]?.[0];
    // When
    window.emit("responsive");
    // Then
    expect(options.signal.aborted).toBe(true);
  });

  it("removes timers and listeners when disposed", () => {
    // Given
    const { window, dispose } = setup();
    window.emit("unresponsive");
    // When
    dispose();
    vi.advanceTimersByTime(HANG_GRACE_MS);
    crash(window);
    // Then
    expect(dialogs.showMessageBox).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });
});
