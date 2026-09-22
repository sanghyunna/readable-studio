import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachRendererRecovery, HANG_GRACE_MS } from "../../src/main/renderer-recovery.js";

const dialogs = vi.hoisted(() => ({ showMessageBox: vi.fn(), showErrorBox: vi.fn() }));
vi.mock("electron", () => ({ dialog: dialogs }));

class DestroyableWindow extends EventEmitter {
  destroyed = false;
  readonly contents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    executeJavaScript: vi.fn<() => Promise<unknown>>(() => new Promise(() => undefined)),
  });

  get webContents() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.contents;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  dialogs.showMessageBox.mockReset();
  dialogs.showMessageBox.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => vi.useRealTimers());

it.each(["closed", "destroyed"] as const)("tears down without accessing the destroyed window when %s fires", (event) => {
  // Given: native destruction invalidates the BrowserWindow getter before its event.
  const window = new DestroyableWindow();
  const record = vi.fn();
  const recovery = attachRendererRecovery(window, { record, reportCrash: vi.fn(), quit: vi.fn() });
  window.contents.emit("dom-ready");
  window.emit("unresponsive");
  expect(vi.getTimerCount()).toBe(2);
  window.destroyed = true;

  // When: Electron emits its final lifecycle event, then the runtime disposes again.
  expect(() => {
    (event === "closed" ? window : window.contents).emit(event);
    recovery.dispose();
    recovery.dispose();
  }).not.toThrow();

  // Then: owned listeners and timers are gone, including the closed fallback.
  expect(vi.getTimerCount()).toBe(0);
  expect(window.eventNames()).toEqual([]);
  expect(window.contents.eventNames()).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});

it("stops probes immediately when WebContents is destroyed before the window closes", () => {
  // Given
  const window = new DestroyableWindow();
  const recovery = attachRendererRecovery(window, { record: vi.fn(), reportCrash: vi.fn(), quit: vi.fn() });
  window.contents.emit("dom-ready");

  // When: no BrowserWindow closed event has arrived yet.
  window.contents.emit("destroyed");

  // Then
  expect(vi.getTimerCount()).toBe(0);
  expect(window.contents.listenerCount("dom-ready")).toBe(0);
  expect(window.listenerCount("closed")).toBe(0);
  recovery.dispose();
});

it.each(["resolve", "reject"] as const)("ignores a late probe %s when shutdown already disposed recovery", async (outcome) => {
  // Given
  const window = new DestroyableWindow();
  const reply = Promise.withResolvers<unknown>();
  window.contents.executeJavaScript.mockReturnValue(reply.promise);
  const record = vi.fn();
  const recovery = attachRendererRecovery(window, { record, reportCrash: vi.fn(), quit: vi.fn() });
  window.contents.emit("dom-ready");
  recovery.dispose();
  window.destroyed = true;
  const settled = reply.promise.then(() => undefined, () => undefined);

  // When
  switch (outcome) {
    case "resolve": reply.resolve(undefined); break;
    case "reject": reply.reject(new TypeError("Object has been destroyed")); break;
    default: { const exhaustive: never = outcome; throw new TypeError(exhaustive); }
  }
  await settled;

  // Then
  expect(record).not.toHaveBeenCalled();
  expect(dialogs.showMessageBox).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("aborts the recovery dialog and ignores its reload choice when the window is destroyed", async () => {
  // Given
  const window = new DestroyableWindow();
  const choice = Promise.withResolvers<{ response: number }>();
  dialogs.showMessageBox.mockReturnValue(choice.promise);
  const quit = vi.fn();
  attachRendererRecovery(window, { record: vi.fn(), reportCrash: vi.fn(), quit });
  window.emit("unresponsive");
  vi.advanceTimersByTime(HANG_GRACE_MS);
  const options = dialogs.showMessageBox.mock.calls[0]?.[0];

  // When
  window.destroyed = true;
  window.contents.emit("destroyed");
  choice.resolve({ response: 0 });
  await choice.promise;

  // Then
  expect(options.signal.aborted).toBe(true);
  expect(window.contents.reload).not.toHaveBeenCalled();
  expect(window.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});

it("keeps recovery active when a close attempt is cancelled", () => {
  // Given
  const window = new DestroyableWindow();
  const recovery = attachRendererRecovery(window, { record: vi.fn(), reportCrash: vi.fn(), quit: vi.fn() });
  window.contents.emit("dom-ready");

  // When: close is cancellable, unlike destroyed/closed.
  window.emit("close", { preventDefault: vi.fn() });

  // Then
  expect(vi.getTimerCount()).toBe(1);
  expect(window.contents.listenerCount("dom-ready")).toBe(1);
  recovery.dispose();
});
