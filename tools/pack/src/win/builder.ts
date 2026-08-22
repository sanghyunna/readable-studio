import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { RUNTIME_APP_ID } from "@readable-studio/sidecar-proto";

import { hashJson, hashPath, type CacheNode, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { winResources } from "../resources.js";
import { electronBuilderVersionForAppVersion, versionCoreForAppVersion } from "../versions.js";
import {
  WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
  shouldUseWinStandalonePrebundle,
} from "../win-prebundle.js";
import {
  ELECTRON_BUILDER_ASAR,
  ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
  ELECTRON_BUILDER_FILE_PATTERNS,
  ELECTRON_BUILDER_NODE_GYP_REBUILD,
  ELECTRON_BUILDER_NPM_REBUILD,
  PRODUCT_NAME,
  WEB_STANDALONE_HOOK_CONFIG_ENV,
  WEB_STANDALONE_RESOURCE_NAME,
} from "./constants.js";
import { pathExists, removeTree } from "./fs.js";
import {
  readPackagedVersion,
  writeBuiltAppManifest,
  writePackagedConfig,
} from "./manifest.js";
import { sanitizeNamespace } from "./paths.js";
import type { ResourceTreeResult } from "./resources.js";
import {
  resolveWinSigningCacheKey,
  signAndVerifyWinFile,
} from "./sign.js";
import {
  readWinExecutableVersionSnapshot,
  resolveWinExecutableVersionTargets,
  rewriteWinExecutableVersion,
} from "./version-resource.js";
import {
  buildWinPortableZip,
  resolvePortableZipCompression,
} from "./zip.js";
import type {
  ElectronBuilderDirCacheMetadata,
  WinBuiltAppManifest,
  WinPackTiming,
  WinPaths,
} from "./types.js";

const execFileAsync = promisify(execFile);
const WIN_ARCHIVE_CACHE_VERSION = 3;
const WIN_ELECTRON_BUILDER_DIR_CACHE_VERSION = 8;
// The portable ZIP cache key embeds the packaged config and
// the electron-builder dir key (see buildWinPortableZipCacheKeyInput), so
// input-driven changes — resource tree, baked config fields, version — re-key
// automatically; this constant covers logic changes whose output happens to be
// byte-identical for the current config.
const WIN_PORTABLE_ZIP_CACHE_VERSION = 6;

// Pure key-input assembly for the portable-zip cache node, exported for tests.
// The zip's true inputs are the materialized unpacked tree and the exact
// packaged config text. packagedAppKey and
// packagedVersion alone cannot see resource-tree changes (those ride the
// electron-builder dir key via resourceTreeKey) or baked-config-only changes
// (telemetry and profile fields), so the key carries the dir
// key and config text directly — a cache hit can only ever
// serve a zip whose bytes match what this invocation would produce.
export function buildWinPortableZipCacheKeyInput(input: {
  electronBuilderDirKey: string;
  packagedConfig: string;
  portableZipCompression: number;
  namespace: string;
  packagedAppKey: string;
  packagedVersion: string;
  signing: unknown;
}): Record<string, unknown> {
  return {
    archiveCacheVersion: WIN_ARCHIVE_CACHE_VERSION,
    electronBuilderDirKey: input.electronBuilderDirKey,
    packagedConfig: input.packagedConfig,
    namespace: input.namespace,
    packagedAppKey: input.packagedAppKey,
    packagedVersion: input.packagedVersion,
    portableZipCompression: input.portableZipCompression,
    portableZipCacheVersion: WIN_PORTABLE_ZIP_CACHE_VERSION,
    signing: input.signing,
    target: "portable-zip",
  };
}

function isPortableZipCacheHitEligible(config: ToolPackConfig): boolean {
  return !config.signed;
}

function createWinPortableZipNode(input: {
  build: (context: { entryRoot: string }) => Promise<{ createdAt: string; portableZipPath: string }>;
  electronBuilderDirKey: string;
  packagedConfig: string;
  namespace: string;
  packagedAppKey: string;
  packagedVersion: string;
  portableZipCompression: number;
  signingCacheKey: unknown;
}): CacheNode<{ createdAt: string; portableZipPath: string }> {
  return {
    build: input.build,
    id: "win.portable-zip",
    invalidate: async () => null,
    key: hashJson(
      buildWinPortableZipCacheKeyInput({
        electronBuilderDirKey: input.electronBuilderDirKey,
        packagedConfig: input.packagedConfig,
        namespace: input.namespace,
        packagedAppKey: input.packagedAppKey,
        packagedVersion: input.packagedVersion,
        portableZipCompression: input.portableZipCompression,
        signing: input.signingCacheKey,
      }),
    ),
    outputs: ["portable.zip"],
  };
}

function logWinBuildProgress(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`[tools-pack win] ${message}${suffix.length === 0 ? "" : ` ${suffix}`}\n`);
}

async function assertWebStandaloneOutput(config: ToolPackConfig): Promise<void> {
  const webRoot = join(config.workspaceRoot, "apps", "web");
  const standaloneSourceRoot = join(webRoot, ".next", "standalone");
  const candidates = [
    join(standaloneSourceRoot, "apps", "web", "server.js"),
    join(standaloneSourceRoot, "server.js"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return;
  }

  throw new Error("Next.js standalone server output was not produced under apps/web/.next/standalone");
}

async function writeWebStandaloneHookConfig(config: ToolPackConfig, paths: WinPaths): Promise<string> {
  const webRoot = join(config.workspaceRoot, "apps", "web");
  await assertWebStandaloneOutput(config);

  await mkdir(dirname(paths.webStandaloneHookConfigPath), { recursive: true });
  await writeFile(
    paths.webStandaloneHookConfigPath,
    `${JSON.stringify(
      {
        auditReportPath: paths.webStandaloneHookAuditPath,
        pruneCopiedSharp: true,
        pruneRootNext: true,
        pruneRootSharp: true,
        requireRootWebPackageAudit: !shouldUseWinStandalonePrebundle(config.webOutputMode),
        resourceName: WEB_STANDALONE_RESOURCE_NAME,
        standaloneSourceRoot: join(webRoot, ".next", "standalone"),
        version: 1,
        webPublicSourceRoot: join(webRoot, "public"),
        webStaticSourceRoot: join(webRoot, ".next", "static"),
        workspaceRoot: config.workspaceRoot,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return paths.webStandaloneHookConfigPath;
}

async function runElectronBuilderRaw(
  config: ToolPackConfig,
  paths: WinPaths,
  projectDir: string,
): Promise<WinPackTiming[]> {
  const segments: WinPackTiming[] = [];
  const runSegment = async <T>(
    phase: string,
    task: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const startedAt = Date.now();
    logWinBuildProgress("segment:start", { phase });
    try {
      const result = await task();
      logWinBuildProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinBuildProgress("segment:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      throw error;
    } finally {
      segments.push({ details, durationMs: Date.now() - startedAt, phase });
    }
  };

  const namespaceToken = sanitizeNamespace(config.namespace);
  const packagedVersion = await runSegment("electron-builder-raw:read-packaged-version", async () =>
    readPackagedVersion(config)
  );
  const packageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  const webStandaloneHookConfigPath = config.webOutputMode === "standalone"
    ? await runSegment("electron-builder-raw:write-web-standalone-hook-config", async () =>
      writeWebStandaloneHookConfig(config, paths)
    )
    : null;
  const builderConfig = {
    appId: RUNTIME_APP_ID,
    afterPack: webStandaloneHookConfigPath == null ? undefined : winResources.webStandaloneAfterPackHook,
    asar: ELECTRON_BUILDER_ASAR,
    buildDependenciesFromSource: ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
    compression: "maximum",
    directories: { output: paths.appBuilderOutputRoot },
    // Let electron-builder download the win32 Electron itself instead of
    // pointing at node_modules' dist. pnpm does not reliably materialize the
    // Electron dist on CI runners (electron.exe can be missing), which made
    // the rename to `${PRODUCT_NAME}.exe` fail with ENOENT. The mac builder
    // already relies on electron-builder's own download and is the only
    // platform that stayed green through this regression.
    electronVersion: config.electronVersion,
    executableName: PRODUCT_NAME,
    extraMetadata: {
      main: "./main.cjs",
      name: "readable-studio-packaged-app",
      productName: PRODUCT_NAME,
      version: packageVersion,
    },
    extraResources: [
      { from: paths.resourceRoot, to: "readable-studio" },
      { from: paths.packagedConfigPath, to: "readable-studio-config.json" },
    ],
    files: [...ELECTRON_BUILDER_FILE_PATTERNS],
    forceCodeSigning: false,
    icon: paths.winIconPath,
    nodeGypRebuild: ELECTRON_BUILDER_NODE_GYP_REBUILD,
    npmRebuild: ELECTRON_BUILDER_NPM_REBUILD,
    productName: PRODUCT_NAME,
    win: {
      artifactName: `${PRODUCT_NAME}-${namespaceToken}.\${ext}`,
      icon: paths.winIconPath,
      target: [{ arch: ["x64"], target: "dir" }],
    },
  };

  await runSegment("electron-builder-raw:prepare-config", async () => {
    await removeTree(paths.appBuilderOutputRoot);
    await mkdir(dirname(paths.appBuilderConfigPath), { recursive: true });
    await writeFile(paths.appBuilderConfigPath, `${JSON.stringify(builderConfig, null, 2)}\n`, "utf8");
  });

  const build = async (phase: string) => {
    await runSegment(phase, async () => {
      await execFileAsync(process.execPath, [
        config.electronBuilderCliPath,
        "--win",
        "--projectDir",
        projectDir,
        "--config",
        paths.appBuilderConfigPath,
        "--publish",
        "never",
      ], {
        cwd: config.workspaceRoot,
        env: {
          ...process.env,
          CSC_IDENTITY_AUTO_DISCOVERY: "false",
          ...(webStandaloneHookConfigPath == null ? {} : { [WEB_STANDALONE_HOOK_CONFIG_ENV]: webStandaloneHookConfigPath }),
        },
      });
    }, {
      electronBuilderCliPath: config.electronBuilderCliPath,
      projectDir,
      webOutputMode: config.webOutputMode,
    });
  };

  await build("electron-builder-raw:process");
  return segments;
}

function createCacheLocalWinPaths(paths: WinPaths, entryRoot: string): WinPaths {
  return {
    ...paths,
    appBuilderConfigPath: join(entryRoot, "builder-config.json"),
    appBuilderOutputRoot: join(entryRoot, "builder"),
    webStandaloneHookAuditPath: join(entryRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(entryRoot, "web-standalone-after-pack-config.json"),
  };
}

function rewriteAuditPaths(value: unknown, fromRoot: string, toRoot: string): unknown {
  if (typeof value === "string") return value.split(fromRoot).join(toRoot);
  if (Array.isArray(value)) return value.map((entry) => rewriteAuditPaths(entry, fromRoot, toRoot));
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewriteAuditPaths(entry, fromRoot, toRoot)]),
  );
}

async function materializeCachedElectronBuilderAudit(entryRoot: string, paths: WinPaths): Promise<void> {
  if (!(await pathExists(join(entryRoot, "web-standalone-after-pack-audit.json")))) return;
  const raw = JSON.parse(await readFile(join(entryRoot, "web-standalone-after-pack-audit.json"), "utf8")) as unknown;
  const appPath = typeof (raw as { appPath?: unknown }).appPath === "string"
    ? (raw as { appPath: string }).appPath
    : null;
  const sourceBuilderRoot = appPath == null ? join(entryRoot, "builder") : dirname(appPath);
  await mkdir(dirname(paths.webStandaloneHookAuditPath), { recursive: true });
  await writeFile(
    paths.webStandaloneHookAuditPath,
    `${JSON.stringify(rewriteAuditPaths(raw, sourceBuilderRoot, paths.appBuilderOutputRoot), null, 2)}\n`,
    "utf8",
  );
}

async function rewriteUnpackedAppPackageVersion(unpackedRoot: string, packagedVersion: string): Promise<void> {
  const packageJsonPath = join(unpackedRoot, "resources", "app", "package.json");
  if (!(await pathExists(packageJsonPath))) return;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  packageJson.version = electronBuilderVersionForAppVersion(packagedVersion);
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function assertMaterializedUnpackedVersionConsistency(
  unpackedRoot: string,
  packagedVersion: string,
): Promise<void> {
  const packageJsonPath = join(unpackedRoot, "resources", "app", "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };
  const expectedPackageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  if (packageJson.version !== expectedPackageVersion) {
    throw new Error(
      `expected packaged app version ${JSON.stringify(expectedPackageVersion)} in ${packageJsonPath}, received ${JSON.stringify(packageJson.version)}`,
    );
  }

  const packagedConfigPath = join(unpackedRoot, "resources", "readable-studio-config.json");
  const packagedConfig = JSON.parse(await readFile(packagedConfigPath, "utf8")) as { appVersion?: unknown };
  if (packagedConfig.appVersion !== packagedVersion) {
    throw new Error(
      `expected packaged config version ${JSON.stringify(packagedVersion)} in ${packagedConfigPath}, received ${JSON.stringify(packagedConfig.appVersion)}`,
    );
  }

  const executablePath = join(unpackedRoot, `${PRODUCT_NAME}.exe`);
  const executableVersionTargets = resolveWinExecutableVersionTargets(packagedVersion);
  const executableVersion = await readWinExecutableVersionSnapshot(executablePath);
  if (executableVersion.machine !== "x64") {
    throw new Error(`expected unpacked executable to target Windows x64 in ${executablePath}`);
  }
  if (executableVersion.fixedFileVersion !== executableVersionTargets.numericVersion) {
    throw new Error(
      `expected unpacked executable fixed FileVersion ${executableVersionTargets.numericVersion} in ${executablePath}, received ${executableVersion.fixedFileVersion}`,
    );
  }
  if (executableVersion.fixedProductVersion !== executableVersionTargets.productVersion) {
    throw new Error(
      `expected unpacked executable fixed ProductVersion ${executableVersionTargets.productVersion} in ${executablePath}, received ${executableVersion.fixedProductVersion}`,
    );
  }
  for (const stringTable of executableVersion.stringTables) {
    if (stringTable.values.FileVersion !== executableVersionTargets.fileVersion) {
      throw new Error(
        `expected unpacked executable FileVersion string ${JSON.stringify(executableVersionTargets.fileVersion)} in ${executablePath}, received ${JSON.stringify(stringTable.values.FileVersion)}`,
      );
    }
    if (stringTable.values.ProductVersion !== executableVersionTargets.productVersion) {
      throw new Error(
        `expected unpacked executable ProductVersion string ${JSON.stringify(executableVersionTargets.productVersion)} in ${executablePath}, received ${JSON.stringify(stringTable.values.ProductVersion)}`,
      );
    }
  }
}

export async function materializeCachedUnpackedForPortableZip(
  sourceUnpackedRoot: string,
  paths: WinPaths,
  packagedVersion?: string,
): Promise<WinBuiltAppManifest>;
export async function materializeCachedUnpackedForPortableZip(
  paths: WinPaths,
  packagedVersion?: string,
): Promise<WinBuiltAppManifest>;
export async function materializeCachedUnpackedForPortableZip(
  sourceUnpackedRootOrPaths: string | WinPaths,
  pathsOrPackagedVersion?: WinPaths | string,
  maybePackagedVersion?: string,
): Promise<WinBuiltAppManifest> {
  const sourceUnpackedRoot = typeof sourceUnpackedRootOrPaths === "string" ? sourceUnpackedRootOrPaths : null;
  const paths = typeof sourceUnpackedRootOrPaths === "string"
    ? pathsOrPackagedVersion as WinPaths
    : sourceUnpackedRootOrPaths;
  const packagedVersion = typeof sourceUnpackedRootOrPaths === "string"
    ? maybePackagedVersion
    : typeof pathsOrPackagedVersion === "string"
      ? pathsOrPackagedVersion
      : undefined;
  if (sourceUnpackedRoot != null) {
    await removeTree(paths.unpackedRoot);
    await mkdir(dirname(paths.unpackedRoot), { recursive: true });
    await cp(sourceUnpackedRoot, paths.unpackedRoot, { recursive: true });
  }
  await mkdir(join(paths.unpackedRoot, "resources"), { recursive: true });
  await writeFile(
    join(paths.unpackedRoot, "resources", "readable-studio-config.json"),
    await readFile(paths.packagedConfigPath),
  );
  if (packagedVersion != null) {
    await rewriteUnpackedAppPackageVersion(paths.unpackedRoot, packagedVersion);
    await rewriteWinExecutableVersion(paths.unpackedExePath, packagedVersion);
    await assertMaterializedUnpackedVersionConsistency(paths.unpackedRoot, packagedVersion);
  }
  return {
    appBuilderOutputRoot: paths.appBuilderOutputRoot,
    cacheEntryPath: null,
    configPath: paths.packagedConfigPath,
    executablePath: paths.unpackedExePath,
    source: "namespace",
    unpackedRoot: paths.unpackedRoot,
    version: 1,
    webStandaloneHookAuditPath: (await pathExists(paths.webStandaloneHookAuditPath)) ? paths.webStandaloneHookAuditPath : null,
  };
}

export async function runElectronBuilder(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  packagedAppKey: string,
  packagedAppRoot: string,
  resourceTree: ResourceTreeResult,
): Promise<WinPackTiming[]> {
  const segments: WinPackTiming[] = [];
  const runSegment = async <T>(phase: string, task: () => Promise<T>, details?: Record<string, unknown>): Promise<T> => {
    const startedAt = Date.now();
    logWinBuildProgress("segment:start", { phase });
    try {
      const result = await task();
      logWinBuildProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinBuildProgress("segment:failed", { durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), phase });
      throw error;
    } finally {
      segments.push({ details, durationMs: Date.now() - startedAt, phase });
    }
  };
  const packagedVersion = await readPackagedVersion(config);
  const usePrebundle = shouldUseWinStandalonePrebundle(config.webOutputMode);
  const packagedConfigEntrypoints = usePrebundle
    ? { daemonCliEntryRelative: WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH, daemonSidecarEntryRelative: WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH, webSidecarEntryRelative: WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH }
    : {};
  const electronBuilderKeyInput = {
    afterPackHook: config.webOutputMode === "standalone" ? await hashPath(winResources.webStandaloneAfterPackHook) : null,
    asar: ELECTRON_BUILDER_ASAR,
    buildDependenciesFromSource: ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
    cacheVersion: WIN_ELECTRON_BUILDER_DIR_CACHE_VERSION,
    electronBuilderCliPath: config.electronBuilderCliPath,
    electronVersion: config.electronVersion,
    filePatterns: ELECTRON_BUILDER_FILE_PATTERNS,
    nodeGypRebuild: ELECTRON_BUILDER_NODE_GYP_REBUILD,
    npmRebuild: ELECTRON_BUILDER_NPM_REBUILD,
    packagedAppKey,
    packagedConfigSchemaVersion: usePrebundle ? 2 : 1,
    packagedVersionScope: versionCoreForAppVersion(packagedVersion),
    platform: "win32",
    resourceTreeKey: resourceTree.key,
    target: "dir",
    webOutputMode: config.webOutputMode,
    winIcon: await hashPath(winResources.icon),
  };
  const key = hashJson({ ...electronBuilderKeyInput, node: "win.electron-builder-dir" });
  const node = {
    id: "win.electron-builder-dir",
    key,
    outputs: ["builder", ...(config.webOutputMode === "standalone" ? ["web-standalone-after-pack-audit.json"] : [])],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ElectronBuilderDirCacheMetadata> => {
      const rawSegments = await runElectronBuilderRaw(
        config,
        { ...createCacheLocalWinPaths(paths, entryRoot), resourceRoot: resourceTree.resourceRoot },
        packagedAppRoot,
      );
      segments.push(...rawSegments);
      return { packagedAppKey, packagedVersion };
    },
  };
  let manifest = await runSegment("electron-builder-dir:read-hit", async () => cache.readHit({ materialize: [], node }));
  if (manifest == null) manifest = await runSegment("electron-builder-dir:acquire", async () => cache.acquire({ materialize: [], node }));
  const cachedBuilderRoot = join(manifest.entryPath, "builder");
  const cachedUnpackedRoot = join(cachedBuilderRoot, "win-unpacked");
  await runSegment("electron-builder-dir:prepare-namespace", async () => {
    await mkdir(paths.appBuilderOutputRoot, { recursive: true });
    await writePackagedConfig(config, paths, packagedVersion, packagedConfigEntrypoints);
  });
  await runSegment("electron-builder-dir:materialize-audit", async () => materializeCachedElectronBuilderAudit(manifest.entryPath, paths));
  await runSegment("electron-builder-dir:write-manifest", async () => writeBuiltAppManifest(paths, {
    appBuilderOutputRoot: cachedBuilderRoot,
    cacheEntryPath: manifest.entryPath,
    configPath: paths.packagedConfigPath,
    executablePath: join(cachedUnpackedRoot, `${PRODUCT_NAME}.exe`),
    source: "cache",
    unpackedRoot: cachedUnpackedRoot,
    webStandaloneHookAuditPath: (await pathExists(paths.webStandaloneHookAuditPath)) ? paths.webStandaloneHookAuditPath : null,
  }));
  const signingCacheKey = resolveWinSigningCacheKey(config);
  const materialized = await runSegment("portable-zip:materialize-unpacked", async () => {
    const cached = await cache.readHit({
      materialize: [{ from: "builder/win-unpacked", reuse: true, reuseRequiredPaths: [[`resources/${WEB_STANDALONE_RESOURCE_NAME}/apps/web/server.js`, `resources/${WEB_STANDALONE_RESOURCE_NAME}/server.js`]], to: paths.unpackedRoot }],
      node,
    });
    if (cached == null) throw new Error("electron builder cache entry disappeared before portable zip materialization");
    return materializeCachedUnpackedForPortableZip(paths, packagedVersion);
  });
  await runSegment("portable-zip:write-manifest", async () => writeBuiltAppManifest(paths, materialized));
  let signedUnpacked = false;
  const ensureSignedUnpacked = async (): Promise<void> => {
    if (!config.signed || signedUnpacked) return;
    await runSegment("windows-sign:unpacked-exe", async () => { await signAndVerifyWinFile(materialized.executablePath, { verify: false }); });
    signedUnpacked = true;
  };
  const archiveSegments: WinPackTiming[] = [];
  await runSegment("portable-zip:cache", async () => {
    const portableZipNode = createWinPortableZipNode({
      build: async ({ entryRoot }) => {
        await ensureSignedUnpacked();
        archiveSegments.push(...await buildWinPortableZip(config, paths, materialized));
        await cp(paths.setupZipPath, join(entryRoot, "portable.zip"));
        return { createdAt: new Date().toISOString(), portableZipPath: paths.setupZipPath };
      },
      electronBuilderDirKey: key,
      packagedConfig: await readFile(materialized.configPath, "utf8"),
      namespace: config.namespace,
      packagedAppKey,
      packagedVersion,
      portableZipCompression: resolvePortableZipCompression(),
      signingCacheKey,
    });
    await cache.acquire({ materialize: [{ from: "portable.zip", reuse: true, to: paths.setupZipPath }], node: portableZipNode });
  });
  segments.push(...archiveSegments);
  return segments;
}
