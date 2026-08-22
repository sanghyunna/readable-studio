import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  APP_KEYS,
  SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  normalizeRuntimeDescriptor,
  RuntimeDescriptorError,
  type DesktopEvalResult,
  type DesktopScreenshotResult,
  type DesktopStatusSnapshot,
  type SidecarStamp,
} from "@readable-studio/sidecar-proto";
import { createSidecarLaunchEnv, requestJsonIpc, resolveAppIpcPath } from "@readable-studio/sidecar";
import {
  collectProcessTreePids,
  createProcessStampArgs,
  listProcessSnapshots,
  matchesStampedProcess,
  readLogTail,
  spawnBackgroundProcess,
  stopProcesses,
} from "@readable-studio/platform";

import type { ToolPackConfig } from "../config.js";
import { DESKTOP_LOG_ECHO_ENV } from "./constants.js";
import { pathExists, removeTree } from "./fs.js";
import { readBuiltAppManifest } from "./manifest.js";
import { resolveWinPaths } from "./paths.js";
import type {
  WinCleanupResult,
  WinInspectResult,
  WinStartResult,
  WinStopResult,
} from "./types.js";

const PACKAGED_CONFIG_PATH_ENV = "READABLE_PACKAGED_CONFIG_PATH";

function desktopStamp(config: ToolPackConfig): SidecarStamp {
  return {
    app: APP_KEYS.DESKTOP,
    ipc: resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: SIDECAR_CONTRACT, namespace: config.namespace }),
    mode: SIDECAR_MODES.RUNTIME,
    namespace: config.namespace,
    source: SIDECAR_SOURCES.TOOLS_PACK,
  };
}

function desktopLogPath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "logs", APP_KEYS.DESKTOP, "latest.log");
}

function desktopIdentityPath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "runtime", "desktop-root.json");
}

async function waitForDesktopStatus(config: ToolPackConfig, timeoutMs = 45_000): Promise<DesktopStatusSnapshot | null> {
  const stamp = desktopStamp(config);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const snapshot = await requestJsonIpc<DesktopStatusSnapshot>(
        stamp.ipc,
        { type: SIDECAR_MESSAGES.STATUS },
        { timeoutMs: 1000 },
      );
      normalizeRuntimeDescriptor(snapshot.descriptor);
      return snapshot;
    } catch (error) {
      if (error instanceof RuntimeDescriptorError) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  return null;
}

async function resolveStartTarget(config: ToolPackConfig): Promise<{ configPath: string | null; executablePath: string; source: "built" }> {
  const paths = resolveWinPaths(config);
  const builtManifest = await readBuiltAppManifest(paths, { requireExecutable: true });
  if (builtManifest != null) {
    return { configPath: builtManifest.configPath, executablePath: builtManifest.executablePath, source: "built" };
  }
  if (await pathExists(paths.unpackedExePath)) {
    return { configPath: null, executablePath: paths.unpackedExePath, source: "built" };
  }
  throw new Error(`no extracted Windows portable runtime found for namespace=${config.namespace}; run tools-pack win build first`);
}

export async function startPackedWinApp(config: ToolPackConfig): Promise<WinStartResult> {
  const target = await resolveStartTarget(config);
  const stamp = desktopStamp(config);
  const logPath = desktopLogPath(config);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");
  const spawned = await spawnBackgroundProcess({
    args: createProcessStampArgs(stamp, SIDECAR_CONTRACT),
    command: target.executablePath,
    cwd: dirname(target.executablePath),
    env: createSidecarLaunchEnv({
      base: join(config.roots.runtime.namespaceRoot, "runtime"),
      contract: SIDECAR_CONTRACT,
      extraEnv: {
        ...process.env,
        [DESKTOP_LOG_ECHO_ENV]: "0",
        ...(target.configPath == null ? {} : { [PACKAGED_CONFIG_PATH_ENV]: target.configPath }),
      },
      stamp,
    }),
    logFd: null,
  });
  return {
    executablePath: target.executablePath,
    logPath,
    namespace: config.namespace,
    pid: spawned.pid,
    source: target.source,
    status: await waitForDesktopStatus(config),
  };
}

async function findManagedDesktopProcessTree(config: ToolPackConfig): Promise<number[]> {
  const processes = await listProcessSnapshots();
  const stampedRootPids = processes
    .filter((processInfo) =>
      matchesStampedProcess(
        processInfo,
        { mode: SIDECAR_MODES.RUNTIME, namespace: config.namespace, source: SIDECAR_SOURCES.TOOLS_PACK },
        SIDECAR_CONTRACT,
      ),
    )
    .map((processInfo) => processInfo.pid);
  return collectProcessTreePids(processes, stampedRootPids);
}

async function waitForNoManagedDesktopProcesses(config: ToolPackConfig, timeoutMs = 6000): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await findManagedDesktopProcessTree(config);
    if (pids.length === 0) return [];
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return findManagedDesktopProcessTree(config);
}

export async function stopPackedWinApp(config: ToolPackConfig): Promise<WinStopResult> {
  const stamp = desktopStamp(config);
  const before = await findManagedDesktopProcessTree(config);
  let gracefulRequested = false;
  try {
    await requestJsonIpc(stamp.ipc, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1500 });
    gracefulRequested = true;
  } catch {
    gracefulRequested = false;
  }
  const remainingAfterGraceful = gracefulRequested ? await waitForNoManagedDesktopProcesses(config) : before;
  if (remainingAfterGraceful.length === 0) {
    await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
    return {
      gracefulRequested,
      namespace: config.namespace,
      remainingPids: [],
      status: before.length === 0 ? "not-running" : "stopped",
      stoppedPids: before,
    };
  }
  const stopped = await stopProcesses(remainingAfterGraceful);
  if (stopped.remainingPids.length === 0) await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
  return {
    gracefulRequested,
    namespace: config.namespace,
    remainingPids: stopped.remainingPids,
    status: stopped.remainingPids.length === 0 ? "stopped" : "partial",
    stoppedPids: stopped.stoppedPids,
  };
}

export async function readPackedWinLogs(config: ToolPackConfig) {
  const entries = await Promise.all(
    [APP_KEYS.DESKTOP, APP_KEYS.WEB, APP_KEYS.DAEMON].map(async (app) => {
      const logPath = join(config.roots.runtime.namespaceRoot, "logs", app, "latest.log");
      return [app, { lines: await readLogTail(logPath, 200), logPath }] as const;
    }),
  );
  return { logs: Object.fromEntries(entries), namespace: config.namespace };
}

export async function cleanupPackedWinNamespace(config: ToolPackConfig): Promise<WinCleanupResult> {
  const stop = await stopPackedWinApp(config);
  const removedOutputRoot = await pathExists(config.roots.output.namespaceRoot);
  const removedRuntimeNamespaceRoot = await pathExists(config.roots.runtime.namespaceRoot);
  await removeTree(config.roots.output.namespaceRoot);
  await removeTree(config.roots.runtime.namespaceRoot);
  return {
    namespace: config.namespace,
    removedOutputRoot,
    removedRuntimeNamespaceRoot,
    stop,
  };
}

export async function inspectPackedWinApp(
  config: ToolPackConfig,
  options: { expr?: string; path?: string },
): Promise<WinInspectResult> {
  const stamp = desktopStamp(config);
  const status = await requestJsonIpc<DesktopStatusSnapshot>(
    stamp.ipc,
    { type: SIDECAR_MESSAGES.STATUS },
    { timeoutMs: 2000 },
  ).catch(() => null);
  return {
    ...(options.expr == null ? {} : {
      eval: await requestJsonIpc<DesktopEvalResult>(stamp.ipc, { input: { expression: options.expr }, type: SIDECAR_MESSAGES.EVAL }, { timeoutMs: 5000 }),
    }),
    ...(options.path == null ? {} : {
      screenshot: await requestJsonIpc<DesktopScreenshotResult>(stamp.ipc, { input: { path: options.path }, type: SIDECAR_MESSAGES.SCREENSHOT }, { timeoutMs: 10_000 }),
    }),
    status,
  };
}
