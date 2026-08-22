import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Menu, app, dialog, globalShortcut, shell, type MenuItemConstructorOptions } from "electron";

import {
  APP_KEYS,
  SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  createRuntimeDescriptor,
  normalizeDesktopSidecarMessage,
  type DesktopClickInput,
  type DesktopEvalInput,
  type DesktopExportPdfInput,
  type DesktopScreenshotInput,
  type DaemonStatusSnapshot,
  type RegisterDesktopAuthResult,
  type SidecarStamp,
  type WebStatusSnapshot,
} from "@readable-studio/sidecar-proto";
import { dirname, join } from "node:path";

import {
  bootstrapSidecarRuntime,
  createJsonIpcServer,
  requestJsonIpc,
  resolveAppIpcPath,
  resolveLogFilePath,
  resolveRuntimeNamespaceRoot,
  type JsonIpcServerHandle,
  type SidecarRuntimeContext,
} from "@readable-studio/sidecar";
import { readProcessStamp } from "@readable-studio/platform";

import { createDesktopRuntime, type DesktopRuntime } from "./runtime.js";
import {
  consumeDesktopApprovalToken,
  startDesktopApprovalLoop,
  type DesktopApprovalLoop,
} from "./desktop-approval.js";
import { attachDesktopProcessErrorFilter } from "./uncaught-exception.js";
import {
  exportDiagnosticsToFile,
  registerDesktopDiagnosticsIpc,
} from "./diagnostics.js";

// Re-export pure URL-policy helpers so the packaged workspace's
// vitest can pin their behaviour without spinning up a full Electron
// runtime. They are part of the security boundary for child-window
// navigation (see `setWindowOpenHandler` in `runtime.ts`), so
// pinning them is worth the small extra surface.
export {
  // @dsp func-61a07e0c
  createSplashWindow,
  // @dsp func-8448b2fd
  isAllowedChildWindowUrl,
  // @dsp func-d62809b0
  isAllowedEmbeddedBrowserUrl,
  // @dsp func-6206bd3b
  isHttpUrl,
  // @dsp func-13f69c32
  resolveDesktopStatusUrl,
} from "./runtime.js";

export { consumeDesktopApprovalToken } from "./desktop-approval.js";

// Re-export the path-validation helpers for the same reason (#974).
// shell.openPath is privileged main-process behaviour; pinning the
// validation gate via tests is worth the extra surface.
//
// Round-5 (lefarcen P1, mrcfps) adds `pickAndImportFolder` and its
// types so the lazy-retry-on-DESKTOP_AUTH_PENDING flow is testable in
// the packaged workspace without booting Electron.
export {
  // @dsp func-1197d623
  validateExistingDirectory,
  // @dsp func-65467978
  fetchResolvedProjectDir,
  // @dsp func-89eb6361
  isOpenPathAllowedForProject,
  // @dsp func-4961fe47
  signDesktopImportToken,
  // @dsp func-bbcbdae7
  pickAndImportFolder,
  type PathValidationResult,
  type ResolvedProjectDirContext,
  type PickAndImportFolderDeps,
  type PickAndImportFolderResult,
} from "./runtime.js";

const TOOLS_DEV_PARENT_PID_ENV = SIDECAR_ENV.TOOLS_DEV_PARENT_PID;
const AMR_PROFILE_ENV_KEY = "READABLE_AMR_PROFILE";
const AMR_PROFILE_AGENT_ID = "amr";
const AMR_ENVIRONMENT_PROFILES = ["prod", "test", "local"] as const;
const APP_CONFIG_CHANGED_IPC_CHANNEL = "readable-studio:app-config-changed";
type AmrEnvironmentProfile = (typeof AMR_ENVIRONMENT_PROFILES)[number];
type DesktopAppConfigPrefs = {
  agentModels?: Record<string, { model?: string; reasoning?: string }>;
  agentCliEnv?: Record<string, Record<string, string>>;
  [key: string]: unknown;
};

/**
 * Read the OS preferred language and, when Electron has not yet
 * emitted `ready`, point Chromium's `--lang` flag at it so the
 * renderer's `navigator.language` follows the OS instead of falling
 * back to en-US. Returns the resolved BCP-47 string so callers can
 * forward it to `BrowserWindow.webPreferences.additionalArguments`
 * for the preload to expose to the renderer.
 *
 * Safe to call multiple times: `appendSwitch('lang', ...)` is a no-op
 * once `app.isReady()` is true. The packaged entry calls this once
 * before its own `whenReady` (so the switch lands) and `runDesktopMain`
 * calls it again later to recover the same string for the BrowserWindow.
 */
// @dsp func-55d1191f
export function applyOsLocaleSwitch(electronApp: Electron.App): string {
  const preferred = electronApp.getPreferredSystemLanguages?.() ?? [];
  const osLocale = preferred[0] ?? "en";
  if (!electronApp.isReady()) {
    electronApp.commandLine.appendSwitch("lang", osLocale);
  }
  return osLocale;
}

export type DesktopMainOptions = {
  beforeShutdown?: () => Promise<void>;
  /** Pre-consumed packaged bearer; tools-dev supplies it through process env. */
  desktopApprovalToken?: string | null;
  discoverWebUrl?: () => Promise<string | null>;
  /**
   * Round-7 (lefarcen P2 @ runtime.ts:336): packaged builds report the
   * renderer URL (`readable-studio://app/`) over `discoverWebUrl`, but Node-side
   * fetch can't resolve a custom Electron protocol. Optional. When
   * provided, runtime API calls (`/api/import/folder`,
   * `/api/projects/:id`) target this URL instead. tools-dev callers
   * omit it because their web URL IS already an http://127.0.0.1 URL
   * Node fetch can hit.
   */
  discoverDaemonUrl?: () => Promise<string | null>;
  preloadPath?: string;
  onDesktopReady?: (controls: { show(): void }) => Promise<void> | void;
  /**
   * Optional pre-created splash window. The packaged entry creates it before
   * awaiting the daemon/web sidecars so the brand animation overlaps the cold
   * boot; forwarded straight to the runtime, which owns closing it once the
   * main window is revealed. Omitted by tools-dev (the runtime makes its own).
   */
  splashWindow?: BrowserWindow | null;
  /** Creation time of `splashWindow` (from `createSplashWindow().startedAt`), so
   * the runtime measures the minimum splash hold from when it actually appeared. */
  splashStartedAt?: number;
  appVersion?: string | null;
};

function isDirectEntry(): boolean {
  const entryPath = process.argv[1];
  if (entryPath == null || entryPath.length === 0 || entryPath.startsWith("--")) return false;

  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function attachParentMonitor(stop: () => Promise<void>): void {
  const parentPid = Number(process.env[TOOLS_DEV_PARENT_PID_ENV]);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    void stop().finally(() => process.exit(0));
  }, 1000);
  timer.unref();
}

function createWebDiscovery(runtime: SidecarRuntimeContext<SidecarStamp>): () => Promise<string | null> {
  return async () => {
    const webIpc = resolveAppIpcPath({
      app: APP_KEYS.WEB,
      contract: SIDECAR_CONTRACT,
      namespace: runtime.namespace,
    });
    const web = await requestJsonIpc<WebStatusSnapshot>(webIpc, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 600 }).catch(() => null);
    return web?.url ?? null;
  };
}

function createDaemonDiscovery(runtime: SidecarRuntimeContext<SidecarStamp>): () => Promise<string | null> {
  return async () => {
    const daemonIpc = resolveAppIpcPath({
      app: APP_KEYS.DAEMON,
      contract: SIDECAR_CONTRACT,
      namespace: runtime.namespace,
    });
    const daemon = await requestJsonIpc<DaemonStatusSnapshot>(
      daemonIpc,
      { type: SIDECAR_MESSAGES.STATUS },
      { timeoutMs: 600 },
    ).catch(() => null);
    return daemon?.url ?? null;
  };
}

// @dsp func-d3c9ddb5
export function normalizeAmrEnvironmentProfile(profile: unknown): AmrEnvironmentProfile {
  if (typeof profile !== "string") return "prod";
  const trimmed = profile.trim();
  return AMR_ENVIRONMENT_PROFILES.includes(trimmed as AmrEnvironmentProfile)
    ? (trimmed as AmrEnvironmentProfile)
    : "prod";
}

// @dsp func-36530bea
export function mergeAmrEnvironmentProfileConfig(
  config: DesktopAppConfigPrefs,
  profile: AmrEnvironmentProfile,
): DesktopAppConfigPrefs {
  if (!AMR_ENVIRONMENT_PROFILES.includes(profile)) {
    throw new Error(`Unsupported AMR Environment Profile: ${String(profile)}`);
  }
  const currentProfile = normalizeAmrEnvironmentProfile(
    config.agentCliEnv?.[AMR_PROFILE_AGENT_ID]?.[AMR_PROFILE_ENV_KEY],
  );
  const shouldClearAmrModel = currentProfile !== profile;
  const hadAmrModel =
    shouldClearAmrModel && Object.prototype.hasOwnProperty.call(config.agentModels ?? {}, AMR_PROFILE_AGENT_ID);
  const nextAgentModels = { ...(config.agentModels ?? {}) };
  if (shouldClearAmrModel) {
    delete nextAgentModels[AMR_PROFILE_AGENT_ID];
  }
  return {
    ...config,
    ...(Object.keys(nextAgentModels).length > 0
      ? { agentModels: nextAgentModels }
      : hadAmrModel
        ? { agentModels: {} }
        : {}),
    agentCliEnv: {
      ...(config.agentCliEnv ?? {}),
      [AMR_PROFILE_AGENT_ID]: {
        ...(config.agentCliEnv?.[AMR_PROFILE_AGENT_ID] ?? {}),
        [AMR_PROFILE_ENV_KEY]: profile,
      },
    },
  };
}

// @dsp func-10bbc745
export function createAmrEnvironmentProfileMenuItems(
  selectedProfile: AmrEnvironmentProfile,
  onSelect: (profile: AmrEnvironmentProfile) => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "AMR Profile",
      submenu: AMR_ENVIRONMENT_PROFILES.map((profile) => ({
        label: profile,
        type: "radio" as const,
        checked: selectedProfile === profile,
        click: () => onSelect(profile),
      })),
    },
  ];
}

// @dsp func-5fd08ae0
export function resolveAboutPanelVersion(options: DesktopMainOptions): string | null {
  const version = options.appVersion?.trim();
  return version == null || version.length === 0 ? null : version;
}

function configureAboutPanel(options: DesktopMainOptions): void {
  const version = resolveAboutPanelVersion(options);
  app.setAboutPanelOptions({
    applicationName: "Readable Studio",
    ...(version == null ? {} : { version }),
  });
}

function appConfigUrl(baseUrl: string): string {
  return new URL("/api/app-config", baseUrl).toString();
}

async function readAppConfigFromDaemon(baseUrl: string): Promise<DesktopAppConfigPrefs> {
  const response = await fetch(appConfigUrl(baseUrl));
  if (!response.ok) {
    throw new Error(`GET /api/app-config failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as { config?: DesktopAppConfigPrefs };
  if (payload.config == null || typeof payload.config !== "object") {
    throw new Error("GET /api/app-config returned an invalid config payload");
  }
  return payload.config;
}

async function writeAppConfigToDaemon(
  baseUrl: string,
  config: DesktopAppConfigPrefs,
): Promise<DesktopAppConfigPrefs> {
  const response = await fetch(appConfigUrl(baseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(`PUT /api/app-config failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as { config?: DesktopAppConfigPrefs };
  if (payload.config == null || typeof payload.config !== "object") {
    throw new Error("PUT /api/app-config returned an invalid config payload");
  }
  return payload.config;
}

export function installDesktopMenu(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  options: Pick<DesktopMainOptions, "discoverDaemonUrl" | "discoverWebUrl"> = {},
): () => void {
  let developMenuVisible = false;
  let lastKnownAmrProfile: AmrEnvironmentProfile = "prod";

  const showDevelopMenuError = (message: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(message, detail);
  };

  const discoverAppConfigBaseUrl = async (): Promise<string> => {
    const baseUrl =
      (await options.discoverDaemonUrl?.()) ??
      (await options.discoverWebUrl?.()) ??
      (await createWebDiscovery(runtime)());
    if (!baseUrl) {
      throw new Error("daemon URL is unavailable");
    }
    return baseUrl;
  };

  const readCurrentAmrProfile = async (): Promise<AmrEnvironmentProfile> => {
    const baseUrl = await discoverAppConfigBaseUrl();
    const config = await readAppConfigFromDaemon(baseUrl);
    return normalizeAmrEnvironmentProfile(config.agentCliEnv?.[AMR_PROFILE_AGENT_ID]?.[AMR_PROFILE_ENV_KEY]);
  };

  const writeCurrentAmrProfile = async (profile: AmrEnvironmentProfile): Promise<AmrEnvironmentProfile> => {
    const baseUrl = await discoverAppConfigBaseUrl();
    const config = await readAppConfigFromDaemon(baseUrl);
    const nextConfig = mergeAmrEnvironmentProfileConfig(config, profile);
    const writtenConfig = await writeAppConfigToDaemon(baseUrl, nextConfig);
    return normalizeAmrEnvironmentProfile(
      writtenConfig.agentCliEnv?.[AMR_PROFILE_AGENT_ID]?.[AMR_PROFILE_ENV_KEY],
    );
  };

  const selectAmrProfile = (profile: AmrEnvironmentProfile): void => {
    void writeCurrentAmrProfile(profile)
      .then((writtenProfile) => {
        lastKnownAmrProfile = writtenProfile;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(APP_CONFIG_CHANGED_IPC_CHANNEL);
        }
        rebuild();
      })
      .catch((error: unknown) => {
        showDevelopMenuError("AMR Environment Profile switch failed", error);
      });
  };

  const exportDiagnostics = () => {
    const focused = BrowserWindow.getFocusedWindow();
    void exportDiagnosticsToFile(runtime, focused).catch((error: unknown) => {
      console.error("desktop diagnostics export from menu failed", error);
    });
  };
  const rebuild = () => {
    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : [
            {
              label: "File",
              submenu: [
                { role: "quit" as const },
              ],
            },
          ]),
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      ...(developMenuVisible
        ? [
            {
              label: "Develop",
              submenu: createAmrEnvironmentProfileMenuItems(lastKnownAmrProfile, selectAmrProfile),
            },
          ]
        : []),
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(process.platform === "darwin"
            ? [{ type: "separator" as const }, { role: "front" as const }]
            : [{ role: "close" as const }]),
        ],
      },
      {
        label: "Help",
        role: "help",
        submenu: [{ label: "Export Diagnostics…", click: exportDiagnostics }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  rebuild();
  const accelerator = process.platform === "darwin" ? "Command+Option+Shift+D" : "Control+Alt+Shift+D";
  const registered = globalShortcut.register(accelerator, () => {
    if (developMenuVisible) {
      developMenuVisible = false;
      rebuild();
      return;
    }
    void readCurrentAmrProfile()
      .then((profile) => {
        lastKnownAmrProfile = profile;
        developMenuVisible = true;
        rebuild();
      })
      .catch((error: unknown) => {
        showDevelopMenuError("Develop menu unavailable", error);
      });
  });
  if (!registered) {
    console.warn(`Develop menu shortcut registration failed; continuing without ${accelerator}`);
  }
  return () => {
    if (registered) {
      globalShortcut.unregister(accelerator);
    }
  };
}

const REGISTER_DESKTOP_AUTH_RETRY_DELAYS_MS = [120, 240, 480, 960, 1500];
const REGISTER_DESKTOP_AUTH_TIMEOUT_MS = 800;

/**
 * Sends a fresh, per-process secret to the daemon over its sidecar IPC
 * before any BrowserWindow is created. The daemon stores the secret
 * and from this point on requires every `POST /api/import/folder`
 * request to carry an HMAC token signed with it (PR #974). On a clean
 * orchestrator startup the daemon is already up — but desktop and
 * daemon are sibling processes spawned by `tools-dev` / `tools-pack`,
 * so we retry the IPC call a few times before giving up. A failed
 * registration is *not* a hard error: the desktop runtime continues
 * and the import-folder bridge will simply refuse pickAndImport calls
 * (because no secret is in scope), instead of opening a renderer-
 * bypassable path. We log the failure so the operator can investigate.
 */
async function registerDesktopAuthWithDaemon(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  secret: Buffer,
): Promise<boolean> {
  const daemonIpc = resolveAppIpcPath({
    app: APP_KEYS.DAEMON,
    contract: SIDECAR_CONTRACT,
    namespace: runtime.namespace,
  });
  const message = {
    input: { secret: secret.toString("base64") },
    type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
  };
  const delays = REGISTER_DESKTOP_AUTH_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const result = await requestJsonIpc<RegisterDesktopAuthResult>(
        daemonIpc,
        message,
        { timeoutMs: REGISTER_DESKTOP_AUTH_TIMEOUT_MS },
      );
      if (result?.accepted === true) return true;
    } catch {
      // Daemon not yet listening on the IPC socket, or message rejected.
      // Fall through to the retry sleep below.
    }
    if (attempt >= delays.length) break;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, delays[attempt]);
    });
  }
  return false;
}

// @dsp func-c2bfc904
export async function runDesktopMain(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  options: DesktopMainOptions = {},
): Promise<void> {
  const inheritedApprovalToken = consumeDesktopApprovalToken(process.env);
  const desktopApprovalToken = options.desktopApprovalToken === undefined
    ? inheritedApprovalToken
    : options.desktopApprovalToken?.trim() || null;
  // Install the defensive uncaughtException filter BEFORE awaiting
  // app.whenReady, so a setTypeOfService EINVAL thrown by undici during
  // the renderer's first fetch is intercepted rather than surfacing as
  // Electron's "JavaScript error in main process" dialog (issue #647).
  // The packaged entry has the parallel filter wired in
  // apps/packaged/src/logging.ts; both must stay in sync until the
  // helper is promoted to a shared workspace package.
  attachDesktopProcessErrorFilter();

  // dev (tools-dev) enters here without a prior `whenReady` — so this
  // is where the `--lang` switch actually lands. In packaged builds
  // `apps/packaged/src/index.ts` has already applied the switch before
  // its own `whenReady`; this call is then a no-op for the switch and
  // only recovers the locale string for the BrowserWindow below.
  app.setName("Readable Studio");
  const osLocale = applyOsLocaleSwitch(app);

  await app.whenReady();
  configureAboutPanel(options);

  // PR #974: mint a per-process auth secret and hand it to the daemon
  // BEFORE the BrowserWindow loads. The daemon uses it to verify the
  // HMAC tokens that the `dialog:pick-and-import` IPC mints for
  // `POST /api/import/folder`. Doing this before the window load is
  // load-bearing: it closes the race where a compromised renderer
  // races to call /api/import/folder with an arbitrary baseDir before
  // the gate is armed.
  //
  // Round-5 (lefarcen P1, mrcfps): if the initial registration fails
  // (daemon slow to listen, missed startup window, or daemon restarted
  // mid-session), we still pass the secret to the runtime so the lazy
  // re-registration path inside `dialog:pick-and-import` can recover.
  // The runtime's first import attempt under a daemon that doesn't yet
  // know the secret gets a `503 DESKTOP_AUTH_PENDING`, the runtime
  // re-invokes the registration callback below, and the import retries
  // once with a fresh token. A persistent failure surfaces in the
  // renderer toast rather than silently dropping forever.
  const desktopAuthSecret = randomBytes(32);
  const registered = await registerDesktopAuthWithDaemon(runtime, desktopAuthSecret);
  if (!registered) {
    console.warn(
      "[readable-studio desktop] initial import-token handshake with daemon did not complete; " +
        "first folder-import attempt will lazily retry registration before failing",
    );
  }

  // Resolve the namespace root the same way the diagnostics export does
  // (apps/desktop/src/main/diagnostics.ts). In packaged builds `runtime.base`
  // is `<namespaceRoot>/runtime`, so re-appending the namespace via
  // `resolveNamespaceRoot` would write renderer.log to a phantom
  // `<namespaceRoot>/runtime/<namespace>/logs/desktop` dir that the export
  // reader never looks in. Keeping both sides on `resolveRuntimeNamespaceRoot`
  // co-locates renderer.log with the desktop log dir AND keeps it captured.
  const namespaceRoot = resolveRuntimeNamespaceRoot({
    contract: SIDECAR_CONTRACT,
    runtime,
    runtimeMode: SIDECAR_MODES.RUNTIME,
  });
  const desktopLogPath = resolveLogFilePath({
    app: APP_KEYS.DESKTOP,
    contract: SIDECAR_CONTRACT,
    runtimeRoot: namespaceRoot,
  });
  const rendererLogPath = join(dirname(desktopLogPath), "renderer.log");

  let desktop: DesktopRuntime | null = null;
  let approvalLoop: DesktopApprovalLoop | null = null;
  let disposeMenu: () => void = () => undefined;
  let removeDiagnosticsIpc: () => void = () => undefined;
  let ipcServer: JsonIpcServerHandle | null = null;
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    approvalLoop?.abort();
    await options.beforeShutdown?.().catch((error: unknown) => {
      console.error("desktop beforeShutdown failed", error);
    });
    disposeMenu();
    removeDiagnosticsIpc();
    await ipcServer?.close().catch(() => undefined);
    await desktop?.close().catch(() => undefined);
    await approvalLoop?.done.catch(() => undefined);
    app.quit();
  }

  function shutdownAndExit(): void {
    void shutdown().finally(() => process.exit(0));
  }

  desktop = await createDesktopRuntime({
    desktopAuthSecret,
    discoverUrl: options.discoverWebUrl ?? createWebDiscovery(runtime),
    discoverDaemonUrl: options.discoverDaemonUrl,
    osLocale,
    preloadPath: options.preloadPath,
    // Round-5 (lefarcen P1, mrcfps): runtime hands this back to itself
    // on `503 DESKTOP_AUTH_PENDING` to re-handshake with the daemon
    // (after a daemon restart, or after a missed startup window). The
    // runtime then mints a FRESH token (new nonce + new exp — replay
    // protection still works) and POSTs once more.
    registerDesktopAuthWithDaemon: () => registerDesktopAuthWithDaemon(runtime, desktopAuthSecret),
    rendererLogPath,
    requestQuit: shutdownAndExit,
    splashWindow: options.splashWindow,
    splashStartedAt: options.splashStartedAt,
  });
  if (desktopApprovalToken) {
    approvalLoop = startDesktopApprovalLoop({
      discoverDaemonUrl: options.discoverDaemonUrl ?? createDaemonDiscovery(runtime),
      getParentWindow: () => desktop?.approvalParent() ?? null,
      showMessageBox: (parent, dialogOptions) => dialog.showMessageBox(parent, dialogOptions),
      token: desktopApprovalToken,
    });
  }
  await options.onDesktopReady?.({ show: () => desktop?.show() });
  disposeMenu = installDesktopMenu(runtime, options);
  removeDiagnosticsIpc = registerDesktopDiagnosticsIpc(runtime);
  attachParentMonitor(shutdown);

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown().finally(() => process.exit(0));
  });

  ipcServer = await createJsonIpcServer({
    socketPath: runtime.ipc,
    handler: async (message: unknown) => {
      const request = normalizeDesktopSidecarMessage(message);
      const activeDesktop = desktop;
      if (activeDesktop == null) {
        throw new Error("desktop runtime is not initialized");
      }
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          return {
            ...activeDesktop.status(),
            descriptor: createRuntimeDescriptor(options.appVersion?.trim() || app.getVersion()),
          };
        case SIDECAR_MESSAGES.EVAL:
          return await activeDesktop.eval(request.input as DesktopEvalInput);
        case SIDECAR_MESSAGES.SCREENSHOT:
          return await activeDesktop.screenshot(request.input as DesktopScreenshotInput);
        case SIDECAR_MESSAGES.CONSOLE:
          return activeDesktop.console();
        case SIDECAR_MESSAGES.SHOW:
          activeDesktop.show();
          return { accepted: true };
        case SIDECAR_MESSAGES.CLICK:
          return await activeDesktop.click(request.input as DesktopClickInput);
        case SIDECAR_MESSAGES.EXPORT_PDF:
          return await activeDesktop.exportPdf(request.input as DesktopExportPdfInput);
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            shutdownAndExit();
          });
          return { accepted: true };
      }
    },
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shutdownAndExit();
  });

  app.on("window-all-closed", () => {
    shutdownAndExit();
  });

  app.on("activate", () => {
    desktop?.show();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shutdownAndExit();
    });
  }
}

if (isDirectEntry()) {
  const stamp = readProcessStamp(process.argv.slice(2), SIDECAR_CONTRACT);
  if (stamp == null) throw new Error("sidecar stamp is required");

  const runtime = bootstrapSidecarRuntime(stamp, process.env, {
    app: APP_KEYS.DESKTOP,
    contract: SIDECAR_CONTRACT,
  });

  void runDesktopMain(runtime).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
