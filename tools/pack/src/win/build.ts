import { join } from "node:path";

import { ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import {
  collectWorkspaceTarballs,
  createWinPackagedAppCacheKey,
  ensureWinWorkspaceBuild,
  prepareWinPackagedApp,
} from "./app.js";
import { runElectronBuilder } from "./builder.js";
import { readBuiltAppManifest } from "./manifest.js";
import { resolveWinPaths } from "./paths.js";
import {
  collectWinSizeReport,
} from "./report.js";
import { copyWinIcon, prepareResourceTree } from "./resources.js";
import type { WinPackResult, WinPackTiming, WinPaths } from "./types.js";

function logWinBuildProgress(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`[tools-pack win] ${message}${suffix.length === 0 ? "" : ` ${suffix}`}\n`);
}

export async function packWin(config: ToolPackConfig): Promise<WinPackResult> {
  const paths = resolveWinPaths(config);
  const cache = new ToolPackCache(config.roots.cacheRoot);
  const timings: WinPackTiming[] = [];
  const segments: WinPackTiming[] = [];
  const runPhase = async <T>(phase: string, task: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    logWinBuildProgress("phase:start", { phase });
    try {
      const result = await task();
      logWinBuildProgress("phase:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinBuildProgress("phase:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      throw error;
    } finally {
      timings.push({ durationMs: Date.now() - startedAt, phase });
    }
  };

  await runPhase("workspace-build", async () => {
    await ensureWinWorkspaceBuild(config, cache);
  });
  const resourceTree = await runPhase("resource-tree", async () =>
    prepareResourceTree(config, paths, cache, { materialize: false })
  );
  await runPhase("win-icon", async () => {
    await copyWinIcon(paths);
  });
  const tarballs = await runPhase("workspace-tarballs", async () => collectWorkspaceTarballs(config, paths, cache));
  const packagedAppKey = await createWinPackagedAppCacheKey(config, tarballs.key, tarballs.tarballs);
  const packagedApp = await runPhase("packaged-app", async () =>
    prepareWinPackagedApp(config, paths, tarballs, cache)
  );
  await runPhase("electron-builder", async () => {
    const builderSegments = await runElectronBuilder(
      config,
      paths,
      cache,
      packagedAppKey,
      packagedApp.appRoot,
      resourceTree,
    );
    segments.push(...builderSegments);
  });
  const builtApp = await readBuiltAppManifest(paths);
  const sizeReport = await runPhase("size-report", async () =>
    collectWinSizeReport(config, paths, builtApp),
  );

  return {
    outputRoot: config.roots.output.namespaceRoot,
    portableZipPath: paths.setupZipPath,
    resourceRoot: builtApp == null ? paths.resourceRoot : join(builtApp.unpackedRoot, "resources", "readable-studio"),
    runtimeNamespaceRoot: config.roots.runtime.namespaceRoot,
    cacheReport: cache.report(),
    segments,
    sizeReport,
    timings,
    unpackedPath: builtApp?.unpackedRoot ?? paths.unpackedRoot,
    webStandaloneHookAuditPath: builtApp?.webStandaloneHookAuditPath ?? null,
  };
}
