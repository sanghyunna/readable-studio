import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { request as createHttpRequest } from 'node:http';
import { request as createHttpsRequest } from 'node:https';
import { basename, delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  APP_KEYS,
  SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  normalizeRuntimeDescriptor,
  RuntimeDescriptorError,
  type AppKey,
  type DaemonStatusSnapshot,
  type SidecarStamp,
  type WebStatusSnapshot,
} from "@readable-studio/sidecar-proto";
import {
  allocatePort,
  createSidecarLaunchEnv,
  requestJsonIpc,
  resolveAppIpcPath,
  type SidecarRuntimeContext,
} from "@readable-studio/sidecar";
import {
  addLoopbackNoProxyEnv,
  createProcessStampArgs,
  mergeProxyAwareEnv,
  resolveSystemProxyEnv,
  collectProcessTreePids,
  wellKnownUserToolchainBins,
} from "@readable-studio/platform";

import { isPortableAppLayout, resolvePortableTopFolder, type PackagedWebOutputMode } from "./config.js";
import type { PackagedNamespacePaths } from "./paths.js";
import { PackagedDaemonStoppedError, parsePackagedDatabaseRefusal } from './errors.js';
import {
  createPackagedStartupPhaseTimer,
  type PackagedStartupPhaseLogger,
} from "./startup-timing.js";

const require = createRequire(import.meta.url);

export async function checkPackagedDaemonHealth(url: string): Promise<void> {
  const target = new URL('/api/health', url);
  const request = target.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
  const health: unknown = await new Promise((resolve, reject) => {
    // Internal health traffic must not inherit an env-aware global agent.
    const probe = request(target, { agent: false, signal: AbortSignal.timeout(1_500) }, (response) => {
      response.on('error', reject);
      if (response.statusCode == null || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    probe.on('error', reject);
    probe.end();
  });
  if (typeof health !== 'object' || health === null || Reflect.get(health, 'ok') !== true) {
    throw new Error('invalid health response');
  }
}
const PACKAGED_CHILD_ENV_ALLOWLIST = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "ALL_PROXY",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "TMPDIR",
  "USER",
  "VP_HOME",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

// These are daemon-only: they let Windows resolve the WinGet executable and
// let the CLI locate its profile-based configuration without exposing either
// concern to the web sidecar.
const PACKAGED_DAEMON_WINDOWS_CLI_ENV_ALLOWLIST = [
  "DATABRICKS_CONFIG_FILE",
  "LOCALAPPDATA",
  "PATHEXT",
  "SYSTEMROOT",
  "USERPROFILE",
] as const;

function shouldForwardPackagedChildEnv(key: string, includeProviderSecrets = false): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey === SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN) return false;
  if (PACKAGED_CHILD_ENV_ALLOWLIST.some((allowedKey) => allowedKey === normalizedKey)) {
    return true;
  }
  if (!includeProviderSecrets) return false;
  if (
    PACKAGED_DAEMON_WINDOWS_CLI_ENV_ALLOWLIST.includes(
      normalizedKey as (typeof PACKAGED_DAEMON_WINDOWS_CLI_ENV_ALLOWLIST)[number],
    )
  ) {
    return true;
  }
  return (
    !normalizedKey.startsWith("DATABRICKS_") &&
    (key.endsWith("_API_KEY") || key.endsWith("_TOKEN"))
  );
}

export type PackagedSidecarHandle = {
  close(): Promise<void>;
  daemon: DaemonStatusSnapshot;
  web: WebStatusSnapshot;
};

type ManagedSidecarChild = {
  app: AppKey;
  child: ChildProcess;
  ipcPath: string;
  logHandle: FileHandle;
  logPath: string;
};

type PackagedDaemonManagedPathEnv = {
  READABLE_DATA_DIR: string;
  READABLE_RESOURCE_ROOT: string;
  /**
   * Channel-root path. Lives one level above the namespaces directory so
   * the daemon can persist installationId (and any future fields that
   * must outlive a namespace-scoped data-dir reset) outside the
   * `<namespace>/data/` subtree.
   *
   * Required so installation-scoped state survives a reinstall of the same
   * channel even when the baked namespace token changes or per-namespace data
   * is cleared. See `apps/daemon/src/installation.ts`.
   */
  READABLE_INSTALLATION_DIR: string;
};

function resolveSidecarEntry(packageName: string, exportName: string): string {
  return require.resolve(`${packageName}/${exportName}`);
}

function logPathFor(paths: PackagedNamespacePaths, app: AppKey): string {
  return join(paths.logsRoot, app, "latest.log");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// @dsp func-10c3c334
export async function resolvePackagedElectronNodeCommand(
  execPath = process.execPath,
  platform = process.platform,
): Promise<string> {
  if (platform !== "darwin") return execPath;

  const executableName = execPath.split("/").pop();
  if (executableName == null || executableName.length === 0) return execPath;

  const marker = "/Contents/MacOS/";
  const markerIndex = execPath.lastIndexOf(marker);
  if (markerIndex === -1) return execPath;

  const appPath = execPath.slice(0, markerIndex);
  const helperName = `${executableName} Helper`;
  const helperPath = join(
    appPath,
    "Contents",
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName,
  );

  return (await pathExists(helperPath)) ? helperPath : execPath;
}

async function openLog(path: string, append: boolean): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true });
  return await open(path, append ? 'a' : 'w');
}

const DAEMON_STATUS_TIMEOUT_MS = 180_000;

/**
 * Cold extraction/antivirus scans and loaded warm relaunches can delay the
 * daemon before IPC exists. Match the web's bounded three-minute splash budget;
 * an exited child still fails immediately. Invalid overrides use the default.
 */
export function resolveDaemonStatusTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.READABLE_DAEMON_STATUS_TIMEOUT_MS;
  if (raw != null && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DAEMON_STATUS_TIMEOUT_MS;
}

const WEB_STATUS_TIMEOUT_MS = 180_000;

/**
 * Web sidecar status wait budget for the packaged launcher.
 *
 * The web sidecar (apps/web/sidecar/server.ts) has its own internal
 * readiness budget (120s) for cold first-boot standalone Next.js
 * compiles. The launcher must wait strictly longer than that internal
 * budget, otherwise it gives up first and the sidecar's longer budget
 * is wasted. The default 180s leaves headroom above the 120s internal
 * window. `READABLE_WEB_STATUS_TIMEOUT_MS` overrides it for tuning; an
 * absent, non-numeric, or non-positive value falls back to the default.
 */
// @dsp func-d6d6f242
export function resolveWebStatusTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.READABLE_WEB_STATUS_TIMEOUT_MS;
  if (raw != null && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return WEB_STATUS_TIMEOUT_MS;
}

/**
 * Waits for the sidecar to report a ready status over IPC.
 *
 * When `watch` is provided, the polling loop also races the spawned
 * child's `exit` event so a daemon that throws at startup surfaces
 * immediately instead of leaving the packaged app waiting for a process
 * that already exited. The error message includes the daemon log path
 * so the user can read the actual failure reason.
 */
// @dsp func-35359063
export async function waitForStatus<T extends object>(
  ipcPath: string,
  isReady: (status: T) => boolean,
  timeoutMs = DAEMON_STATUS_TIMEOUT_MS,
  watch: { child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void; off: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void }; logPath: string; label?: string } | null = null,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  let childExited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // Cover the race between spawn-resolved and now: if the child has
  // already exited by the time we got here, the 'exit' event is gone,
  // so seed childExited from the synchronous status fields.
  if (watch != null && watch.child.exitCode !== null) {
    childExited = { code: watch.child.exitCode, signal: watch.child.signalCode };
  }

  const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    childExited = { code, signal };
  };
  watch?.child.once('exit', onChildExit);

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (childExited !== null) {
        throw new Error(
          `${watch?.label ?? 'daemon'} exited before reporting status (code=${childExited.code}, signal=${childExited.signal ?? 'none'}); see ${watch?.logPath ?? '<no log path>'} for details`,
        );
      }
      try {
        const status = await requestJsonIpc<T>(
          ipcPath,
          { type: SIDECAR_MESSAGES.STATUS },
          { timeoutMs: 800 },
        );
        normalizeRuntimeDescriptor(Reflect.get(status, "descriptor"));
        if (isReady(status)) {
          if (watch?.child.pid != null && Reflect.get(status, 'pid') !== watch.child.pid) {
            throw new Error(`${watch.label ?? 'daemon'} status pid does not match spawned child pid`);
          }
          if (childExited !== null || watch?.child.exitCode != null || watch?.child.signalCode != null) {
            throw new Error(`${watch?.label ?? 'daemon'} exited while reporting ready status`);
          }
          return status;
        }
      } catch (error) {
        if (error instanceof RuntimeDescriptorError || (error instanceof Error && /status pid does not match|exited while reporting ready/.test(error.message))) throw error;
        lastError = error;
      }
      await sleep(150);
    }

    throw new Error(
      `timed out waiting for sidecar status at ${ipcPath}${
        lastError instanceof Error ? ` (${lastError.message})` : ""
      }`,
    );
  } finally {
    watch?.child.off('exit', onChildExit);
  }
}

// Hardcoded POSIX system bins the packaged daemon must always be able to
// reach even when the inherited PATH from launchd / a desktop launcher is
// stripped down to nothing. The user-toolchain portion of the search list
// (Homebrew, npm globals, nvm/fnm/mise, cargo, ...) lives in
// @readable-studio/platform's wellKnownUserToolchainBins so the daemon
// resolver and this PATH builder cannot drift again. See issue #442.
const PACKAGED_POSIX_SYSTEM_BINS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const PACKAGED_SYSTEM_PROXY_CACHE_KEY = "packaged-child-base-env";

// @dsp func-0ade3abd
export function resolvePackagedPathEnv(basePath = process.env.PATH ?? ""): string {
  const candidates = [
    ...basePath.split(delimiter),
    ...wellKnownUserToolchainBins(),
    ...PACKAGED_POSIX_SYSTEM_BINS,
  ];
  return [...new Set(candidates.filter((entry) => entry.length > 0))].join(delimiter);
}

// @dsp func-cefc831b
export function resolvePackagedChildBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeProviderSecrets = false,
  systemProxyEnv?: NodeJS.ProcessEnv,
  includeSystemProxyEnv = true,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const forwardedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value.length > 0 && shouldForwardPackagedChildEnv(key, includeProviderSecrets)) {
      forwardedEnv[key] = value;
    }
  }
  const merged = includeSystemProxyEnv
    ? mergeProxyAwareEnv(
      platform,
      systemProxyEnv ?? resolveSystemProxyEnv({ cacheKey: PACKAGED_SYSTEM_PROXY_CACHE_KEY }),
      forwardedEnv,
    )
    : mergeProxyAwareEnv(platform, forwardedEnv);
  return addLoopbackNoProxyEnv(merged, platform);
}

function createPackagedDaemonManagedPathEnv(
  paths: PackagedNamespacePaths,
): PackagedDaemonManagedPathEnv {
  return {
    READABLE_DATA_DIR: paths.dataRoot,
    READABLE_RESOURCE_ROOT: paths.resourceRoot,
    READABLE_INSTALLATION_DIR: paths.installationRoot,
  };
}

export type PackagedDaemonSpawnEnvOptions = {
  appVersion: string | null;
  amrProfile?: string | null;
  daemonCliEntry: string | null;
  daemonPort: number;
  desktopApprovalToken?: string | null;
  /**
   * PR #974 round-5 (lefarcen P2): only pin the daemon's import-folder
   * gate ON when the desktop runtime is actually being started in the
   * same packaged process group. Headless packaged deployments have no
   * `shell.openPath` surface, so leaving the gate dormant avoids the impossible-auth
   * state where the daemon waits forever for a registration that the
   * headless runtime can never deliver.
   */
  requireDesktopAuth: boolean;
};

/**
 * Pure helper: assemble the daemon spawn env for a packaged sidecar.
 * Extracted from `startPackagedSidecars` so vitest can pin both
 * branches of `requireDesktopAuth` without spinning up a real child
 * process.
 */
// @dsp func-a37b27ff
export function buildPackagedDaemonSpawnEnv(
  paths: PackagedNamespacePaths,
  options: PackagedDaemonSpawnEnvOptions,
): NodeJS.ProcessEnv {
  return {
    [SIDECAR_ENV.DAEMON_PORT]: String(options.daemonPort),
    ...(options.desktopApprovalToken
      ? { [SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN]: options.desktopApprovalToken }
      : {}),
    ...(options.daemonCliEntry == null ? {} : { [SIDECAR_ENV.DAEMON_CLI_PATH]: options.daemonCliEntry }),
    // PR #974 round-4 P1 + round-5 P2: pinned ON when a desktop is
    // being started, OFF for headless. The daemon-side flag refuses
    // tokenless imports even before the desktop main process has
    // finished registering, closing the daemon-restart-mid-session
    // bypass that a runtime-only handshake left open. Headless skips
    // it because there is no privileged shell.openPath surface and
    // no client to register a secret.
    ...(options.requireDesktopAuth ? {
      READABLE_REQUIRE_DESKTOP_AUTH: "1",
      ...(isPortableAppLayout() ? {
        READABLE_UPDATE_ROOT: resolvePortableTopFolder(),
        READABLE_ELECTRON_MAIN_PID: String(process.pid),
      } : {}),
    } : {}),
    // Packaged daemon managed paths are deliberately delivered through
    // the sidecar launch environment. The daemon may keep its own default
    // fallback, but packaged runtime must not rely on path inference from
    // Electron userData, bundle names, or ports.
    ...createPackagedDaemonManagedPathEnv(paths),
    ...(options.amrProfile == null || options.amrProfile.length === 0
      ? {}
      : { READABLE_AMR_PROFILE: options.amrProfile }),
    ...(options.appVersion == null ? {} : { READABLE_APP_VERSION: options.appVersion }),
  };
}

async function spawnSidecarChild(options: {
  appendLog?: boolean;
  app: AppKey;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  nodeCommand: string | null;
  paths: PackagedNamespacePaths;
  runtime: SidecarRuntimeContext<SidecarStamp>;
}): Promise<ManagedSidecarChild> {
  const ipcPath = resolveAppIpcPath({
    app: options.app,
    contract: SIDECAR_CONTRACT,
    namespace: options.runtime.namespace,
  });
  const stamp = {
    app: options.app,
    ipc: ipcPath,
    mode: SIDECAR_MODES.RUNTIME,
    namespace: options.runtime.namespace,
    source: options.runtime.source,
  } satisfies SidecarStamp;
  const logPath = logPathFor(options.paths, options.app);
  const logHandle = await openLog(logPath, options.appendLog === true);
  const childEnv = createSidecarLaunchEnv({
    base: options.paths.runtimeRoot,
    contract: SIDECAR_CONTRACT,
    extraEnv: {
      ...resolvePackagedChildBaseEnv(
        process.env,
        options.app === APP_KEYS.DAEMON,
        undefined,
        options.app !== APP_KEYS.DAEMON,
      ),
      ...options.env,
      // Carry the resolved desktop stamp, not the filtered ambient environment.
      READABLE_PACKAGED_NAMESPACE: options.runtime.namespace,
      NODE_ENV: "production",
      PATH: resolvePackagedPathEnv(),
      ...(options.nodeCommand == null ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stamp,
  });
  const command = options.nodeCommand ?? (await resolvePackagedElectronNodeCommand());
  const child = spawn(
    command,
    [options.entryPath, ...createProcessStampArgs(stamp, SIDECAR_CONTRACT)],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    },
  );

  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("error", rejectSpawn);
      child.once("spawn", resolveSpawn);
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw error;
  }

  return { app: options.app, child, ipcPath, logHandle, logPath };
}

async function closeManagedChild(child: ManagedSidecarChild): Promise<void> {
  const appendLifecycleLog = async (message: string): Promise<void> => {
    await appendFile(child.logPath, `${message}\n`, "utf8").catch(() => undefined);
  };
  await appendLifecycleLog(`[readable-studio packaged] shutdown requested app=${child.app} pid=${child.child.pid ?? "unknown"}`);
  // Start the deadline before IPC, and observe exit before sending shutdown.
  const exited = new Promise<boolean>((resolve) => {
    if (child.child.exitCode !== null || child.child.signalCode !== null) { resolve(true); return; }
    const deadline = AbortSignal.timeout(2_000);
    const onTimeout = () => { child.child.off('exit', onExit); resolve(false); };
    const onExit = () => { deadline.removeEventListener('abort', onTimeout); resolve(true); };
    deadline.addEventListener('abort', onTimeout, { once: true });
    child.child.once('exit', onExit);
  });
  try {
    await requestJsonIpc(child.ipcPath, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 500 });
  } catch (error) {
    await appendLifecycleLog(`[readable-studio packaged] shutdown IPC failed app=${child.app}: ${String(error)}`);
  }

  if (!(await exited)) {
    await appendLifecycleLog(`[readable-studio packaged] shutdown timeout app=${child.app} pid=${child.child.pid ?? "unknown"}; forcing tree stop`);
    const pid = child.child.pid!;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 1_000 }, (error) => {
          if (!error || child.child.exitCode !== null || child.child.signalCode !== null) resolve();
          else reject(error);
        });
      });
    } else {
      const listing = await new Promise<string>((resolve, reject) => {
        execFile('ps', ['-eo', 'pid=,ppid='], { timeout: 1_000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const snapshots = listing.trim().split(/\r?\n/).map(command => {
        const [pid, ppid] = command.trim().split(/\s+/).map(Number);
        return { pid: pid!, ppid: ppid!, command };
      });
      const tree = collectProcessTreePids(snapshots, [pid]);
      for (const target of [...tree.filter(target => target !== pid), pid]) {
        try { process.kill(target, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  }

  await appendLifecycleLog(`[readable-studio packaged] exited app=${child.app} pid=${child.child.pid ?? "unknown"} code=${child.child.exitCode ?? "unknown"} signal=${child.child.signalCode ?? "none"}`);
  await child.logHandle.close().catch(() => undefined);
}

async function daemonLogHasPortConflict(paths: PackagedNamespacePaths): Promise<boolean> {
  const contents = await readFile(logPathFor(paths, APP_KEYS.DAEMON), "utf8").catch(() => "");
  return contents.includes("EADDRINUSE");
}

// @dsp func-cf1f0266
export async function startPackagedSidecars(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  paths: PackagedNamespacePaths,
  options: {
    appVersion: string | null;
    amrProfile: string | null;
    daemonCliEntry: string | null;
    daemonSidecarEntry: string | null;
    desktopApprovalToken: string | null;
    nodeCommand: string | null;
    pathsAlreadyEnsured: boolean;
    /**
     * PR #974 round-5 (lefarcen P2): caller asserts whether a desktop
     * runtime is being started in this packaged process group. The
     * Electron entry passes `true`; `headless.ts` passes `false` so the
     * daemon's import-folder gate stays dormant in headless mode where
     * there is no `shell.openPath` surface and no client to register a
     * secret. Required (no default) so a future packaged caller cannot
     * silently regress the gate by omitting it.
     */
    requireDesktopAuth: boolean;
    webSidecarEntry: string | null;
    webStandaloneRoot: string | null;
    webOutputMode: PackagedWebOutputMode;
    logStartupPhase?: PackagedStartupPhaseLogger;
    onDaemonFailure?: (error: PackagedDaemonStoppedError) => Promise<'retry' | 'quit'>;
  },
): Promise<PackagedSidecarHandle> {
  const localStartupTiming = options.logStartupPhase == null
    ? createPackagedStartupPhaseTimer()
    : null;
  const logStartupPhase = options.logStartupPhase ?? localStartupTiming?.mark ?? (() => undefined);

  if (!options.pathsAlreadyEnsured) {
    await mkdir(paths.namespaceRoot, { recursive: true });
    await mkdir(paths.cacheRoot, { recursive: true });
    await mkdir(paths.dataRoot, { recursive: true });
    await mkdir(paths.logsRoot, { recursive: true });
    await mkdir(paths.desktopLogsRoot, { recursive: true });
    await mkdir(paths.runtimeRoot, { recursive: true });
    await mkdir(paths.electronUserDataRoot, { recursive: true });
    await mkdir(paths.electronSessionDataRoot, { recursive: true });
    logStartupPhase("namespace-runtime-dirs-ensured");
  }

  const reservedDaemonPorts = new Set<number>();
  for (let attempt = 0; ; attempt += 1) {
    const children: ManagedSidecarChild[] = [];

    try {
      const daemonPort = (await allocatePort({
        host: "127.0.0.1",
        label: "packaged daemon",
        reserved: reservedDaemonPorts,
      })).port;
      const daemon = await spawnSidecarChild({
        app: APP_KEYS.DAEMON,
        entryPath: options.daemonSidecarEntry ?? resolveSidecarEntry("@readable-studio/daemon", "sidecar"),
        env: buildPackagedDaemonSpawnEnv(paths, {
          appVersion: options.appVersion,
          amrProfile: options.amrProfile,
          daemonCliEntry: options.daemonCliEntry,
          daemonPort,
          desktopApprovalToken: options.desktopApprovalToken,
          requireDesktopAuth: options.requireDesktopAuth,
        }),
        nodeCommand: options.nodeCommand,
        paths,
        runtime,
      });
      logStartupPhase("daemon-child-spawned");
      children.push(daemon);

      const web = await spawnSidecarChild({
        app: APP_KEYS.WEB,
        entryPath: options.webSidecarEntry ?? resolveSidecarEntry("@readable-studio/web", "sidecar"),
        env: {
          [SIDECAR_ENV.DAEMON_PORT]: String(daemonPort),
          [SIDECAR_ENV.WEB_PORT]: "0",
          ...(options.appVersion == null ? {} : { READABLE_APP_VERSION: options.appVersion }),
          ...(options.webStandaloneRoot == null ? {} : { READABLE_WEB_STANDALONE_ROOT: options.webStandaloneRoot }),
          READABLE_WEB_OUTPUT_MODE: options.webOutputMode,
          PORT: "0",
        },
        nodeCommand: options.nodeCommand,
        paths,
        runtime,
      });
      logStartupPhase("web-child-spawned");
      children.push(web);

      const [daemonStatus, webStatus] = await Promise.all([
        waitForStatus<DaemonStatusSnapshot>(
          daemon.ipcPath,
          (status) => status.url != null,
          resolveDaemonStatusTimeoutMs(),
          // Race the IPC polling against the daemon child's exit. Without
          // this, a daemon that throws at startup leaves the packaged app
          // waiting for the full status budget after the process already died.
          { child: daemon.child, logPath: logPathFor(paths, APP_KEYS.DAEMON) },
        ).then(async (status) => {
          if (status.url == null) throw new Error('daemon status has no URL');
          try {
            await checkPackagedDaemonHealth(status.url);
          } catch (error) {
            throw new Error(`daemon health check failed at ${status.url}`, { cause: error });
          }
          if (daemon.child.exitCode != null || daemon.child.signalCode != null) {
            throw new Error('daemon exited after reporting ready status');
          }
          logStartupPhase("daemon-status-ready");
          return status;
        }),
        waitForStatus<WebStatusSnapshot>(
          web.ipcPath,
          (status) => status.url != null,
          resolveWebStatusTimeoutMs(),
          // Race the IPC polling against the web child's exit, mirroring the
          // daemon wait. The default 180s budget is deliberately longer than
          // the web sidecar's 120s internal readiness window, so without the
          // exit race a web child that crashes at startup would hang the
          // launcher at the splash for the full 180s. The watch surfaces the
          // crash immediately and points at the web log for the failure.
          { child: web.child, logPath: logPathFor(paths, APP_KEYS.WEB), label: "web" },
        ).then((status) => {
          logStartupPhase("web-status-ready");
          return status;
        }),
      ]);
      if (daemonStatus.url == null) throw new Error("daemon did not report a URL");
      if (webStatus.url == null) throw new Error("web did not report a URL");

      let closePromise: Promise<void> | null = null;
      let currentDaemon = daemon;
      let recovery: Promise<void> | null = null;
      let restartAttempts = 0;
      let readySince = Date.now();
      const shutdown = new AbortController();
      const handle: PackagedSidecarHandle = {
        daemon: daemonStatus,
        web: webStatus,
        close() {
          if (closePromise != null) return closePromise;
          // Stop exit supervision before intentional shutdown, including a
          // restart already waiting for its backoff or ready status.
          shutdown.abort();
          currentDaemon.child.off('exit', onDaemonExit);
          closePromise = (async () => {
            await Promise.all(children.map(async (child) => {
              await closeManagedChild(child).catch((error: unknown) => {
                console.error(`failed to close packaged ${child.app} sidecar`, error);
              });
            }));
            await recovery;
          })();
          return closePromise;
        },
      };
      const onDaemonExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (shutdown.signal.aborted) return;
        console.error('[readable-studio packaged] daemon exited unexpectedly', {
          pid: currentDaemon.child.pid, code, signal, namespace: runtime.namespace, dataRoot: paths.dataRoot,
        });
        if (Date.now() - readySince >= 180_000) restartAttempts = 0;
        recovery = recoverDaemon(code, signal);
      };
      const watchDaemon = (): void => {
        currentDaemon.child.once('exit', onDaemonExit);
        // Exit may have happened between the final health check and installing
        // the lifetime listener. Synchronous child fields close that gap.
        if (currentDaemon.child.exitCode != null || currentDaemon.child.signalCode != null) {
          currentDaemon.child.off('exit', onDaemonExit);
          onDaemonExit(currentDaemon.child.exitCode, currentDaemon.child.signalCode);
        }
      };
      async function recoverDaemon(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
        let cause: unknown = new Error(`daemon exited (code=${code}, signal=${signal ?? 'none'})`);
        while (!shutdown.signal.aborted) {
          if (restartAttempts >= 3) {
            const error = new PackagedDaemonStoppedError({ cause });
            console.error('[readable-studio packaged] daemon restart attempts exhausted', { error: error.message });
            const decision = await options.onDaemonFailure?.(error);
            if (shutdown.signal.aborted || decision !== 'retry') return;
            restartAttempts = 0;
          }
          const backoff = 1_000 * 2 ** restartAttempts++;
          try {
            await sleep(backoff, undefined, { signal: shutdown.signal });
          } catch (error) {
            if (shutdown.signal.aborted) return;
            throw error;
          }
          try {
            await currentDaemon.logHandle.close();
            // The web proxy keeps its original upstream. Reuse the same port,
            // stamp and managed roots; never allocate a new namespace or port.
            currentDaemon = await spawnSidecarChild({
              appendLog: true,
              app: APP_KEYS.DAEMON,
              entryPath: options.daemonSidecarEntry ?? resolveSidecarEntry('@readable-studio/daemon', 'sidecar'),
              env: buildPackagedDaemonSpawnEnv(paths, {
                appVersion: options.appVersion, amrProfile: options.amrProfile,
                daemonCliEntry: options.daemonCliEntry, daemonPort,
                desktopApprovalToken: options.desktopApprovalToken, requireDesktopAuth: options.requireDesktopAuth,
              }),
              nodeCommand: options.nodeCommand, paths, runtime,
            });
            children[0] = currentDaemon;
            if (shutdown.signal.aborted) { await closeManagedChild(currentDaemon); return; }
            const status = await waitForStatus<DaemonStatusSnapshot>(
              currentDaemon.ipcPath, status => status.url != null,
              Math.min(resolveDaemonStatusTimeoutMs(), 30_000),
              { child: currentDaemon.child, logPath: currentDaemon.logPath },
            );
            await checkPackagedDaemonHealth(status.url!);
            if (shutdown.signal.aborted) return;
            handle.daemon = status;
            readySince = Date.now();
            console.info('[readable-studio packaged] daemon restarted', {
              pid: status.pid, attempt: restartAttempts, namespace: runtime.namespace, dataRoot: paths.dataRoot,
            });
            watchDaemon();
            logStartupPhase('daemon-restart-ready');
            return;
          } catch (error) {
            cause = error;
            console.error('[readable-studio packaged] daemon restart failed', { attempt: restartAttempts, error: String(error) });
            await closeManagedChild(currentDaemon);
          }
        }
      }
      watchDaemon();
      return handle;
    } catch (error) {
      for (const child of [...children].reverse()) {
        await closeManagedChild(child).catch(() => undefined);
      }
      const daemonChild = children.find((child) => child.app === APP_KEYS.DAEMON);
      if (daemonChild != null) {
        const log = await readFile(daemonChild.logPath, 'utf8');
        const refusal = parsePackagedDatabaseRefusal(log, daemonChild.child.pid);
        if (refusal != null) {
          refusal.cause = error;
          throw refusal;
        }
      }
      if (
        attempt === 0 &&
        children.some((child) => child.app === APP_KEYS.DAEMON) &&
        await daemonLogHasPortConflict(paths)
      ) {
        continue;
      }
      throw error;
    }
  }
}
