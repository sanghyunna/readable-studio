import { randomBytes } from "node:crypto";
import {
  APP_KEYS,
  SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type SidecarStamp,
} from "@readable-studio/sidecar-proto";
import {
  bootstrapSidecarRuntime,
  createSidecarLaunchEnv,
  resolveAppIpcPath,
} from "@readable-studio/sidecar";
import {
  applyOsLocaleSwitch,
  consumeDesktopApprovalToken,
  createSplashWindow,
  startCrashEvidence,
} from "@readable-studio/desktop/main";
import { addLoopbackNoProxyEnv, readProcessStamp } from "@readable-studio/platform";
import { join } from "node:path";
import { app, dialog, session } from "electron";

import { readPackagedConfig, resolveEarlyPackagedElectronPaths, resolvePortableTopFolder } from "./config.js";
import { acquireDataLock, PackagedDataLockAccessError, PackagedDataLockError } from './data-lock.js';
import { runPendingDataImport } from './data-import.js';
import { createStartupNoticeState, detectOneDriveLocation, readOneDriveKnownFolder } from './onedrive.js';
import { writePackagedDesktopIdentity } from "./identity.js";
import { PackagedNetworkingRestoreError, PackagedPathAccessError } from "./errors.js";
import {
  applyPackagedElectronPathOverrides,
  claimPackagedSingleInstanceLock,
  ensurePackagedNamespacePaths,
  inspectExistingPackagedDesktop,
  releasePackagedElectronNetworking,
} from "./launch.js";
import {
  attachPackagedDesktopProcessLogging,
  createPackagedDesktopLogger,
  type PackagedDesktopLogger,
} from "./logging.js";
import { resolvePackagedNamespacePaths } from "./paths.js";
import { packagedEntryUrl, registerReadableStudioProtocol } from "./protocol.js";
import { startPackagedSidecars, type PackagedSidecarHandle } from "./sidecars.js";
import { createPackagedStartupPhaseTimer } from "./startup-timing.js";
import { writeUpdateReadyReceipt } from './update-ready.js';

const startupArgvStamp = readProcessStamp(process.argv.slice(1), SIDECAR_CONTRACT);
const earlyElectronPaths = resolveEarlyPackagedElectronPaths(startupArgvStamp?.namespace);
if (earlyElectronPaths != null) applyPackagedElectronPathOverrides(earlyElectronPaths);

let packagedLogger: PackagedDesktopLogger | null = null;
let pendingSecondInstanceFocus = false;
let showExistingDesktop: (() => void) | null = null;
let flushStartupTimingOnFailure: (() => void) | null = null;

function createPackagedDesktopStamp(namespace: string): SidecarStamp {
  return {
    app: APP_KEYS.DESKTOP,
    ipc: resolveAppIpcPath({
      app: APP_KEYS.DESKTOP,
      contract: SIDECAR_CONTRACT,
      namespace,
    }),
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  };
}

function applyLaunchEnv(base: string, stamp: SidecarStamp): void {
  const env = createSidecarLaunchEnv({
    base,
    contract: SIDECAR_CONTRACT,
    stamp,
  });

  for (const [key, value] of Object.entries(env)) {
    if (value != null) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  consumeDesktopApprovalToken(process.env);
  process.env[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN] = randomBytes(32).toString("base64url");
  const desktopApprovalToken = consumeDesktopApprovalToken(process.env);
  if (!desktopApprovalToken) throw new Error("failed to mint desktop approval bearer");
  const startupTiming = createPackagedStartupPhaseTimer({ buffer: true });
  flushStartupTimingOnFailure = startupTiming.flush;

  // Must run BEFORE `app.whenReady()` below, because Chromium consumes
  // `--lang` at session bootstrap. Doing it here lets the packaged
  // renderer's `navigator.language` follow the OS instead of Chromium's
  // en-US default. runDesktopMain (called later) calls the same helper
  // again to recover the resolved locale string for the BrowserWindow.
  app.setName("Readable Studio");
  applyOsLocaleSwitch(app);
  addLoopbackNoProxyEnv(process.env);

  const config = await readPackagedConfig();
  startupTiming.mark("config-read-complete");
  const argvStamp = startupArgvStamp;
  const namespace = argvStamp?.namespace ?? config.namespace;
  const activeConfig = namespace === config.namespace ? config : { ...config, namespace };
  const paths = resolvePackagedNamespacePaths(activeConfig, namespace, process.env);
  if (earlyElectronPaths == null) applyPackagedElectronPathOverrides(paths);
  await ensurePackagedNamespacePaths(paths);
  const dataLock = acquireDataLock(paths.dataRoot, {
    pid: process.pid, appVersion: activeConfig.appVersion, exePath: process.execPath, startedAt: new Date().toISOString(),
  });
  app.once('quit', dataLock.release);
  let oneDrive = detectOneDriveLocation(process.execPath, process.env);
  if (!oneDrive) {
    try { oneDrive = detectOneDriveLocation(process.execPath, process.env, readOneDriveKnownFolder()); }
    catch (error) { console.warn('OneDrive known-folder detection failed; startup will continue', error); }
  }
  if (oneDrive) console.info(`OneDrive startup detection: source=${oneDrive.source} root=${oneDrive.root}`);
  const startupNotice = createStartupNoticeState(paths.dataRoot, oneDrive);
  const existingDesktop = await inspectExistingPackagedDesktop(namespace, {
    logger: console,
    paths,
  });
  if (existingDesktop.action === "exit") {
    dataLock.release();
    startupTiming.flush();
    flushStartupTimingOnFailure = null;
    return;
  }
  startupTiming.mark("packaged-paths-resolved");
  const stamp = argvStamp ?? createPackagedDesktopStamp(namespace);

  packagedLogger = createPackagedDesktopLogger(paths);
  attachPackagedDesktopProcessLogging({
    descriptor: activeConfig.descriptor,
    logger: packagedLogger,
    paths,
    stamp,
  });
  startupTiming.flush();
  flushStartupTimingOnFailure = null;
  if (!claimPackagedSingleInstanceLock(app, () => {
    if (showExistingDesktop == null) {
      pendingSecondInstanceFocus = true;
      return;
    }
    showExistingDesktop();
  })) {
    dataLock.release();
    return;
  }
  // One-time import of an older extract folder's data. It must finish before
  // the daemon opens the database, and only once this instance is known to be
  // the sole owner of the data root. Unexpected rollback errors propagate on
  // purpose: continuing would initialise a blank root over a half-imported one.
  const dataImport = await runPendingDataImport({
    dataRoot: paths.dataRoot,
    appRoot: resolvePortableTopFolder(),
    resourceRoot: paths.resourceRoot,
    onRestartRequested: () => {
      app.relaunch({ execPath: join(resolvePortableTopFolder(), "Readable Studio.exe") });
      app.quit();
    },
  });
  app.once("will-quit", dataImport.stopWatching);
  if (dataImport.status !== "none") console.info(`Data import on startup: ${dataImport.status}`);
  const identity = await writePackagedDesktopIdentity({ descriptor: activeConfig.descriptor, paths, stamp });
  const crashEvidence = startCrashEvidence(app, paths.namespaceRoot, process.env.READABLE_LOCAL_NATIVE_DUMPS === "1");
  await app.whenReady();

  // Show the brand splash IMMEDIATELY, before we await the daemon/web sidecars
  // below. Cold boot otherwise leaves the user staring at no window at all for
  // the few seconds the sidecars take to come up; putting the animation on
  // screen in parallel masks that gap, and the runtime keeps it up until the
  // real app has mounted (see createDesktopRuntime). The handle carries the
  // creation timestamp so the runtime's minimum-hold timer counts from here —
  // BEFORE the sidecar boot below — rather than re-adding the delay afterwards.
  const splash = createSplashWindow();

  applyLaunchEnv(paths.runtimeRoot, stamp);

  const runtime = bootstrapSidecarRuntime(stamp, process.env, {
    app: APP_KEYS.DESKTOP,
    base: paths.runtimeRoot,
    contract: SIDECAR_CONTRACT,
  });

  let sidecars: PackagedSidecarHandle;
  for (;;) {
    try {
      sidecars = await startPackagedSidecars(runtime, paths, {
        appVersion: activeConfig.appVersion,
        amrProfile: activeConfig.amrProfile,
        daemonCliEntry: activeConfig.daemonCliEntry,
        daemonSidecarEntry: activeConfig.daemonSidecarEntry,
        desktopApprovalToken,
        nodeCommand: activeConfig.nodeCommand,
        pathsAlreadyEnsured: true,
        requireDesktopAuth: true,
        webSidecarEntry: activeConfig.webSidecarEntry,
        webStandaloneRoot: activeConfig.webStandaloneRoot,
        webOutputMode: activeConfig.webOutputMode,
        logStartupPhase: startupTiming.mark,
      });
      break;
    } catch (error) {
      packagedLogger?.error('sidecar startup failed', { error });
      const korean = app.getLocale().toLowerCase().startsWith('ko');
      const { response } = await dialog.showMessageBox(splash.window, {
        type: 'error',
        title: 'Readable Studio',
        message: korean
          ? '데이터를 여는 중 문제가 발생했습니다. 데이터는 안전합니다.'
          : 'There was a problem opening your data. Your data is safe.',
        detail: korean
          ? `데몬을 시작하지 못했습니다. 다시 시도하거나 로그를 확인하세요: ${paths.logsRoot}`
          : `The daemon could not start. Retry or check the logs: ${paths.logsRoot}`,
        buttons: korean ? ['다시 시도', '종료'] : ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) throw error;
    }
  }
  registerReadableStudioProtocol(sidecars.web.url ?? "http://127.0.0.1:0", startupNotice);

  const { runDesktopMain } = await import("@readable-studio/desktop/main");
  startupTiming.mark("desktop-main-handoff");
  await runDesktopMain(runtime, {
    crashEvidence,
    credentialDataRoot: paths.dataRoot,
    desktopApprovalToken,
    splashWindow: splash.window,
    splashStartedAt: splash.startedAt,
    async beforeShutdown() {
      try {
        await sidecars.close();
      } finally {
        await identity.close();
      }
    },
    async discoverWebUrl() {
      return packagedEntryUrl();
    },
    // Round-7 (lefarcen P2 @ runtime.ts:336): packaged main-process
    // fetch targets the daemon sidecar's real http URL — never the
    // readable-studio://app/ renderer URL, which Node/undici cannot resolve through
    // Electron's protocol handler.
    async discoverDaemonUrl() {
      return sidecars.daemon.url;
    },
    async onDesktopReady(controls) {
      await releasePackagedElectronNetworking(session.defaultSession);
      await writeUpdateReadyReceipt(activeConfig.appVersion);
      showExistingDesktop = controls.show;
      if (!pendingSecondInstanceFocus) return;
      pendingSecondInstanceFocus = false;
      controls.show();
    },
    appVersion: activeConfig.appVersion,
    preloadPath: join(app.getAppPath(), "preload.cjs"),
  });
}

void main().catch((error: unknown) => {
  flushStartupTimingOnFailure?.();
  flushStartupTimingOnFailure = null;
  if (error instanceof PackagedPathAccessError || error instanceof PackagedNetworkingRestoreError || error instanceof PackagedDataLockError || error instanceof PackagedDataLockAccessError) {
    try {
      dialog.showErrorBox(error.title, error.message);
    } catch (dialogError) {
      console.error('Could not display packaged startup failure', dialogError);
    }
  }
  packagedLogger?.error("packaged runtime failed", { error });
  console.error("packaged runtime failed", error);
  process.exit(1);
});
