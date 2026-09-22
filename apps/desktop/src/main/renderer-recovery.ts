import type { EventEmitter } from "node:events";
import { dialog } from "electron";
import type { CrashEvidenceEvent } from "./crash-evidence.js";

export const RECOVERY_LIMIT = 2;
export const RECOVERY_WINDOW_MS = 60_000;
export const HANG_GRACE_MS = 10_000;

type RecoveryWindow = EventEmitter & {
  readonly webContents: EventEmitter & {
    reload(): void;
    forcefullyCrashRenderer(): void;
    executeJavaScript(code: string): Promise<unknown>;
  };
};
type RecoveryActions = {
  readonly record: (event: CrashEvidenceEvent) => void;
  readonly reportCrash: (details: { readonly reason: string; readonly exitCode: number }) => void;
  readonly quit: () => void;
};

/** Native dialogs remain usable even when the web renderer cannot run JavaScript. */
export function attachRendererRecovery(window: RecoveryWindow, actions: RecoveryActions) {
  // BrowserWindow.webContents is a native getter and can throw during `closed`.
  // Retain the emitter while alive so teardown only touches JS listeners.
  const webContents = window.webContents;
  let attempts: number[] = [];
  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  let activeDialog: AbortController | undefined;
  let hangDialog = false;
  let disposed = false;
  let manualCrashPending = false;
  let manualLoadPending = false;
  let blocked = false;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let pendingProbe: { startedAt: number } | undefined;
  let lastTick = 0;

  const stopProbes = (): void => {
    clearInterval(probeTimer);
    probeTimer = undefined;
    pendingProbe = undefined;
  };

  const cancelHangTimer = (): void => {
    clearTimeout(hangTimer);
    hangTimer = undefined;
  };
  const showRecovery = (mode: "reloading" | "blocked" | "hung"): void => {
    activeDialog?.abort();
    const controller = new AbortController();
    activeDialog = controller;
    hangDialog = mode === "hung";
    const content = (() => {
      switch (mode) {
        case "reloading": return {
          message: "Readable Studio's display stopped unexpectedly. Reloading the display.",
          detail: "Unsaved changes may be lost. Local failure recording was attempted; this does not identify the original cause.",
          buttons: ["OK"], cancelId: 0,
        };
        case "blocked": return {
          message: "The display has failed repeatedly. Automatic recovery has stopped.",
          detail: "Retry once, or quit normally and reopen Readable Studio. Local evidence is in logs/desktop/crashes.jsonl under this namespace's data root. Unsaved changes may be lost.",
          buttons: ["Retry once", "Quit Readable Studio"], cancelId: 1,
        };
        case "hung": return {
          message: "Readable Studio's display is still not responding.",
          detail: "It may be busy, not crashed. Reloading can lose unsaved changes. You can keep waiting or quit normally.",
          buttons: ["Reload display", "Quit Readable Studio", "Keep waiting"], cancelId: 2,
        };
        default: { const exhaustive: never = mode; return exhaustive; }
      }
    })();
    void dialog.showMessageBox({
      type: "warning", title: "Readable Studio recovery", defaultId: 0,
      ...content, signal: controller.signal, noLink: true,
    }).then(({ response }) => {
      if (disposed || controller.signal.aborted) return;
      activeDialog = undefined;
      hangDialog = false;
      if (mode === "reloading") return;
      if (response === 1) {
        actions.quit();
      } else if (response === 0) {
        actions.record({ event: "manual-reload" });
        manualLoadPending = true;
        if (mode === "hung") {
          manualCrashPending = true;
          window.webContents.forcefullyCrashRenderer();
        }
        // Manual retries never reset the automatic crash budget.
        window.webContents.reload();
      } else {
        if (pendingProbe) pendingProbe.startedAt = Date.now();
        onUnresponsive();
      }
    }).catch((error: unknown) => {
      if (disposed || controller.signal.aborted) return;
      console.error("desktop recovery dialog failed", { errorType: error instanceof Error ? error.name : "unknown" });
      dialog.showErrorBox("Readable Studio recovery", "The recovery dialog failed. Readable Studio will quit normally; reopen it to retry.");
      actions.quit();
    });
  };
  const onGone = (_event: unknown, details: { readonly reason: string; readonly exitCode: number }): void => {
    cancelHangTimer();
    stopProbes();
    actions.record({ event: "renderer-gone", reason: details.reason, exitCode: details.exitCode });
    actions.reportCrash(details);
    if (manualCrashPending && (details.reason === "killed" || details.reason === "crashed")) {
      manualCrashPending = false;
      return;
    }
    manualCrashPending = false;
    manualLoadPending = false;
    if (details.reason === "clean-exit") return;
    const now = Date.now();
    attempts = attempts.filter((at) => now - at < RECOVERY_WINDOW_MS);
    if (attempts.length >= RECOVERY_LIMIT) {
      blocked = true;
      actions.record({ event: "recovery-blocked" });
      showRecovery("blocked");
      return;
    }
    blocked = false;
    attempts.push(now);
    actions.record({ event: "renderer-reload", attempt: attempts.length });
    window.webContents.reload();
    showRecovery("reloading");
  };
  const onHung = (): void => {
    if (hangDialog || disposed || blocked) return;
    cancelHangTimer();
    actions.record({ event: "renderer-unresponsive" });
    showRecovery("hung");
  };
  const onUnresponsive = (): void => {
    if (hangTimer !== undefined || hangDialog || disposed || blocked) return;
    hangTimer = setTimeout(onHung, HANG_GRACE_MS);
  };
  const onResponsive = (): void => {
    cancelHangTimer();
    if (hangDialog) {
      actions.record({ event: "renderer-responsive" });
      activeDialog?.abort();
      activeDialog = undefined;
      hangDialog = false;
    }
  };
  // Main owns both cadence and deadline. Only one content-free probe can be
  // outstanding; executing it requires the renderer's JavaScript thread, unlike
  // Chromium's native unresponsive heuristic. No renderer timers or web changes.
  const probe = (): void => {
    const now = Date.now();
    if (pendingProbe) {
      // A suspended machine / stalled main loop is not evidence of renderer hang.
      if (now - lastTick >= HANG_GRACE_MS) pendingProbe.startedAt = now;
      lastTick = now;
      if (now - pendingProbe.startedAt >= HANG_GRACE_MS) onHung();
      return;
    }
    lastTick = now;
    const current = { startedAt: now };
    pendingProbe = current;
    void window.webContents.executeJavaScript("void 0").then(() => {
      if (pendingProbe !== current || disposed) return;
      pendingProbe = undefined;
      onResponsive();
    }, (error: unknown) => {
      if (pendingProbe !== current || disposed) return;
      pendingProbe = undefined;
      console.warn("desktop renderer liveness probe failed", { errorType: error instanceof Error ? error.name : "unknown" });
    });
  };
  const onReady = (): void => {
    stopProbes();
    probe();
    probeTimer = setInterval(probe, 1_000);
  };
  const onNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) {
      stopProbes();
      onResponsive();
    }
  };
  const onLoaded = (): void => {
    if (manualLoadPending) blocked = false;
    manualLoadPending = false;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelHangTimer();
    stopProbes();
    activeDialog?.abort();
    webContents.removeListener("render-process-gone", onGone);
    webContents.removeListener("did-finish-load", onLoaded);
    webContents.removeListener("dom-ready", onReady);
    webContents.removeListener("did-start-navigation", onNavigation);
    webContents.removeListener("destroyed", dispose);
    window.removeListener("unresponsive", onUnresponsive);
    window.removeListener("responsive", onResponsive);
    window.removeListener("closed", dispose);
  };
  webContents.on("render-process-gone", onGone);
  webContents.on("did-finish-load", onLoaded);
  webContents.on("dom-ready", onReady);
  webContents.on("did-start-navigation", onNavigation);
  webContents.on("destroyed", dispose);
  window.on("unresponsive", onUnresponsive);
  window.on("responsive", onResponsive);
  window.on("closed", dispose);
  return { dispose, isBlocked: (): boolean => blocked };
}
