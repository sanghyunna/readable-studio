import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_KEYS,
  createRuntimeDescriptor,
  SIDECAR_CONTRACT,
  SIDECAR_DEFAULTS,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  normalizeDesktopSidecarMessage,
  type SidecarStamp,
} from "@readable-studio/sidecar-proto";
import { bootstrapSidecarRuntime, createJsonIpcServer, resolveAppIpcPath } from "@readable-studio/sidecar";
import { addLoopbackNoProxyEnv } from "@readable-studio/platform";

import { PACKAGED_NAMESPACE_ENV, type PackagedConfig } from "./config.js";
import { writePackagedDesktopIdentity, writePackagedWebIdentity } from "./identity.js";
import { resolvePackagedNamespacePaths } from "./paths.js";
import { startPackagedSidecars } from "./sidecars.js";
import { createPackagedStartupPhaseTimer } from "./startup-timing.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function resolveHeadlessNamespaceBaseRoot(): string {
  const configuredDataDir = process.env.READABLE_DATA_DIR;
  if (configuredDataDir != null && configuredDataDir.length > 0) {
    return join(resolve(configuredDataDir.replace(/^~/, homedir())), "namespaces");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataBase =
    xdgDataHome != null && xdgDataHome.length > 0
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(dataBase, "readable-studio", "namespaces");
}

function resolveHeadlessAmrProfile(): PackagedConfig["amrProfile"] {
  const value = process.env.READABLE_AMR_PROFILE?.trim();
  if (value == null || value.length === 0) return null;
  if (value === "prod" || value === "test" || value === "local") return value;
  throw new Error(`unsupported packaged AMR profile: ${value}`);
}

function resolveHeadlessConfig(): PackagedConfig {
  const namespace =
    SIDECAR_CONTRACT.normalizeNamespace(
      process.env[PACKAGED_NAMESPACE_ENV] ?? SIDECAR_DEFAULTS.namespace,
    );

  const namespaceBaseRoot = resolveHeadlessNamespaceBaseRoot();

  // READABLE_RESOURCE_ROOT may be set by a launcher script; otherwise default to a
  // sibling readable-studio/ directory relative to the node_modules that contain
  // this file.
  const resourceRoot =
    process.env.READABLE_RESOURCE_ROOT ??
    join(__dirname, "..", "..", "..", "readable-studio");

  const appVersion = process.env.READABLE_APP_VERSION?.trim() || "0.0.0";
  return {
    amrProfile: resolveHeadlessAmrProfile(),
    appVersion,
    arch: null,
    artifact: null,
    descriptor: createRuntimeDescriptor(appVersion),
    daemonCliEntry: null,
    daemonSidecarEntry: null,
    namespace,
    namespaceBaseRoot,
    nodeCommand: null,
    // Headless resolves its own data root (resolveHeadlessNamespaceBaseRoot)
    // and never reads the packaged portable artifact, so it is always
    // non-portable; the portable exe-adjacent fallback never applies here.
    portable: false,
    platform: null,
    resourceRoot,
    webSidecarEntry: null,
    webStandaloneRoot: null,
    webOutputMode: "server",
  };
}

function createHeadlessStamp(namespace: string): SidecarStamp {
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

function colorize(text: string): string {
  if (process.stdout.isTTY !== true || process.env.NO_COLOR != null) return text;
  return `\x1b[36m\x1b[4m${text}\x1b[0m`;
}

async function main(): Promise<void> {
  const startupTiming = createPackagedStartupPhaseTimer();
  addLoopbackNoProxyEnv(process.env);
  const config = resolveHeadlessConfig();
  startupTiming.mark("config-read-complete");
  const activeConfig = config;
  const paths = resolvePackagedNamespacePaths(config);
  startupTiming.mark("packaged-paths-resolved");
  const stamp = createHeadlessStamp(config.namespace);

  await mkdir(paths.runtimeRoot, { recursive: true });

  const runtime = bootstrapSidecarRuntime(stamp, process.env, {
    app: APP_KEYS.DESKTOP,
    base: paths.runtimeRoot,
    contract: SIDECAR_CONTRACT,
  });

  // Write a headless-specific identity marker so a host can find this process
  // without confusing it with a desktop runtime in the same namespace.
  const identity = await writePackagedDesktopIdentity({
    descriptor: activeConfig.descriptor,
    identityPath: paths.headlessIdentityPath,
    paths,
    stamp,
  });

  const sidecars = await startPackagedSidecars(runtime, paths, {
    appVersion: activeConfig.appVersion,
    amrProfile: activeConfig.amrProfile,
    daemonCliEntry: activeConfig.daemonCliEntry,
    daemonSidecarEntry: activeConfig.daemonSidecarEntry,
    desktopApprovalToken: null,
    nodeCommand: activeConfig.nodeCommand,
    pathsAlreadyEnsured: false,
    // PR #974 round-5 (lefarcen P2): headless packaged mode runs daemon
    // + web only, no Electron, no privileged shell.openPath surface.
    // Pinning READABLE_REQUIRE_DESKTOP_AUTH here would arm a gate no client
    // can ever satisfy (no desktop main process to register a secret),
    // so folder import would permanently return DESKTOP_AUTH_PENDING.
    // The Electron entry counterpart in `apps/packaged/src/index.ts`
    // passes `true` because it does start desktop main.
    requireDesktopAuth: false,
    webSidecarEntry: activeConfig.webSidecarEntry,
    webStandaloneRoot: activeConfig.webStandaloneRoot,
    webOutputMode: activeConfig.webOutputMode,
    logStartupPhase: startupTiming.mark,
  });

  const webUrl = sidecars.web.url;
  if (!webUrl) {
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    throw new Error("web sidecar failed to produce URL — check logs/desktop/latest.log");
  }

  const shutdown = async (): Promise<void> => {
    process.stdout.write("\n Shutting down Readable Studio...\n");
    await ipcServer.close().catch(() => undefined);
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    process.exit(0);
  };

  const ipcServer = await createJsonIpcServer({
    socketPath: stamp.ipc,
    handler: async (message: unknown) => {
      const request = normalizeDesktopSidecarMessage(message);
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          return {
            descriptor: activeConfig.descriptor,
            pid: process.pid,
            state: "running",
            url: webUrl,
            updatedAt: new Date().toISOString(),
          };
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            void shutdown().finally(() => process.exit(0));
          });
          return { accepted: true };
      }
    },
  });

  await writePackagedWebIdentity({
    descriptor: activeConfig.descriptor,
    paths,
    pid: process.pid,
    url: webUrl,
  });
  process.stdout.write(`\n Readable Studio is running\n\n`);
  process.stdout.write(` ➜ ${colorize(webUrl)}\n\n`);
  process.stdout.write(` Press Ctrl+C to stop\n\n`);

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `readable-studio headless failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
