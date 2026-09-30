import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";
import { collectWorkspaceTarballs, ensureWinWorkspaceBuild, prepareWinPackagedApp } from "../src/win/app.js";
import { packWin } from "../src/win/build.js";
import { runElectronBuilder } from "../src/win/builder.js";
import { copyWinIcon, prepareResourceTree } from "../src/win/resources.js";

// Only heavyweight stage boundaries are replaced; packWin's actual dependency
// ordering, opt-in routing, timing wrapper, and error propagation execute.
vi.mock("../src/win/app.js", () => ({
  ensureWinWorkspaceBuild: vi.fn(),
  collectWorkspaceTarballs: vi.fn(),
  createWinPackagedAppCacheKey: vi.fn(async () => "app-key"),
  prepareWinPackagedApp: vi.fn(),
}));
vi.mock("../src/win/builder.js", () => ({ runElectronBuilder: vi.fn(async () => []) }));
vi.mock("../src/win/manifest.js", () => ({ readBuiltAppManifest: vi.fn(async () => null) }));
vi.mock("../src/win/report.js", () => ({ collectWinSizeReport: vi.fn() }));
vi.mock("../src/win/resources.js", () => ({ prepareResourceTree: vi.fn(), copyWinIcon: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureWinWorkspaceBuild).mockResolvedValue(undefined);
  vi.mocked(collectWorkspaceTarballs).mockResolvedValue({ key: "tarballs", tarballs: [] });
  vi.mocked(prepareWinPackagedApp).mockResolvedValue({ appRoot: "app", key: "app-key", packagedVersion: "1.2.1" });
  vi.mocked(prepareResourceTree).mockResolvedValue({ key: "resources", resourceRoot: "resources" });
  vi.mocked(copyWinIcon).mockResolvedValue(undefined);
});

describe("opt-in build preparation scheduling", () => {
  it("preserves the serial stage order when the flag is off", async () => {
    // Given the existing default configuration
    const config = resolveToolPackConfig("win", { namespace: "perf-test" });
    // When the orchestrator runs without a fast flag
    const result = await packWin(config);
    // Then it retains the historical serial phase ordering
    expect(result.timings.map(({ phase }) => phase)).toEqual([
      "workspace-build", "resource-tree", "win-icon", "workspace-tarballs", "packaged-app", "electron-builder", "size-report",
    ]);
  });

  it("overlaps independent preparation only after workspace outputs exist", async () => {
    // Given a resource task held open until the independent app task starts
    const events = new EventEmitter();
    const appStarted = once(events, "app", { signal: AbortSignal.timeout(3000) });
    const resourceGate = Promise.withResolvers<void>();
    let workspaceReady = false;
    vi.mocked(ensureWinWorkspaceBuild).mockImplementation(async () => { workspaceReady = true; });
    vi.mocked(prepareResourceTree).mockImplementation(async () => {
      expect(workspaceReady).toBe(true);
      await resourceGate.promise;
      return { key: "resources", resourceRoot: "resources" };
    });
    vi.mocked(prepareWinPackagedApp).mockImplementation(async () => {
      expect(workspaceReady).toBe(true);
      events.emit("app");
      return { appRoot: "app", key: "app-key", packagedVersion: "1.2.1" };
    });
    // When fast preparation runs
    const build = packWin(resolveToolPackConfig("win", { fastBuild: true, namespace: "perf-test" }));
    try {
      await appStarted;
      // Then app preparation overlaps the held resource task, but Electron waits
      expect(runElectronBuilder).not.toHaveBeenCalled();
    } finally {
      resourceGate.resolve();
      await build;
    }
    expect(runElectronBuilder).toHaveBeenCalledOnce();
  });

  it("drains independent work before rejecting when another preparation fails", async () => {
    // Given a resource failure while app preparation is still in flight
    const resourceGate = Promise.withResolvers<void>();
    const { port1, port2 } = new MessageChannel();
    const appCompleted = once(port1, "message", { signal: AbortSignal.timeout(3000) });
    const events = new EventEmitter();
    const appStarted = once(events, "app", { signal: AbortSignal.timeout(3000) });
    const failure = new Error("resource failure");
    let appFinished = false;
    vi.mocked(prepareResourceTree).mockImplementation(async () => {
      await resourceGate.promise;
      throw failure;
    });
    vi.mocked(prepareWinPackagedApp).mockImplementation(async () => {
      events.emit("app");
      await appCompleted;
      appFinished = true;
      return { appRoot: "app", key: "app-key", packagedVersion: "1.2.1" };
    });
    // When one fast preparation fails
    const build = packWin(resolveToolPackConfig("win", { fastBuild: true, namespace: "perf-test" }));
    const outcome = build.then(
      () => ({ error: undefined, appFinished }),
      (error: unknown) => ({ error, appFinished }),
    );
    try {
      await appStarted;
      resourceGate.resolve();
      // Delivery is an explicit completion event in a later event-loop turn,
      // after the failure's promise reactions; there is no elapsed-time wait.
      port2.postMessage("complete");
      // Then failure is propagated only after the sibling finishes, without Electron
      expect(await outcome).toEqual({ error: failure, appFinished: true });
      expect(runElectronBuilder).not.toHaveBeenCalled();
    } finally {
      resourceGate.resolve();
      port2.postMessage("complete");
      await outcome;
      await appCompleted;
      port1.close();
      port2.close();
    }
  });
});
