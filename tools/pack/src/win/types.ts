import type { DesktopEvalResult, DesktopScreenshotResult, DesktopStatusSnapshot } from "@readable-studio/sidecar-proto";
import type { CacheReport } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import type { INTERNAL_PACKAGES } from "./constants.js";

export type PackedTarballInfo = {
  fileName: string;
  packageName: (typeof INTERNAL_PACKAGES)[number]["name"];
};

export type PackedTarballsCacheMetadata = {
  tarballs: PackedTarballInfo[];
};

export type PackedTarballsCacheResult = PackedTarballsCacheMetadata & {
  key: string;
};

export type PackagedAppCacheMetadata = {
  packagedVersion: string;
};

export type PackagedAppCacheResult = PackagedAppCacheMetadata & {
  appRoot: string;
  key: string;
};

export type ElectronBuilderDirCacheMetadata = {
  packagedAppKey: string;
  packagedVersion: string;
};

export type ResourceTreeCacheMetadata = {
  resourceName: "readable-studio";
};

export type WinBuiltAppManifest = {
  appBuilderOutputRoot: string;
  cacheEntryPath: string | null;
  configPath: string;
  executablePath: string;
  source: "cache" | "namespace";
  unpackedRoot: string;
  version: 1;
  webStandaloneHookAuditPath: string | null;
};

export type WinPaths = {
  appBuilderConfigPath: string;
  appBuilderOutputRoot: string;
  assembledAppRoot: string;
  assembledMainEntryPath: string;
  assembledPackageJsonPath: string;
  assembledPrebundledRoot: string;
  builtManifestPath: string;
  daemonCliPrebundleEntrypointPath: string;
  daemonCliPrebundlePath: string;
  daemonPrebundleMetaPath: string;
  daemonPrebundleRoot: string;
  daemonSidecarPrebundleEntrypointPath: string;
  daemonSidecarPrebundlePath: string;
  packagedConfigPath: string;
  packagedMainPrebundleMetaPath: string;
  packagedMainPrebundlePath: string;
  resourceRoot: string;
  setupZipPath: string;
  tarballsRoot: string;
  webStandaloneHookAuditPath: string;
  webStandaloneHookConfigPath: string;
  webSidecarPrebundleMetaPath: string;
  webSidecarPrebundlePath: string;
  winIconPath: string;
  unpackedExePath: string;
  unpackedRoot: string;
};

export type WinPackResult = {
  outputRoot: string;
  portableZipPath: string | null;
  resourceRoot: string;
  runtimeNamespaceRoot: string;
  cacheReport: CacheReport;
  segments: WinPackTiming[];
  sizeReport: WinSizeReport;
  timings: WinPackTiming[];
  unpackedPath: string | null;
  webStandaloneHookAuditPath: string | null;
};

export type WinPackTiming = {
  details?: Record<string, unknown>;
  durationMs: number;
  phase: string;
};

export type WinSizeReport = {
  builder: {
    asar: boolean;
    buildDependenciesFromSource: boolean;
    filePatterns: readonly string[];
    nativeRebuild: {
      buildFromSource: boolean;
      mode: "parallel" | "sequential";
      modules: readonly string[];
    };
    nodeGypRebuild: boolean;
    npmRebuild: boolean;
    targets: ["zip"];
    webOutputMode: ToolPackConfig["webOutputMode"];
  };
  generatedAt: string;
  mode: "fast" | "detailed";
  outputRootBytes: number;
  portableZipBytes: number | null;
  resourceRootBytes: number;
  runtimeNamespaceRoot: string;
  topLevel: {
    appResourcesBytes: number;
    copiedStandaloneBytes: number;
    electronLocalesBytes: number;
    resourcesBytes: number;
  };
  tracked: {
    appNodeModulesBytes: number;
    betterSqlite3Bytes: number;
    betterSqlite3SourceResidueBytes: number;
    bundledNodeBytes: number;
    copiedStandaloneNextBytes: number;
    copiedStandaloneNextSwcBytes: number;
    copiedStandaloneNodeModulesBytes: number;
    copiedStandalonePnpmHoistedNextBytes: number;
    copiedStandaloneSharpLibvipsBytes: number;
    copiedStandaloneSourcemapBytes: number;
    copiedStandaloneTsbuildInfoBytes: number;
    copiedStandaloneWebNextBytes: number;
    copiedStandaloneWebNodeModulesBytes: number;
    electronLocalesBytes: number;
    markdownBytes: number;
    nextBytes: number;
    nextSwcBytes: number;
    prebundledRuntimeBytes: number;
    sharpLibvipsBytes: number;
    sourcemapBytes: number;
    tsbuildInfoBytes: number;
    webCopiedStandaloneBytes: number;
    webNextCacheBytes: number;
    webPackageAppBytes: number;
    webPackageBytes: number;
    webPackageDistBytes: number;
    webPackagePublicBytes: number;
    webPackageSrcBytes: number;
    webPackageStandaloneBytes: number;
  };
  unpackedBytes: number | null;
};

export type WinStartResult = {
  executablePath: string;
  logPath: string;
  namespace: string;
  pid: number;
  source: "built";
  status: DesktopStatusSnapshot | null;
};

export type WinStopResult = {
  gracefulRequested: boolean;
  namespace: string;
  remainingPids: number[];
  status: "not-running" | "partial" | "stopped";
  stoppedPids: number[];
};

export type WinCleanupResult = {
  namespace: string;
  removedOutputRoot: boolean;
  removedRuntimeNamespaceRoot: boolean;
  stop: WinStopResult;
};

export type WinInspectResult = {
  eval?: DesktopEvalResult;
  screenshot?: DesktopScreenshotResult;
  status: DesktopStatusSnapshot | null;
};
