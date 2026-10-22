import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  availableParallelism: vi.fn(() => 2),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(availableParallelism).mockReturnValue(2);
});

import { ToolPackCache } from "../src/cache.js";
import type { BuildEvent, BuildReceipt } from "../src/build-events.js";
import type { ToolPackConfig } from "../src/config.js";
import { ensureWorkspaceBuildArtifacts, ensureWorkspacePackageBuilds } from "../src/workspace-build.js";

const PACKAGE_DIRS = [
  "packages/components",
  "packages/contracts",
  "packages/registry-protocol",
  "packages/sidecar-proto",
  "packages/sidecar",
  "packages/platform",
  "packages/download",
  "packages/host",
  "packages/html-edit",
  "packages/agui-adapter",
  "packages/plugin-runtime",
  "packages/product-identity",
  "packages/diagnostics",
  "apps/daemon",
  "apps/web",
  "apps/desktop",
  "apps/packaged",
] as const;

const OUTPUT_FILES = [
  "packages/components/dist/index.mjs",
  "packages/components/dist/index.d.ts",
  "packages/contracts/dist/index.mjs",
  "packages/contracts/dist/index.d.ts",
  "packages/registry-protocol/dist/index.mjs",
  "packages/registry-protocol/dist/index.d.ts",
  "packages/sidecar-proto/dist/index.mjs",
  "packages/sidecar-proto/dist/index.d.ts",
  "packages/sidecar/dist/index.mjs",
  "packages/sidecar/dist/index.d.ts",
  "packages/platform/dist/index.mjs",
  "packages/platform/dist/index.d.ts",
  "packages/platform/dist/native/win32/agent-isolator.exe",
  "packages/download/dist/index.mjs",
  "packages/download/dist/index.d.ts",
  "packages/host/dist/index.mjs",
  "packages/host/dist/index.d.ts",
  "packages/html-edit/dist/index.js",
  "packages/html-edit/dist/index.d.ts",
  "packages/agui-adapter/dist/index.mjs",
  "packages/agui-adapter/dist/index.d.ts",
  "packages/plugin-runtime/dist/index.mjs",
  "packages/plugin-runtime/dist/index.d.ts",
  "packages/product-identity/dist/index.js",
  "packages/product-identity/dist/index.d.ts",
  "packages/diagnostics/dist/index.mjs",
  "packages/diagnostics/dist/index.d.ts",
  "apps/daemon/dist/cli.js",
  "apps/daemon/dist/cli.d.ts",
  "apps/daemon/dist/sidecar/index.js",
  "apps/web/dist/sidecar/index.js",
  "apps/web/dist/sidecar/index.d.ts",
  "apps/web/.next/standalone/apps/web/server.js",
  "apps/web/.next/static/chunk.js",
  "apps/desktop/dist/main/index.js",
  "apps/desktop/dist/main/index.d.ts",
  "apps/packaged/dist/index.mjs",
  "apps/packaged/dist/index.d.ts",
] as const;

async function writeWorkspace(root: string): Promise<void> {
  await writeFile(join(root, "package.json"), `${JSON.stringify({ packageManager: "pnpm@10.33.2" }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await Promise.all(PACKAGE_DIRS.map(async (directory) => {
    await mkdir(join(root, directory, "src"), { recursive: true });
    await writeFile(join(root, directory, "package.json"), `${JSON.stringify({ name: `@readable-studio/${directory.split("/")[1]}`, scripts: { build: "fixture-build" } }, null, 2)}\n`, "utf8");
    await writeFile(join(root, directory, "src", "index.ts"), "export const value = 1;\n", "utf8");
  }));
}

async function writeOutputs(root: string, value: string): Promise<void> {
  await Promise.all(OUTPUT_FILES.map(async (file) => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), `${value}\n`, "utf8");
  }));
}

async function writePackageOutputs(root: string, directory: string, value: string): Promise<void> {
  await Promise.all(OUTPUT_FILES.filter((file) => file.startsWith(`${directory}/`)).map(async (file) => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), value);
  }));
}

function createConfig(root: string, cacheRoot: string): ToolPackConfig {
  return {
    electronBuilderCliPath: "electron-builder",
    electronDistPath: "electron-dist",
    electronVersion: "41.3.0",
    namespace: "test",
    platform: "win",
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      cacheRoot,
      output: {
        appBuilderRoot: join(root, ".tmp", "builder"),
        namespaceRoot: join(root, ".tmp", "out", "win", "namespaces", "test"),
        platformRoot: join(root, ".tmp", "out", "win"),
        root: join(root, ".tmp", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "runtime", "win", "namespaces"),
        namespaceRoot: join(root, ".tmp", "runtime", "win", "namespaces", "test"),
      },
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

// Same real-I/O reasoning as the artifact tests below: no test here asserts on elapsed time.
describe("dependency-keyed workspace package builds", { timeout: 60_000 }, () => {
  it.each([
    ["1", 1], ["3", 3], ["30", 17], [undefined, 17],
    ["invalid", 17], ["0", 17], ["-1", 17], ["1.5", 17],
  ] as const)("limits controllable producers with budget %s to %i", async (budget, limit) => {
    const root = await mkdtemp(join(tmpdir(), "readable-package-budget-"));
    const signals = PACKAGE_DIRS.map(() => new EventEmitter());
    // Waits are event-only: a wall-clock abort here would race real fs work that
    // slows down under machine load. The per-test timeout below is the bounded backstop.
    const starts = signals.map((signal) => once(signal, "start"));
    const releaseFirst = Promise.withResolvers<void>();
    const releaseAll = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    let started = 0;
    vi.stubEnv("READABLE_BUILD_CONCURRENCY", budget);
    vi.mocked(availableParallelism).mockReturnValue(20);
    try {
      await writeWorkspace(root);
      const work = ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), async (info) => {
        const index = started++;
        active += 1;
        peak = Math.max(peak, active);
        signals[index]!.emit("start");
        try {
          await (index === 0 ? Promise.race([releaseFirst.promise, releaseAll.promise]) : releaseAll.promise);
          await writePackageOutputs(root, info.directory, "built");
        } finally { active -= 1; }
      });
      try {
        await Promise.all(starts.slice(0, limit));
        expect(started).toBe(limit);
        expect(active).toBe(limit);
        if (limit < PACKAGE_DIRS.length) {
          releaseFirst.resolve();
          await starts[limit];
          expect(active).toBe(limit);
        }
      } finally { releaseAll.resolve(); await work; }
      expect(started).toBe(PACKAGE_DIRS.length);
      expect(peak).toBe(limit);
    } finally { releaseFirst.resolve(); releaseAll.resolve(); await rm(root, { recursive: true, force: true }); }
    // Budget 1 serializes all producers through real cache/receipt fs work, so the default
    // 5s is load-dependent; 60s only bounds a genuine hang.
  }, 60_000);

  it("publishes dependency receipts before dependent start and builds only the selected ancestor closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-selected-ready-"));
    const eventPath = join(root, "events.jsonl");
    const signals = new EventEmitter();
    const dependencyStarted = once(signals, "dependency", { signal: AbortSignal.timeout(10_000) });
    const dependentStarted = once(signals, "dependent", { signal: AbortSignal.timeout(10_000) });
    const releaseDependency = Promise.withResolvers<void>();
    const built: string[] = [];
    const readEvents = async (): Promise<BuildEvent[]> =>
      (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as BuildEvent);
    try {
      await writeWorkspace(root);
      await writeFile(join(root, "apps/daemon/package.json"), JSON.stringify({
        dependencies: { "@readable-studio/contracts": "workspace:*" },
      }));
      await writeFile(join(root, "packages/contracts/package.json"), JSON.stringify({
        devDependencies: { "@readable-studio/registry-protocol": "workspace:*" },
      }));
      vi.stubEnv("READABLE_BUILD_EVENTS", eventPath);
      vi.stubEnv("READABLE_BUILD_RUN_ID", "selected-1");
      const config = createConfig(root, join(root, ".cache"));
      const work = ensureWorkspacePackageBuilds(config, async (info) => {
        built.push(info.name);
        if (info.name === "@readable-studio/contracts") {
          signals.emit("dependency");
          await releaseDependency.promise;
        }
        if (info.name === "@readable-studio/daemon") {
          const events = await readEvents();
          const dependency = events.find((event) => event.event === "node-ready" && event.node === "@readable-studio/contracts")!;
          expect(dependency).toBeDefined();
          const receipt = JSON.parse(await readFile(dependency.receipt!, "utf8")) as BuildReceipt;
          expect(receipt.inputHash).toBe(dependency.inputHash);
          expect(receipt.manifestHash).toBe(dependency.outputManifestHash);
          expect(await readFile(join(receipt.outputRoot, receipt.files[0]!.path), "utf8")).toBe("built");
          signals.emit("dependent");
        }
        await writePackageOutputs(root, info.directory, "built");
      }, { packages: ["@readable-studio/daemon"] });
      try {
        await dependencyStarted;
        expect(built).not.toContain("@readable-studio/daemon");
        expect((await readEvents()).filter((event) => event.node === "@readable-studio/contracts")).toHaveLength(0);
        releaseDependency.resolve();
        await dependentStarted;
      } finally { releaseDependency.resolve(); await work; }
      expect(built).toEqual([
        "@readable-studio/registry-protocol", "@readable-studio/contracts", "@readable-studio/daemon",
      ]);
      const events = await readEvents();
      expect(events[0]!.event).toBe("graph-ready");
      expect(events[0]!.packages!.map((info) => info.name).sort()).toEqual([...built].sort());
      expect(events.at(-1)!.event).toBe("workspace-ready");
      expect(events.at(-1)!.inputHash).toBe(events[0]!.inputHash);
      expect(events.filter((event) => event.event === "node-ready")).toHaveLength(3);
      // Reuse the same production keys in another run, but publish fresh receipts
      // only after the cache has restored missing checkout outputs.
      await rm(join(root, "packages/contracts/dist"), { recursive: true });
      vi.stubEnv("READABLE_BUILD_RUN_ID", "selected-2");
      const rebuild = vi.fn(async () => { throw new Error("cache should satisfy the selected closure"); });
      await ensureWorkspacePackageBuilds(config, rebuild, { packages: ["@readable-studio/daemon"] });
      expect(rebuild).not.toHaveBeenCalled();
      const restored = (await readEvents()).find((event) =>
        event.runId === "selected-2" && event.node === "@readable-studio/contracts")!;
      const receipt = JSON.parse(await readFile(restored.receipt!, "utf8")) as BuildReceipt;
      expect(receipt.runId).toBe("selected-2");
      expect(restored.inputHash).toBe(events.find((event) => event.node === "@readable-studio/contracts")!.inputHash);
      expect(await readFile(join(receipt.outputRoot, receipt.files[0]!.path), "utf8")).toBe("built");
    } finally { releaseDependency.resolve(); await rm(root, { recursive: true, force: true }); }
  });

  it("emits failure without workspace readiness and never starts a failed dependency's consumer", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-failed-ready-"));
    try {
      await writeWorkspace(root);
      await writeFile(join(root, "apps/daemon/package.json"), JSON.stringify({
        dependencies: { "@readable-studio/contracts": "workspace:*" },
      }));
      const eventsPath = join(root, "events.jsonl");
      vi.stubEnv("READABLE_BUILD_EVENTS", eventsPath);
      vi.stubEnv("READABLE_BUILD_RUN_ID", "failure");
      const build = vi.fn(async () => { throw new Error("builder failed"); });
      await expect(ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), build, {
        packages: ["@readable-studio/daemon"],
      })).rejects.toThrow("builder failed");
      expect(build).toHaveBeenCalledTimes(1);
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as BuildEvent);
      expect(events.map((event) => event.event)).toEqual(["graph-ready", "failed", "failed"]);
      expect(events[1]).toMatchObject({ node: "@readable-studio/contracts", error: "builder failed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not create event artifacts when READABLE_BUILD_EVENTS is unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-no-ready-"));
    try {
      await writeWorkspace(root);
      vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
      vi.stubEnv("READABLE_BUILD_RUN_ID", "unused");
      await ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), async (info) => {
        await writePackageOutputs(root, info.directory, "built");
      }, { packages: ["@readable-studio/contracts"] });
      expect((await readdir(root)).sort()).toEqual([".cache", "apps", "package.json", "packages", "pnpm-lock.yaml"].sort());
      expect(await readdir(join(root, "packages/contracts"))).not.toContain("events.jsonl");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects unknown selections before starting a producer", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-unknown-package-"));
    try {
      await writeWorkspace(root);
      const build = vi.fn();
      await expect(ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), build, {
        packages: ["@readable-studio/not-a-package"],
      })).rejects.toThrow("unknown workspace build package");
      expect(build).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("starts dependency-ready daemon work while web is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-package-ready-"));
    const events = new EventEmitter();
    const webStarted = once(events, "web", { signal: AbortSignal.timeout(10_000) });
    const daemonStarted = once(events, "daemon", { signal: AbortSignal.timeout(10_000) });
    const releaseWeb = Promise.withResolvers<void>();
    let contractReady = false;
    let active = 0;
    let peak = 0;
    try {
      await writeWorkspace(root);
      for (const app of ["daemon", "web"]) await writeFile(join(root, "apps", app, "package.json"), JSON.stringify({
        dependencies: { "@readable-studio/contracts": "workspace:*" },
      }));
      const work = ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), async (info) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (info.name === "@readable-studio/contracts") contractReady = true;
          if (info.name === "@readable-studio/web") { expect(contractReady).toBe(true); events.emit("web"); await releaseWeb.promise; }
          if (info.name === "@readable-studio/daemon") { expect(contractReady).toBe(true); events.emit("daemon"); }
          await writePackageOutputs(root, info.directory, "bytes");
        } finally { active -= 1; }
      });
      try { await Promise.all([webStarted, daemonStarted]); }
      finally { releaseWeb.resolve(); await work; }
      expect(peak).toBe(2);
    } finally { releaseWeb.resolve(); await rm(root, { recursive: true, force: true }); }
  });

  it("keys web environment separately and ignores profiler changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-package-env-"));
    const builds: Record<string, number> = {};
    const config = createConfig(root, join(root, ".cache"));
    const build = async (info: { directory: string; name: string }) => {
      builds[info.name] = (builds[info.name] ?? 0) + 1;
      await writePackageOutputs(root, info.directory, "bytes");
    };
    try {
      await writeWorkspace(root);
      await ensureWorkspacePackageBuilds(config, build);
      vi.stubEnv("READABLE_WEB_BROWSER_SOURCE_MAPS", "1");
      await ensureWorkspacePackageBuilds(config, build);
      expect(builds["@readable-studio/web"]).toBe(2);
      expect(builds["@readable-studio/daemon"]).toBe(1);
      vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await ensureWorkspacePackageBuilds(config, build);
      expect(builds["@readable-studio/web"]).toBe(2);
      await writeFile(join(root, "pnpm-lock.yaml"), "changed dependency lock");
      await ensureWorkspacePackageBuilds(config, build);
      expect(Object.values(builds).every((count) => count >= 2)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("drains independent package producers before reporting failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-package-drain-"));
    const events = new EventEmitter();
    const webStarted = once(events, "web", { signal: AbortSignal.timeout(10_000) });
    const { port1, port2 } = new MessageChannel();
    const webCompleted = once(port1, "message", { signal: AbortSignal.timeout(10_000) });
    const failure = new Error("daemon build failed");
    let webFinished = false;
    try {
      await writeWorkspace(root);
      const work = ensureWorkspacePackageBuilds(createConfig(root, join(root, ".cache")), async (info) => {
        if (info.name === "@readable-studio/web") { events.emit("web"); await webCompleted; webFinished = true; }
        if (info.name === "@readable-studio/daemon") { await webStarted; throw failure; }
        await writePackageOutputs(root, info.directory, "bytes");
      });
      const outcome = work.then(() => ({ error: undefined, webFinished }), (error: unknown) => ({ error, webFinished }));
      try {
        await webStarted;
        // Deliver completion in a later event-loop turn, after rejection reactions.
        port2.postMessage("complete");
        expect(await outcome).toEqual({ error: failure, webFinished: true });
      } finally { port2.postMessage("complete"); await outcome; await webCompleted; }
    } finally { port1.close(); port2.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("reuses unchanged Next bytes on daemon edits, propagates dependency changes and restores missing Next output", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-package-build-cache-"));
    const config = createConfig(root, join(root, ".cache"));
    const builds: Record<string, number> = {};
    const build = async (packageInfo: { directory: string; name: string }) => {
      builds[packageInfo.name] = (builds[packageInfo.name] ?? 0) + 1;
      await writePackageOutputs(root, packageInfo.directory, `${packageInfo.name}:${builds[packageInfo.name]}`);
    };
    try {
      await writeWorkspace(root);
      for (const app of ["daemon", "web"]) {
        await writeFile(join(root, "apps", app, "package.json"), JSON.stringify({
          name: `@readable-studio/${app}`, dependencies: { "@readable-studio/contracts": "workspace:*" }, scripts: { build: "fixture-build" },
        }));
      }
      await ensureWorkspacePackageBuilds(config, build);
      const next = join(root, "apps/web/.next/static/chunk.js");
      const originalNext = await readFile(next);
      await writeFile(join(root, "apps/daemon/src/index.ts"), "changed daemon");
      await ensureWorkspacePackageBuilds(config, build);
      expect(builds["@readable-studio/daemon"]).toBe(2);
      expect(builds["@readable-studio/web"]).toBe(1);
      expect(await readFile(next)).toEqual(originalNext);
      await rm(join(root, "apps/web/.next/standalone/apps/web/server.js"));
      await ensureWorkspacePackageBuilds(config, build);
      expect(builds["@readable-studio/web"]).toBe(1);
      expect(await readFile(join(root, "apps/web/.next/standalone/apps/web/server.js"), "utf8")).toBe("@readable-studio/web:1");
      await writeFile(join(root, "packages/contracts/src/index.ts"), "changed dependency");
      await ensureWorkspacePackageBuilds(config, build);
      expect(builds["@readable-studio/contracts"]).toBe(2);
      expect(builds["@readable-studio/daemon"]).toBe(3);
      expect(builds["@readable-studio/web"]).toBe(2);
      expect(builds["@readable-studio/html-edit"]).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("workspace preparation entry point", () => {
  it("requires explicit packages, event destination and run identity", async () => {
    const { prepareWorkspace } = await import("../scripts/workspace-prepare.js");
    await expect(prepareWorkspace([])).rejects.toThrow();
    await expect(prepareWorkspace(["--packages", "@readable-studio/contracts"])).rejects.toThrow();
    await expect(prepareWorkspace(["--packages", ",", "--events", "events.jsonl", "--run-id", "run"])).rejects.toThrow();
  });
});

// Real cache I/O (inventory, seal, publish) is load-dependent; 60s only bounds a genuine hang.
describe("ensureWorkspaceBuildArtifacts", { timeout: 60_000 }, () => {
  it("builds once and skips when the key and outputs are still valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-workspace-build-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config = createConfig(root, cache.root);
    let builds = 0;

    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });

      expect(builds).toBe(1);
      expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "hit"]);
      // The miss snapshot came from these validated outputs: never copy it back.
      expect(cache.report().entries[0]!.materialized.every((target) => target.skipped === true)).toBe(true);
      expect(cache.report().entries.map((entry) => entry.nodeId)).toEqual([
        "win.workspace-build",
        "win.workspace-build",
      ]);
      expect(await readFile(join(root, "apps/packaged/dist/index.mjs"), "utf8")).toBe("build-1\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["src/index.ts", "tests/cache.test.ts", "README.md"])("invalidates all workspace outputs when package %s changes", async (changedPath) => {
    // Given a populated cache for a workspace
    const root = await mkdtemp(join(tmpdir(), "readable-workspace-key-input-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config = createConfig(root, cache.root);
    let builds = 0;
    const build = async () => { builds += 1; await writeOutputs(root, String(builds)); };
    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, build);
      const input = join(root, "packages/contracts", changedPath);
      await mkdir(join(input, ".."), { recursive: true });
      await writeFile(input, "changed input\n");
      // When the workspace is requested after one package input changes
      await ensureWorkspaceBuildArtifacts(config, cache, build);
      // Then the whole-workspace node misses, including for tests and docs
      expect(builds).toBe(2);
      expect(cache.report().entries.map(({ status }) => status)).toEqual(["miss", "miss"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cache keys and output reuse unchanged when profiling is enabled", async () => {
    // Given an ordinary cached workspace build
    const root = await mkdtemp(join(tmpdir(), "readable-workspace-profile-key-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config = createConfig(root, cache.root);
    let builds = 0;
    const build = async () => { builds += 1; await writeOutputs(root, String(builds)); };
    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, build);
      vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
      const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      // When only instrumentation is enabled
      await ensureWorkspaceBuildArtifacts(config, cache, build);
      // Then the existing key still hits, and profiling emits machine-readable records
      expect(builds).toBe(1);
      expect(cache.report().entries.map(({ status }) => status)).toEqual(["miss", "hit"]);
      const records = output.mock.calls.map(([line]) => JSON.parse(String(line).replace("[tools-pack profile] ", "")));
      expect(records).toContainEqual(expect.objectContaining({ phase: "workspace:cache-key" }));
      expect(records).toContainEqual(expect.objectContaining({ phase: "cache:result", status: "hit" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a Windows version-family alias after a successful build", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-workspace-build-alias-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config: ToolPackConfig = { ...createConfig(root, cache.root), appVersion: "0.9.1-beta.1" };

    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        await writeOutputs(root, "build");
      });

      const aliasesRoot = join(cache.root, "aliases", "win.workspace-build");
      const aliasBuckets = await readdir(aliasesRoot);
      expect(aliasBuckets).toHaveLength(1);
      expect(await readFile(join(aliasesRoot, aliasBuckets[0]!, "alias.json"), "utf8")).toContain("win.workspace-build");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("materializes cached outputs when an expected workspace output is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-workspace-build-stale-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config = createConfig(root, cache.root);
    let builds = 0;

    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });
      await rm(join(root, "apps/web/dist/sidecar/index.js"), { force: true });
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });

      expect(builds).toBe(1);
      expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "hit"]);
      expect(await readFile(join(root, "apps/web/dist/sidecar/index.js"), "utf8")).toBe("build-1\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("materializes cached internal package outputs for pack tarballs", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-workspace-build-package-cache-"));
    const cache = new ToolPackCache(join(root, ".cache"));
    const config = createConfig(root, cache.root);
    let builds = 0;

    try {
      await writeWorkspace(root);
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });
      await rm(join(root, "packages/host/dist/index.mjs"), { force: true });
      await ensureWorkspaceBuildArtifacts(config, cache, async () => {
        builds += 1;
        await writeOutputs(root, `build-${builds}`);
      });

      expect(builds).toBe(1);
      expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "hit"]);
      expect(await readFile(join(root, "packages/host/dist/index.mjs"), "utf8")).toBe("build-1\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

});
