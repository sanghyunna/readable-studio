import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { createCommandInvocation, createPackageManagerInvocation } from "@readable-studio/platform";
import { SIDECAR_ENV } from "@readable-studio/sidecar-proto";

import { forwardPnpmProfile, isBuildProfilingEnabled, measureBuildStep } from "../build-profile.js";
import { createBuildEventWriter } from "../build-events.js";
import { hashJson, hashPath, privatizeForWrite, removeMaterializedTree, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { assertDatabricksCliOutput, stageDatabricksCli } from "../databricks-cli.js";
import databricksCli from "../databricks-cli.json" with { type: "json" };
import { hashPackageSourcePath } from "../package-source-hash.js";
import { assertPiPackageIntegrity, assertPiPackageOutput, patchPiPackage, resolvePiPackagePatch } from "../pi-package.js";
import piPackage from "../pi-package.json" with { type: "json" };
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
  assertWinDaemonRuntimeAssets,
  stageWinDaemonRuntimeAssets,
  renderWinPackagedMainEntry,
  shouldInstallInternalPackageForWinPrebundle,
  shouldUseWinStandalonePrebundle,
} from "../win-prebundle.js";
import { processWebSourcemaps } from "../web-sourcemaps.js";
import { ensureWorkspacePackageBuilds } from "../workspace-build.js";
import { withDirectoryLock } from "../lock.js";
import {
  ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
  ELECTRON_REBUILD_MODE,
  ELECTRON_REBUILD_NATIVE_MODULES,
  INTERNAL_PACKAGES,
  PRODUCT_NAME,
} from "./constants.js";
import { readPackagedVersion, writePackagedConfig } from "./manifest.js";
import { pathExists } from "./fs.js";
import type {
  PackedTarballInfo,
  PackedTarballsCacheMetadata,
  PackedTarballsCacheResult,
  PackagedAppCacheMetadata,
  PackagedAppCacheResult,
  WinPaths,
} from "./types.js";

import packagedAppLock from "./packaged-app-lock.json" with { type: "json" };

const execFileAsync = promisify(execFile);

// Registry packages retain the HEAD artifact's complete graph and integrity pins.
// Workspace tarballs are regenerated from source, so only their lock entries vary.
export async function writePackagedAppLock(appRoot: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  const lock = structuredClone(packagedAppLock) as {
    version: string; packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
  };
  lock.version = manifest.version;
  lock.packages[""]!.version = manifest.version;
  lock.packages[""]!.dependencies = manifest.dependencies;
  for (const [name, spec] of Object.entries(manifest.dependencies) as Array<[string, string]>) {
    if (!name.startsWith("@readable-studio/")) continue;
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) throw new Error(`packaged app lock is missing ${name}`);
    const tarball = resolve(appRoot, spec.slice("file:".length));
    // Windows ships bsdtar. Never resolve Git's GNU tar through PATH: GNU tar
    // interprets drive-qualified archive names as remote host:path references.
    const { stdout } = await execFileAsync(join(process.env.SystemRoot!, "System32", "tar.exe"),
      ["-xOf", tarball, "package/package.json"], { timeout: 10_000, windowsHide: true });
    const packedManifest = JSON.parse(stdout);
    entry.version = packedManifest.version;
    entry.dependencies = packedManifest.dependencies;
    entry.resolved = spec.replaceAll("\\", "/");
    entry.integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  }
  await writeFile(join(appRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

async function runPnpm(config: ToolPackConfig, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const profiling = isBuildProfilingEnabled() && args.includes("-r");
  const invocation = createPackageManagerInvocation(profiling ? ["--reporter=ndjson", ...args] : args, process.env);
  try {
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd: config.workspaceRoot,
      env: { ...process.env, ...extraEnv },
      ...(profiling ? { maxBuffer: 16 * 1024 * 1024 } : {}),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    if (profiling) forwardPnpmProfile(result.stdout);
  } catch (error) {
    if (profiling && error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
      forwardPnpmProfile(error.stdout);
    }
    throw error;
  }
}

export type InstallProcessProgress = { identity: string; cpu: number; io: number };

async function sampleInstallProcessTree(pid: number): Promise<InstallProcessProgress[]> {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,OtherTransferCount) | ConvertTo-Json -Compress",
  ], { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as Array<{
    ProcessId: number; ParentProcessId: number; CreationDate: string;
    KernelModeTime: number; UserModeTime: number;
    ReadTransferCount: number; WriteTransferCount: number; OtherTransferCount: number;
  }>;
  const descendants = new Set([pid]);
  for (let previousSize = 0; previousSize !== descendants.size;) {
    previousSize = descendants.size;
    for (const row of rows) if (descendants.has(row.ParentProcessId)) descendants.add(row.ProcessId);
  }
  return rows.filter((row) => descendants.has(row.ProcessId)).map((row) => ({
    identity: `${row.ProcessId}:${row.CreationDate}`,
    cpu: Number(row.KernelModeTime) + Number(row.UserModeTime),
    io: Number(row.ReadTransferCount) + Number(row.WriteTransferCount) + Number(row.OtherTransferCount),
  }));
}

async function terminateInstallProcessTree(pid: number): Promise<void> {
  await execFileAsync(join(process.env.SystemRoot!, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
}

export function watchPackagedAppInstall(
  child: ChildProcess,
  options: {
    sample?: (pid: number) => Promise<InstallProcessProgress[]>;
    terminate?: (pid: number) => Promise<void>;
  } = {},
): Promise<void> {
  const step = "packaged-app:npm-install";
  const sample = options.sample ?? sampleInstallProcessTree;
  const terminate = options.terminate ?? terminateInstallProcessTree;
  return new Promise((resolve, reject) => {
    let lastProgress = Date.now();
    let idleSamples = 0;
    let previous = new Map<string, InstallProcessProgress>();
    let stopped = false;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingSample: Promise<void> | undefined;
    let outputTail = "";
    const onOutput = (chunk: Buffer | string): void => {
      lastProgress = Date.now();
      idleSamples = 0;
      outputTail = (outputTail + String(chunk)).slice(-16_384);
    };
    const finish = (error?: Error): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      // Drain an in-flight observer before returning to cache staging cleanup.
      void (pendingSample ?? Promise.resolve()).then(() => error ? reject(error) : resolve());
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error) => finish(new Error(`${step}: ${error.message}`)));
    child.once("close", (code, signal) => finish(failure ?? (code === 0 ? undefined
      : new Error(`${step} exited ${code ?? signal}\n${outputTail}`))));
    const check = async (): Promise<void> => {
      if (stopped || child.pid == null) return;
      try {
        const current = await sample(child.pid);
        if (stopped) return;
        const progressed = current.some((row) => {
          const old = previous.get(row.identity);
          return row.cpu > (old?.cpu ?? 0) || row.io > (old?.io ?? 0);
        });
        if (progressed) {
          lastProgress = Date.now();
          idleSamples = 0;
        } else idleSamples++;
        previous = new Map(current.map((row) => [row.identity, row]));
        // Retain the 120 s stall window, but require three consecutive reliable
        // idle observations. A failed CIM sample is not evidence of a stall.
        if (Date.now() - lastProgress >= 120_000 && idleSamples >= 3) {
          failure = new Error(`${step}: no output or child CPU/IO progress for 120 s (PID ${child.pid})`);
        }
      } catch {
        if (stopped) return;
        idleSamples = 0;
      }
      if (failure != null) {
        // Keep staging owned until close, even if taskkill fails. Bound the wait
        // and identify survivors instead of silently returning with a writer alive.
        timer = setTimeout(() => {
          pendingSample = (async () => {
            let survivors: string;
            try {
              survivors = (await sample(child.pid!)).map((row) => row.identity.split(":")[0]).join(", ") || "none observed";
            } catch (error) {
              survivors = `unknown (root PID ${child.pid}; observation failed: ${String(error)})`;
            }
            if (!stopped) finish(new Error(`${failure!.message}; child did not close within 30 s; surviving PIDs: ${survivors}`));
          })();
        }, 30_000);
        try {
          await terminate(child.pid);
        } catch (error) {
          // A natural exit can race taskkill. Its close event owns completion.
          if (!stopped) {
            failure = new Error(`${failure.message}; process-tree termination failed: ${String(error)}`);
          }
        }
      } else if (!stopped) {
        timer = setTimeout(() => { pendingSample = check(); }, 5_000);
      }
    };
    timer = setTimeout(() => { pendingSample = check(); }, 0);
  });
}

async function runNpmInstall(appRoot: string, locked: boolean): Promise<void> {
  const invocation = createCommandInvocation({
    args: [locked ? "ci" : "install", "--omit=dev", "--package-lock", "--no-audit", "--no-fund", "--prefer-offline"],
    command: process.platform === "win32" ? "npm.cmd" : "npm",
  });
  await measureBuildStep("packaged-app:npm-install", () => {
    if (createBuildEventWriter() == null) {
      return execFileAsync(invocation.command, invocation.args, {
        cwd: appRoot, windowsHide: true, env: process.env,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }).then(() => undefined);
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: appRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    return watchPackagedAppInstall(child);
  });
}

async function runEsbuild(config: ToolPackConfig, args: string[]): Promise<void> {
  await measureBuildStep("prebundle:esbuild", () =>
    runPnpm(config, ["--filter", "@readable-studio/packaged", "exec", "esbuild", ...args]), { args });
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

async function buildWorkspaceArtifacts(config: ToolPackConfig): Promise<void> {
  const webNextEnvPath = join(config.workspaceRoot, "apps", "web", "next-env.d.ts");
  const previousWebNextEnv = await readFile(webNextEnvPath, "utf8").catch(() => null);

  try {
    // Dependency-ready scheduling avoids pnpm's whole-level barrier. Exact
    // package/dependency keys reuse outputs, including unchanged Next builds.
    await ensureWorkspacePackageBuilds(config, async (packageInfo) => {
      await runPnpm(config, ["--filter", packageInfo.name, "run", "build"],
        { READABLE_WEB_OUTPUT_MODE: config.webOutputMode });
      if (packageInfo.name === "@readable-studio/platform") {
        await measureBuildStep("workspace:native-isolator", () =>
          runPnpm(config, ["--filter", packageInfo.name, "build:native:win32"]));
      }
      if (packageInfo.name === "@readable-studio/web") {
        await measureBuildStep("workspace:web-sidecar", () =>
          runPnpm(config, ["--filter", packageInfo.name, "build:sidecar"]));
        // Cache only the post-processed, shippable browser output.
        await measureBuildStep("workspace:web-sourcemaps", () => processWebSourcemaps(config));
      }
    });
  } finally {
    if (previousWebNextEnv == null) await rm(webNextEnvPath, { force: true });
    else await writeFile(webNextEnvPath, previousWebNextEnv, "utf8");
  }
}

export async function ensureWinWorkspaceBuild(config: ToolPackConfig, cache: ToolPackCache): Promise<void> {
  // Serialize callers that mutate this shared workspace, but let package cache
  // nodes build independently. No second whole-workspace snapshot/copy-back.
  await withDirectoryLock(join(cache.root, "locks"), "workspace-build", async () => {
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
      const packages = INTERNAL_PACKAGES.filter((packageInfo) => shouldInstallInternalPackageForWinPrebundle({
        packageName: packageInfo.name, webOutputMode: config.webOutputMode,
      }));
      const packedTarballs: PackedTarballInfo[] = [];
      // Each pack has its own destination: concurrent readdir diffs on the shared
      // tarballs root would incorrectly attribute another package's output.
      for (let offset = 0; offset < packages.length; offset += 4) {
        const tasks = packages.slice(offset, offset + 4).map(async (packageInfo) => {
          const destination = join(entryRoot, "packing", packageInfo.name.replaceAll("/", "-"));
          await mkdir(destination, { recursive: true });
          await runPnpm(config, ["-C", packageInfo.directory, "pack", "--pack-destination", destination]);
          const entries = await readdir(destination);
          if (entries.length !== 1 || entries[0] == null) {
            throw new Error(`expected one tarball for ${packageInfo.name}, got ${entries.length}`);
          }
          await cp(join(destination, entries[0]), join(tarballsRoot, entries[0]));
          return { fileName: entries[0], packageName: packageInfo.name };
        });
        await Promise.allSettled(tasks);
        packedTarballs.push(...await Promise.all(tasks));
      }
      await rm(join(entryRoot, "packing"), { recursive: true });
      return { tarballs: packedTarballs };
    },
  };
  const manifest = await cache.acquire({
    materialize: [{ from: "tarballs", to: paths.tarballsRoot }],
    node,
  });
  return { key, tarballs: manifest.payloadMetadata.tarballs };
}

export function createAssembledAppDependencies(
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
    [piPackage.name]: piPackage.version,
    ...(shouldUseWinStandalonePrebundle(config.webOutputMode) ? WIN_PREBUNDLE_RUNTIME_DEPENDENCIES : {}),
  };
}

async function writeAssembledAppEntrypoints(
  config: ToolPackConfig,
  paths: Pick<WinPaths, "assembledAppRoot" | "assembledMainEntryPath" | "assembledPackageJsonPath" | "tarballsRoot">,
  packedTarballs: PackedTarballInfo[],
  packagedVersion: string,
  options: { dependencies?: Record<string, string>; usePrebundle?: boolean; stampOnly?: boolean } = {},
): Promise<void> {
  const packageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  await mkdir(paths.assembledAppRoot, { recursive: true });
  if (!options.stampOnly) {
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
  }
  if (options.stampOnly && createBuildEventWriter() != null) {
    await privatizeForWrite(paths.assembledPackageJsonPath);
    await privatizeForWrite(paths.assembledMainEntryPath);
  }
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
  await stageWinDaemonRuntimeAssets(config.workspaceRoot, paths.daemonPrebundleRoot);
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
    prebundlePolicies: WIN_PREBUNDLE_POLICIES,
    prebundleRuntimeDependencies: WIN_PREBUNDLE_RUNTIME_DEPENDENCIES,
    schemaVersion: 7,
    packagedAppLock,
    piPackage,
    piPatch: await hashPath(await resolvePiPackagePatch(config.workspaceRoot)),
    databricksCli,
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
  await removeMaterializedTree(join(config.roots.output.namespaceRoot, "assembled"));
  const packedTarballs = tarballs.tarballs;
  const key = await createWinPackagedAppCacheKey(config, tarballs.key, packedTarballs);
  const usePrebundle = shouldUseWinStandalonePrebundle(config.webOutputMode);
  const immutable = createBuildEventWriter() != null;
  const node = {
    id: "win.packaged-app",
    immutable,
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
      const install = async () => {
        if (usePrebundle) await writePackagedAppLock(appRoot);
        await runNpmInstall(appRoot, usePrebundle);
        await measureBuildStep("packaged-app:patch-pi", () => patchPiPackage(appRoot, config.workspaceRoot));
      };
      // These producers write disjoint app subtrees. Drain them before cache
      // failure cleanup; npm must complete before applying the Pi patch.
      const tasks = [install(), stageDatabricksCli(appRoot),
        ...(usePrebundle ? [buildPrebundledStandaloneRuntime(config, appPaths)] : [])];
      await Promise.allSettled(tasks);
      await Promise.all(tasks);
      // Execute Pi only after cache finalization below: a failed cache build
      // deletes this temporary tree, including the evidence needed to debug it.
      const nativeValidationError = await validateNodeNativeModuleOutput(appRoot);
      if (nativeValidationError != null) throw new Error(nativeValidationError);
      return { packagedVersion };
    },
  };
  const manifest = await cache.acquire({
    materialize: immutable ? [{ from: "app", to: paths.assembledAppRoot, writeSet: ["main.cjs", "package.json"] }] : [],
    node,
  });
  const appRoot = immutable ? paths.assembledAppRoot : join(manifest.entryPath, "app");
  await assertDatabricksCliOutput(appRoot);
  await assertPiPackageIntegrity(appRoot);
  if (usePrebundle) await assertWinDaemonRuntimeAssets(join(appRoot, WIN_PREBUNDLED_APP_DIR_NAME, "daemon"));
  await writeAssembledAppEntrypoints(
    config,
    { ...paths, assembledAppRoot: appRoot, assembledMainEntryPath: join(appRoot, "main.cjs"), assembledPackageJsonPath: join(appRoot, "package.json") },
    packedTarballs,
    packagedVersion,
    { usePrebundle, stampOnly: true },
  );
  // Mandatory on both misses and hits, against the final path and entrypoints.
  // Failure still stops packaging, but the cache payload remains inspectable.
  await measureBuildStep("packaged-app:assert-pi", () => assertPiPackageOutput(appRoot));
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
  return { appRoot, key, packagedVersion };
}
