import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { createCommandInvocation, createPackageManagerInvocation } from "@readable-studio/platform";
import { SIDECAR_ENV } from "@readable-studio/sidecar-proto";

import { hashJson, hashPath, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { hashPackageSourcePath } from "../package-source-hash.js";
import { electronBuilderVersionForAppVersion } from "../versions.js";
import {
  WIN_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER,
  WIN_PREBUNDLE_ESBUILD_TARGET,
  WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME,
  WIN_PREBUNDLE_META_DIR_NAME,
  WIN_PREBUNDLE_POLICIES,
  WIN_PREBUNDLE_RUNTIME_DEPENDENCIES,
  WIN_PREBUNDLED_APP_DIR_NAME,
  WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  WIN_PREBUNDLED_PACKAGED_MAIN_RELATIVE_PATH,
  WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
  assertWinPrebundleMetafile,
  renderWinPackagedMainEntry,
  shouldInstallInternalPackageForWinPrebundle,
  shouldUseWinStandalonePrebundle,
} from "../win-prebundle.js";
import { processWebSourcemaps } from "../web-sourcemaps.js";
import { ensureWorkspaceBuildArtifacts } from "../workspace-build.js";
import {
  ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
  ELECTRON_REBUILD_MODE,
  ELECTRON_REBUILD_NATIVE_MODULES,
  INTERNAL_PACKAGES,
  PRODUCT_NAME,
} from "./constants.js";
import { readPackagedVersion, writePackagedConfig } from "./manifest.js";
import { pathExists, removeTree } from "./fs.js";
import type {
  PackedTarballInfo,
  PackedTarballsCacheMetadata,
  PackedTarballsCacheResult,
  PackagedAppCacheMetadata,
  PackagedAppCacheResult,
  WinPaths,
} from "./types.js";

const execFileAsync = promisify(execFile);

async function runPnpm(config: ToolPackConfig, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const invocation = createPackageManagerInvocation(args, process.env);
  await execFileAsync(invocation.command, invocation.args, {
    cwd: config.workspaceRoot,
    env: { ...process.env, ...extraEnv },
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

async function runNpmInstall(appRoot: string): Promise<void> {
  const invocation = createCommandInvocation({
    args: ["install", "--omit=dev", "--no-package-lock"],
    command: process.platform === "win32" ? "npm.cmd" : "npm",
  });
  await execFileAsync(invocation.command, invocation.args, {
    cwd: appRoot,
    env: process.env,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

async function runEsbuild(config: ToolPackConfig, args: string[]): Promise<void> {
  await runPnpm(config, ["--filter", "@readable-studio/packaged", "exec", "esbuild", ...args]);
}

function nodeNativeModuleOutputPath(appRoot: string): string {
  return join(appRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
}

async function validateNodeNativeModuleOutput(appRoot: string): Promise<string | null> {
  const nativePath = nodeNativeModuleOutputPath(appRoot);
  try {
    const metadata = await stat(nativePath);
    if (metadata.size < 100_000) return `native module output is too small: ${nativePath}`;
    return null;
  } catch {
    return `native module output is missing: ${nativePath}`;
  }
}

// The workspace packages whose `build` script the packaged Windows app
// needs. We hand the whole set to pnpm's recursive scheduler instead of
// sequencing them by hand: pnpm derives the build order from each
// package's declared workspace dependencies and runs independent
// packages concurrently (bounded by --workspace-concurrency), so the
// builds saturate available cores rather than running one at a time.
// The list is order-independent here — pnpm computes the topological
// order itself — but kept readable. Web's main `build` runs inside this
// wave; its extra `build:sidecar` script and sourcemap post-processing
// stay serial below because neither is a `build` script.
const WORKSPACE_BUILD_FILTER_PACKAGES = [
  "@readable-studio/contracts",
  "@readable-studio/registry-protocol",
  "@readable-studio/sidecar-proto",
  "@readable-studio/sidecar",
  "@readable-studio/platform",
  "@readable-studio/agui-adapter",
  "@readable-studio/plugin-runtime",
  "@readable-studio/download",
  "@readable-studio/host",
  "@readable-studio/diagnostics",
  "@readable-studio/components",
  "@readable-studio/daemon",
  "@readable-studio/web",
  "@readable-studio/desktop",
  "@readable-studio/packaged",
] as const;

async function buildWorkspaceArtifacts(config: ToolPackConfig): Promise<void> {
  const webNextEnvPath = join(config.workspaceRoot, "apps", "web", "next-env.d.ts");
  const previousWebNextEnv = await readFile(webNextEnvPath, "utf8").catch(() => null);

  // pnpm caps real parallelism at the topological ready-set, so requesting
  // one slot per core lets the independent base packages — and the daemon
  // build overlapping the long-pole web build — use every available core.
  const workspaceConcurrency = Math.max(2, cpus().length);
  const filterArgs = WORKSPACE_BUILD_FILTER_PACKAGES.flatMap((name) => ["--filter", name]);

  try {
    // One recursive invocation builds every workspace package in dependency
    // order with up to `workspaceConcurrency` running at once. READABLE_WEB_OUTPUT_MODE
    // is consumed only by the web build; it is inert for the other packages.
    await runPnpm(
      config,
      ["-r", `--workspace-concurrency=${workspaceConcurrency}`, ...filterArgs, "run", "build"],
      { READABLE_WEB_OUTPUT_MODE: config.webOutputMode },
    );
    await runPnpm(config, ["--filter", "@readable-studio/platform", "build:native:win32"]);
    await runPnpm(config, ["--filter", "@readable-studio/web", "build:sidecar"]);
    // Strip browser sourcemaps before any packaging step copies the web
    // output into the Electron resources.
    await processWebSourcemaps(config);
  } finally {
    if (previousWebNextEnv == null) await rm(webNextEnvPath, { force: true });
    else await writeFile(webNextEnvPath, previousWebNextEnv, "utf8");
  }
}

export async function ensureWinWorkspaceBuild(config: ToolPackConfig, cache: ToolPackCache): Promise<void> {
  await ensureWorkspaceBuildArtifacts(config, cache, async () => {
    await buildWorkspaceArtifacts(config);
  });
}

export async function createWorkspaceTarballsCacheKey(config: ToolPackConfig): Promise<string> {
  const packageHashes: Record<string, string> = {};
  for (const packageInfo of INTERNAL_PACKAGES) {
    packageHashes[packageInfo.name] = await hashPackageSourcePath(join(config.workspaceRoot, packageInfo.directory));
  }
  const rootPackageJson = JSON.parse(await readFile(join(config.workspaceRoot, "package.json"), "utf8")) as {
    packageManager?: unknown;
  };

  return hashJson({
    node: "win.workspace-tarballs",
    packageHashes,
    packageManager: rootPackageJson.packageManager,
    pnpmLock: await hashPath(join(config.workspaceRoot, "pnpm-lock.yaml")),
    prebundle: shouldUseWinStandalonePrebundle(config.webOutputMode),
    schemaVersion: 6,
    webOutputMode: config.webOutputMode,
  });
}

export async function collectWorkspaceTarballs(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
): Promise<PackedTarballsCacheResult> {
  const key = await createWorkspaceTarballsCacheKey(config);
  const node = {
    id: "win.workspace-tarballs",
    key,
    outputs: ["tarballs"],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<PackedTarballsCacheMetadata> => {
      const tarballsRoot = join(entryRoot, "tarballs");
      await mkdir(tarballsRoot, { recursive: true });
      const packedTarballs: PackedTarballInfo[] = [];
      for (const packageInfo of INTERNAL_PACKAGES) {
        if (
          !shouldInstallInternalPackageForWinPrebundle({
            packageName: packageInfo.name,
            webOutputMode: config.webOutputMode,
          })
        ) {
          continue;
        }

        const beforeEntries = new Set(await readdir(tarballsRoot));
        await runPnpm(config, ["-C", packageInfo.directory, "pack", "--pack-destination", tarballsRoot]);
        const newEntries = (await readdir(tarballsRoot)).filter((entry) => !beforeEntries.has(entry));
        if (newEntries.length !== 1 || newEntries[0] == null) {
          throw new Error(`expected one tarball for ${packageInfo.name}, got ${newEntries.length}`);
        }
        packedTarballs.push({ fileName: newEntries[0], packageName: packageInfo.name });
      }
      return { tarballs: packedTarballs };
    },
  };
  const manifest = await cache.acquire({
    materialize: [{ from: "tarballs", to: paths.tarballsRoot }],
    node,
  });
  return { key, tarballs: manifest.payloadMetadata.tarballs };
}

function createAssembledAppDependencies(
  config: ToolPackConfig,
  paths: Pick<WinPaths, "assembledAppRoot" | "tarballsRoot">,
  packedTarballs: PackedTarballInfo[],
): Record<string, string> {
  const tarballByPackage = Object.fromEntries(packedTarballs.map((entry) => [entry.packageName, entry.fileName] as const));
  const internalDependencies = Object.fromEntries(
    INTERNAL_PACKAGES.filter((packageInfo) =>
      shouldInstallInternalPackageForWinPrebundle({
        packageName: packageInfo.name,
        webOutputMode: config.webOutputMode,
      })
    ).map((packageInfo) => {
      const tarball = tarballByPackage[packageInfo.name];
      if (tarball == null) throw new Error(`missing tarball for ${packageInfo.name}`);
      return [packageInfo.name, `file:${relative(paths.assembledAppRoot, join(paths.tarballsRoot, tarball))}`];
    }),
  );
  return {
    ...internalDependencies,
    ...(shouldUseWinStandalonePrebundle(config.webOutputMode) ? WIN_PREBUNDLE_RUNTIME_DEPENDENCIES : {}),
  };
}

async function writeAssembledAppEntrypoints(
  config: ToolPackConfig,
  paths: Pick<WinPaths, "assembledAppRoot" | "assembledMainEntryPath" | "assembledPackageJsonPath" | "tarballsRoot">,
  packedTarballs: PackedTarballInfo[],
  packagedVersion: string,
  options: { dependencies?: Record<string, string>; usePrebundle?: boolean } = {},
): Promise<void> {
  const packageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  await mkdir(paths.assembledAppRoot, { recursive: true });
  await cp(
    join(config.workspaceRoot, "apps", "desktop", "dist", "main", "preload.cjs"),
    join(paths.assembledAppRoot, "preload.cjs"),
  );
  // Desktop main resolves the splash page from `<appRoot>/assets/` when it
  // runs as the standalone prebundle (see resolveSplashHtmlPath in
  // apps/desktop/src/main/runtime.ts); the prebundle excludes the desktop
  // tarball, so the assets must be staged here explicitly.
  await cp(
    join(config.workspaceRoot, "apps", "desktop", "assets"),
    join(paths.assembledAppRoot, "assets"),
    { recursive: true },
  );
  await writeFile(
    paths.assembledPackageJsonPath,
    `${JSON.stringify(
      {
        dependencies: options.dependencies ?? createAssembledAppDependencies(config, paths, packedTarballs),
        description: "Readable Studio packaged runtime",
        main: "./main.cjs",
        name: "readable-studio-packaged-app",
        private: true,
        productName: PRODUCT_NAME,
        version: packageVersion,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    paths.assembledMainEntryPath,
    renderWinPackagedMainEntry(options.usePrebundle === true),
    "utf8",
  );
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function toRelativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const specifier = toPosixPath(relative(fromDirectory, targetPath));
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function createAppLocalPrebundlePaths(paths: WinPaths, appRoot: string, entryRoot: string): WinPaths {
  return {
    ...paths,
    assembledAppRoot: appRoot,
    assembledMainEntryPath: join(appRoot, "main.cjs"),
    assembledPackageJsonPath: join(appRoot, "package.json"),
    assembledPrebundledRoot: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME),
    daemonCliPrebundleEntrypointPath: join(entryRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-cli.js"),
    daemonCliPrebundlePath: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "daemon", "daemon-cli.mjs"),
    daemonPrebundleMetaPath: join(entryRoot, WIN_PREBUNDLE_META_DIR_NAME, "daemon.meta.json"),
    daemonPrebundleRoot: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(entryRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "daemon", "daemon-sidecar.mjs"),
    packagedMainPrebundleMetaPath: join(entryRoot, WIN_PREBUNDLE_META_DIR_NAME, "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "packaged-main.mjs"),
    webSidecarPrebundleMetaPath: join(entryRoot, WIN_PREBUNDLE_META_DIR_NAME, "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "web-sidecar.mjs"),
  };
}

async function buildPrebundledStandaloneRuntime(
  config: ToolPackConfig,
  paths: WinPaths,
): Promise<void> {
  await mkdir(paths.assembledPrebundledRoot, { recursive: true });
  await mkdir(dirname(paths.packagedMainPrebundleMetaPath), { recursive: true });
  await runEsbuild(config, [
    join(config.workspaceRoot, "apps", "packaged", "dist", "index.mjs"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--target=${WIN_PREBUNDLE_ESBUILD_TARGET}`,
    ...WIN_PREBUNDLE_POLICIES.packagedMain.externals.map((dependency) => `--external:${dependency}`),
    `--outfile=${paths.packagedMainPrebundlePath}`,
    `--metafile=${paths.packagedMainPrebundleMetaPath}`,
  ]);
  await assertWinPrebundleMetafile({
    metafilePath: paths.packagedMainPrebundleMetaPath,
    policyName: "packagedMain",
  });

  await runEsbuild(config, [
    join(config.workspaceRoot, "apps", "web", "dist", "sidecar", "index.js"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--target=${WIN_PREBUNDLE_ESBUILD_TARGET}`,
    ...WIN_PREBUNDLE_POLICIES.webSidecar.externals.map((dependency) => `--external:${dependency}`),
    `--outfile=${paths.webSidecarPrebundlePath}`,
    `--metafile=${paths.webSidecarPrebundleMetaPath}`,
  ]);
  await assertWinPrebundleMetafile({
    metafilePath: paths.webSidecarPrebundleMetaPath,
    policyName: "webSidecar",
  });

  await mkdir(dirname(paths.daemonSidecarPrebundleEntrypointPath), { recursive: true });
  await writeFile(
    paths.daemonSidecarPrebundleEntrypointPath,
    `import ${JSON.stringify(
      toRelativeImportSpecifier(
        dirname(paths.daemonSidecarPrebundleEntrypointPath),
        join(config.workspaceRoot, "apps", "daemon", "dist", "sidecar", "index.js"),
      ),
    )};\n`,
    "utf8",
  );
  await writeFile(
    paths.daemonCliPrebundleEntrypointPath,
    [
      'import { fileURLToPath } from "node:url";',
      "const selfPath = fileURLToPath(import.meta.url);",
      "process.env.READABLE_BIN ??= selfPath;",
      `process.env[${JSON.stringify(SIDECAR_ENV.DAEMON_CLI_PATH)}] ??= selfPath;`,
      `await import(${JSON.stringify(
        toRelativeImportSpecifier(
          dirname(paths.daemonCliPrebundleEntrypointPath),
          join(config.workspaceRoot, "apps", "daemon", "dist", "cli.js"),
        ),
      )});`,
      "",
    ].join("\n"),
    "utf8",
  );
  await runEsbuild(config, [
    paths.daemonSidecarPrebundleEntrypointPath,
    paths.daemonCliPrebundleEntrypointPath,
    "--bundle",
    "--splitting",
    "--platform=node",
    "--format=esm",
    `--target=${WIN_PREBUNDLE_ESBUILD_TARGET}`,
    `--banner:js=${WIN_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER}`,
    ...WIN_PREBUNDLE_POLICIES.daemonSidecar.externals.map((dependency) => `--external:${dependency}`),
    `--outdir=${paths.daemonPrebundleRoot}`,
    "--entry-names=[name]",
    "--chunk-names=chunks/[name]-[hash]",
    "--out-extension:.js=.mjs",
    `--metafile=${paths.daemonPrebundleMetaPath}`,
  ]);
  await assertWinPrebundleMetafile({
    metafilePath: paths.daemonPrebundleMetaPath,
    policyName: "daemonSidecar",
  });
  await assertWinPrebundleMetafile({
    metafilePath: paths.daemonPrebundleMetaPath,
    policyName: "daemonCli",
  });
}

export async function createWinPackagedAppCacheKey(
  config: ToolPackConfig,
  tarballsKey: string,
  packedTarballs: PackedTarballInfo[],
): Promise<string> {
  return hashJson({
    arch: "x64",
    electronVersion: config.electronVersion,
    modules: ELECTRON_REBUILD_NATIVE_MODULES,
    node: "win.packaged-app",
    packedTarballs,
    platform: "win32",
    prebundle: shouldUseWinStandalonePrebundle(config.webOutputMode),
    schemaVersion: 2,
    tarballsKey,
    webOutputMode: config.webOutputMode,
  });
}

export async function prepareWinPackagedApp(
  config: ToolPackConfig,
  paths: WinPaths,
  tarballs: PackedTarballsCacheResult,
  cache: ToolPackCache,
): Promise<PackagedAppCacheResult> {
  const packagedVersion = await readPackagedVersion(config);
  await removeTree(join(config.roots.output.namespaceRoot, "assembled"));
  const packedTarballs = tarballs.tarballs;
  const key = await createWinPackagedAppCacheKey(config, tarballs.key, packedTarballs);
  const usePrebundle = shouldUseWinStandalonePrebundle(config.webOutputMode);
  const node = {
    id: "win.packaged-app",
    key,
    outputs: ["app"],
    invalidate: async ({ entryRoot }: { entryRoot: string }) => {
      const nativeValidationError = await validateNodeNativeModuleOutput(join(entryRoot, "app"));
      return nativeValidationError == null ? null : { reason: nativeValidationError };
    },
    build: async ({ entryRoot }: { entryRoot: string }): Promise<PackagedAppCacheMetadata> => {
      const appRoot = join(entryRoot, "app");
      const appPaths = createAppLocalPrebundlePaths(paths, appRoot, entryRoot);
      await writeAssembledAppEntrypoints(
        config,
        appPaths,
        packedTarballs,
        packagedVersion,
        { usePrebundle },
      );
      if (usePrebundle) {
        await buildPrebundledStandaloneRuntime(config, appPaths);
      }
      await runNpmInstall(appRoot);
      const nativeValidationError = await validateNodeNativeModuleOutput(appRoot);
      if (nativeValidationError != null) throw new Error(nativeValidationError);
      return { packagedVersion };
    },
  };
  const manifest = await cache.acquire({
    materialize: [],
    node,
  });
  await writeAssembledAppEntrypoints(
    config,
    {
      ...paths,
      assembledAppRoot: join(manifest.entryPath, "app"),
      assembledMainEntryPath: join(manifest.entryPath, "app", "main.cjs"),
      assembledPackageJsonPath: join(manifest.entryPath, "app", "package.json"),
    },
    packedTarballs,
    packagedVersion,
    { usePrebundle },
  );
  await writePackagedConfig(
    config,
    paths,
    packagedVersion,
    usePrebundle
      ? {
          daemonCliEntryRelative: WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
          daemonSidecarEntryRelative: WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
          webSidecarEntryRelative: WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
        }
      : {},
  );
  return { appRoot: join(manifest.entryPath, "app"), key, packagedVersion };
}
