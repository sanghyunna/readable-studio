import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { PathSizeIndex } from "../src/win/fs.js";
import { collectWinSizeReport } from "../src/win/report.js";
import type { WinBuiltAppManifest, WinPaths } from "../src/win/types.js";

function createPaths(root: string): WinPaths {
  const namespaceRoot = join(root, "namespaces", "second");
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", "prebundled"),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-cli.mjs"),
    daemonPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", "prebundled", "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-sidecar.mjs"),
    packagedConfigPath: join(namespaceRoot, "readable-studio-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "packaged-main.mjs"),
    resourceRoot: join(namespaceRoot, "resources", "readable-studio"),
    setupZipPath: join(namespaceRoot, "builder", "Readable Studio-second-portable.zip"),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "web-sidecar.mjs"),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", "win-unpacked", "Readable Studio.exe"),
    unpackedRoot: join(namespaceRoot, "builder", "win-unpacked"),
  };
}

function createConfig(root: string): ToolPackConfig {
  return {
    electronBuilderCliPath: "electron-builder",
    electronDistPath: "electron-dist",
    electronVersion: "41.0.0",
    namespace: "second",
    platform: "win",
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      cacheRoot: join(root, "cache"),
      output: {
        appBuilderRoot: join(root, "namespaces", "second", "builder"),
        namespaceRoot: join(root, "namespaces", "second"),
        platformRoot: join(root, "namespaces"),
        root: join(root),
      },
      runtime: {
        namespaceBaseRoot: join(root, "runtime", "win", "namespaces"),
        namespaceRoot: join(root, "runtime", "win", "namespaces", "second"),
      },
      toolPackRoot: root,
    },
    silent: true,
    signed: false,
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

function createBuiltApp(paths: WinPaths): WinBuiltAppManifest {
  return {
    appBuilderOutputRoot: paths.appBuilderOutputRoot,
    cacheEntryPath: null,
    configPath: paths.packagedConfigPath,
    executablePath: paths.unpackedExePath,
    source: "namespace",
    unpackedRoot: paths.unpackedRoot,
    version: 1,
    webStandaloneHookAuditPath: null,
  };
}

describe("PathSizeIndex", () => {
  it("indexes directory sizes and filtered file totals in a single tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-size-index-"));

    try {
      await mkdir(join(root, "app", "node_modules", "@next", "swc-win32-x64"), { recursive: true });
      await mkdir(join(root, "app", "node_modules", "@next", "swc-linux-x64"), { recursive: true });
      await writeFile(join(root, "app", "main.js"), "main\n", "utf8");
      await writeFile(join(root, "app", "main.js.map"), "map-data\n", "utf8");
      await writeFile(join(root, "app", "node_modules", "@next", "swc-win32-x64", "next-swc.node"), "win-swc\n", "utf8");
      await writeFile(join(root, "app", "node_modules", "@next", "swc-linux-x64", "next-swc.node"), "linux-swc\n", "utf8");

      const index = await PathSizeIndex.create(root);

      expect(index.sizePathBytes(join(root, "missing"))).toBe(0);
      expect(index.sizePathBytes(join(root, "app", "main.js"))).toBe(Buffer.byteLength("main\n"));
      expect(index.sizePathBytes(join(root, "app"), { includeFile: (path) => path.endsWith(".map") })).toBe(
        Buffer.byteLength("map-data\n"),
      );
      expect(index.sumChildDirectorySizes(join(root, "app", "node_modules", "@next"), (name) => name.startsWith("swc-win32-"))).toBe(
        Buffer.byteLength("win-swc\n"),
      );
      expect(index.sizePathBytes(root)).toBe(
        Buffer.byteLength("main\n") +
          Buffer.byteLength("map-data\n") +
          Buffer.byteLength("win-swc\n") +
          Buffer.byteLength("linux-swc\n"),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("collectWinSizeReport", () => {
  it("skips tree indexing for the fast portable zip report and keeps detailed mode requestable", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-size-report-"));
    const paths = createPaths(root);
    const config = createConfig(root);
    const builtApp = createBuiltApp(paths);
    const portableZipBytes = Buffer.byteLength("portable zip bytes\n");

    try {
      await mkdir(join(paths.setupZipPath, ".."), { recursive: true });
      await writeFile(paths.setupZipPath, "portable zip bytes\n", "utf8");
      await mkdir(join(paths.unpackedRoot, "resources", "app", "node_modules", "better-sqlite3"), { recursive: true });
      await mkdir(join(paths.unpackedRoot, "resources", "readable-studio"), { recursive: true });
      await mkdir(join(paths.unpackedRoot, "locales"), { recursive: true });
      await mkdir(join(config.roots.output.namespaceRoot, "marker"), { recursive: true });
      await writeFile(join(paths.unpackedRoot, "resources", "app", "node_modules", "better-sqlite3", "addon.node"), "sqlite\n", "utf8");
      await writeFile(join(paths.unpackedRoot, "resources", "readable-studio", "asset.txt"), "asset\n", "utf8");
      await writeFile(join(paths.unpackedRoot, "locales", "en.pak"), "locale\n", "utf8");
      await writeFile(join(config.roots.output.namespaceRoot, "marker", "file.txt"), "output\n", "utf8");

      const fastSpy = vi.spyOn(PathSizeIndex, "create");
      const fastReport = await collectWinSizeReport(config, paths, builtApp, { detailed: false });

      expect(fastSpy).not.toHaveBeenCalled();
      expect(fastReport.mode).toBe("fast");
      expect(fastReport.portableZipBytes).toBe(portableZipBytes);
      expect(fastReport.outputRootBytes).toBe(0);
      expect(fastReport.tracked.betterSqlite3Bytes).toBe(0);

      fastSpy.mockRestore();

      const detailedSpy = vi.spyOn(PathSizeIndex, "create");
      const detailedReport = await collectWinSizeReport(config, paths, builtApp, { detailed: true });

      expect(detailedSpy).toHaveBeenCalledTimes(2);
      expect(detailedReport.mode).toBe("detailed");
      expect(detailedReport.portableZipBytes).toBe(portableZipBytes);
      expect(detailedReport.outputRootBytes).toBeGreaterThan(0);
      expect(detailedReport.tracked.betterSqlite3Bytes).toBe(Buffer.byteLength("sqlite\n"));
      expect(detailedReport.resourceRootBytes).toBe(Buffer.byteLength("asset\n"));

      detailedSpy.mockRestore();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
