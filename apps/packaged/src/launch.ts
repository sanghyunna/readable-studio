import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";

import { app } from "electron";
import { APP_KEYS, SIDECAR_CONTRACT, SIDECAR_MESSAGES, type DesktopStatusSnapshot } from "@readable-studio/sidecar-proto";
import { requestJsonIpc, resolveAppIpcPath } from "@readable-studio/sidecar";

import { PackagedNetworkingRestoreError, PackagedPathAccessError } from "./errors.js";
import type { PackagedNamespacePaths } from "./paths.js";

type PackagedLaunchLogger = Pick<Console, "warn"> & Partial<Pick<Console, "info">>;

export type PackagedExistingDesktopGateResult =
  | { action: "continue"; reason: "inspect-failed" | "not-running" }
  | { action: "exit"; reason: "existing-focused" | "existing-focus-failed" };

export type PackagedSingleInstanceApp = {
  on: (event: "second-instance", listener: () => void) => unknown;
  quit: () => void;
  requestSingleInstanceLock: () => boolean;
};
type PathDiagnostic = {
  exists: boolean;
  mode?: number;
  path: string;
};

function formatMode(mode: number | undefined): string {
  if (mode == null) return "unknown";
  return `0${(mode & 0o777).toString(8)}`;
}

async function inspectPath(path: string): Promise<PathDiagnostic> {
  try {
    const stats = await stat(path);
    return { exists: true, mode: stats.mode, path };
  } catch {
    return { exists: false, path };
  }
}

function formatWritablePathError(options: {
  attemptedPath: string;
  currentUser: string;
  diagnostic: PathDiagnostic;
  error: unknown;
  parentDiagnostic: PathDiagnostic;
}): string {
  const { attemptedPath, currentUser, diagnostic, error, parentDiagnostic } = options;
  const message = error instanceof Error ? error.message : String(error);
  const diagLines = [
    `Readable Studio could not create or write to:`,
    attemptedPath,
    "",
    `Current user: ${currentUser}`,
    `Node error: ${message}`,
    `Target exists: ${diagnostic.exists ? "yes" : "no"}`,
    `Target mode: ${formatMode(diagnostic.mode)}`,
    `Parent exists: ${parentDiagnostic.exists ? "yes" : "no"}`,
    `Parent mode: ${formatMode(parentDiagnostic.mode)}`,
    "",
    `Common causes:`,
    `• the archive was extracted into a protected or read-only folder`,
    `• a required directory path is occupied by a file`,
    `• security software denied writes beside the executable`,
    "",
    `Extract Readable Studio to a writable folder owned by ${currentUser}, then launch it again.`,
  ];
  return diagLines.join("\n");
}

// @dsp func-77b5e7da
export async function verifyPackagedDataRootWritable(paths: Pick<PackagedNamespacePaths, "dataRoot">): Promise<void> {
  await verifyPackagedWritableRoot(paths.dataRoot);
}

async function verifyPackagedWritableRoot(root: string): Promise<void> {
  const probePath = join(root, `.readable-studio-write-test-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probePath, "", { flag: "wx" });
    await rm(probePath, { force: true });
  } catch (error) {
    await rm(probePath, { force: true }).catch(() => undefined);
    const [diagnostic, parentDiagnostic] = await Promise.all([
      inspectPath(root),
      inspectPath(dirname(root)),
    ]);
    throw new PackagedPathAccessError(
      formatWritablePathError({
        attemptedPath: root,
        currentUser: userInfo().username,
        diagnostic,
        error,
        parentDiagnostic,
      }),
      { cause: error },
    );
  }
}

// @dsp func-230150b6
export async function ensurePackagedNamespacePaths(
  paths: PackagedNamespacePaths,
): Promise<void> {
  const writableRoots = [
    paths.installationRoot,
    paths.namespaceRoot,
    paths.cacheRoot,
    paths.dataRoot,
    paths.logsRoot,
    paths.desktopLogsRoot,
    paths.runtimeRoot,
    paths.electronUserDataRoot,
    paths.electronSessionDataRoot,
  ];
  for (const root of writableRoots) await verifyPackagedWritableRoot(root);
}

// @dsp func-3debd19d
async function writePackagedStartupLog(paths: PackagedNamespacePaths, message: string): Promise<void> {
  const logDir = dirname(paths.desktopLogPath);
  await mkdir(logDir, { recursive: true });
  await appendFile(join(logDir, "startup.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
}

export async function inspectExistingPackagedDesktop(
  namespace: string,
  options: {
    logger?: PackagedLaunchLogger;
    paths: PackagedNamespacePaths;
    requestIpc?: typeof requestJsonIpc;
  },
): Promise<PackagedExistingDesktopGateResult> {
  const logger = options.logger ?? console;
  const requestIpc = options.requestIpc ?? requestJsonIpc;
  const ipcPath = resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: SIDECAR_CONTRACT, namespace });
  let status: DesktopStatusSnapshot | null = null;
  try {
    status = await requestIpc<DesktopStatusSnapshot>(
      ipcPath,
      { type: SIDECAR_MESSAGES.STATUS },
      { timeoutMs: 350 },
    );
  } catch (error) {
    const message = `inspect-unavailable namespace=${namespace} action=continue error=${error instanceof Error ? error.message : String(error)}`;
    await writePackagedStartupLog(options.paths, message);
    logger.info?.(`[readable-studio startup] ${message}`);
    return { action: "continue", reason: "inspect-failed" };
  }

  if (status.state !== "running") {
    await writePackagedStartupLog(options.paths, `inspect-not-running namespace=${namespace} state=${status.state}`);
    return { action: "continue", reason: "not-running" };
  }

  try {
    await requestIpc(ipcPath, { type: SIDECAR_MESSAGES.SHOW }, { timeoutMs: 800 });
    await writePackagedStartupLog(options.paths, `inspect-found-existing namespace=${namespace} focus=accepted`);
    return { action: "exit", reason: "existing-focused" };
  } catch (error) {
    const message = `inspect-found-existing namespace=${namespace} focus=failed error=${error instanceof Error ? error.message : String(error)}`;
    await writePackagedStartupLog(options.paths, message);
    logger.warn(`[readable-studio startup] ${message}`);
    return { action: "exit", reason: "existing-focus-failed" };
  }
}

export function applyPackagedElectronPathOverrides(
  paths: Pick<PackagedNamespacePaths, "cacheRoot" | "desktopLogsRoot" | "electronSessionDataRoot" | "electronUserDataRoot">,
): void {
  app.setPath("userData", paths.electronUserDataRoot);
  app.setPath("sessionData", paths.electronSessionDataRoot);
  app.setPath("logs", paths.desktopLogsRoot);
  app.setPath("cache", paths.cacheRoot);

  // Chromium child processes do not reliably expose Electron's setPath values
  // in their launch contract. Pin both profile and cache explicitly so GPU and
  // network-service children can never fall back to the OS user profile.
  app.commandLine.appendSwitch("user-data-dir", paths.electronUserDataRoot);
  app.commandLine.appendSwitch("disk-cache-dir", paths.cacheRoot);
  // Hold Chromium behind a local discard endpoint until the desktop is ready.
  // releasePackagedElectronNetworking restores the system proxy at that point.
  app.commandLine.appendSwitch("proxy-server", "127.0.0.1:9");

  // Suppress Chromium-owned background traffic while leaving the network
  // service available for explicit user actions and product API requests.
  for (const commandSwitch of [
    "disable-background-networking",
    "disable-breakpad",
    "disable-client-side-phishing-detection",
    "disable-component-extensions-with-background-pages",
    "disable-component-update",
    "disable-default-apps",
    "disable-domain-reliability",
    "disable-sync",
    "disable-spell-checking",
    "metrics-recording-only",
    "no-first-run",
    "no-pings",
  ]) {
    app.commandLine.appendSwitch(commandSwitch);
  }
  app.commandLine.appendSwitch(
    "disable-features",
    "AutofillServerCommunication,CertificateTransparencyComponentUpdater,MediaRouter,OptimizationHints,Translate",
  );
}

export async function releasePackagedElectronNetworking(electronSession: {
  setProxy: (config: { mode: "system" }) => Promise<unknown>;
  setSpellCheckerEnabled: (enabled: boolean) => void;
}): Promise<void> {
  electronSession.setSpellCheckerEnabled(false);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await electronSession.setProxy({ mode: "system" });
      return;
    } catch (error) {
      if (attempt < maxAttempts) continue;
      const reason = error instanceof Error ? error.message : String(error);
      throw new PackagedNetworkingRestoreError(
        `Readable Studio could not restore system networking after ${maxAttempts} attempts: ${reason}. Relaunch Readable Studio to retry.`,
        { cause: error },
      );
    }
  }
}

// @dsp func-a5f43a0f
export function claimPackagedSingleInstanceLock(
  electronApp: PackagedSingleInstanceApp,
  onSecondInstance: () => void,
): boolean {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }
  electronApp.on("second-instance", () => {
    onSecondInstance();
  });
  return true;
}
