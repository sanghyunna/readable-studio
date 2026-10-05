import { randomUUID } from "node:crypto";
import { EventEmitter, once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import {
  APP_KEYS,
  createRuntimeDescriptor,
  SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type SidecarStamp,
} from "@readable-studio/sidecar-proto";
import { resolveAppIpcPath, type SidecarRuntimeContext } from "@readable-studio/sidecar";
import { describe, expect, it, vi } from "vitest";

import { PackagedNewerSchemaError, resolvePackagedStartupFailureDialog } from '../src/errors.js';
import type { PackagedNamespacePaths } from "../src/paths.js";
import { startPackagedSidecars, type PackagedSidecarHandle } from "../src/sidecars.js";

type FixtureBehavior = "source-drain" | "hung-child" | "drain-child" | "concurrent" | "fail" | "newer-schema" | "no-http" | "port-conflict-once" | "ready" | "stale";

function fixtureSource(
  app: "daemon" | "web",
  root: string,
  behavior: FixtureBehavior,
): string {
  if (behavior === 'source-drain') {
    const require = createRequire(import.meta.url);
    const lifetimeUrl = new URL('../../daemon/src/runtimes/probe-lifetime.ts', import.meta.url).href;
    const sidecarUrl = new URL('../../daemon/src/sidecar/index.ts', import.meta.url).href;
    return `
import { register } from ${JSON.stringify(pathToFileURL(require.resolve('tsx/esm/api')).href)};
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
register();
process.env.READABLE_AGENT_DISCOVERY_OFFLINE = '1';
const { trackProbeChild } = await import(${JSON.stringify(lifetimeUrl)});
const probe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
trackProbeChild(probe);
writeFileSync(${JSON.stringify(join(root, 'probe.pid'))}, String(probe.pid));
await import(${JSON.stringify(sidecarUrl)});
`;
  }
  const peer = app === "daemon" ? "web" : "daemon";
  const descriptor = createRuntimeDescriptor("1.2.3");
  return `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { spawn, execFile } from "node:child_process";

const app = ${JSON.stringify(app)};
const behavior = ${JSON.stringify(behavior)};
const ipcPath = process.env.READABLE_SIDECAR_IPC_PATH;
const root = ${JSON.stringify(root)};
const readyPath = join(root, app + ".status-requested");
const peerReadyPath = join(root, ${JSON.stringify(peer)} + ".status-requested");
const tracePath = join(root, "trace.log");
const isPipe = ipcPath.startsWith("\\\\\\\\.\\\\pipe\\\\");
const trace = (event) => appendFileSync(tracePath, event + "\\n", "utf8");

writeFileSync(join(root, app + ".env.json"), JSON.stringify(Object.fromEntries([
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "READABLE_DESKTOP_APPROVAL_TOKEN", "DATABRICKS_TOKEN", "DATABRICKS_API_KEY",
  "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "UNRELATED_SECRET",
  "READABLE_DATA_DIR", "READABLE_PACKAGED_NAMESPACE", "READABLE_SIDECAR_IPC_PATH", "READABLE_PORT",
].map((key) => [key, process.env[key]]))), "utf8");
trace(app + ":pid:" + process.pid);
trace(app + ":spawned:" + (process.env.READABLE_PORT ?? ""));
if (behavior === "newer-schema") {
  console.error(JSON.stringify({ type: "readable-studio:database-open-refusal", code: "SCHEMA_VERSION_NEWER", pid: process.pid, databaseVersion: 9, supportedVersion: 1 }));
  console.error("unrelated human-readable startup text");
  process.exit(1);
}
if (behavior === "fail") {
  console.error(app + " fixture startup failed");
  process.exit(3);
}
if (behavior === "port-conflict-once") {
  const markerPath = join(root, app + ".port-conflict");
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, process.env.READABLE_PORT ?? "", "utf8");
    console.error("listen EADDRINUSE: address already in use 127.0.0.1:" + process.env.READABLE_PORT);
    process.exit(4);
  }
}

if (!isPipe) {
  mkdirSync(dirname(ipcPath), { recursive: true });
  rmSync(ipcPath, { force: true });
}

const server = createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString();
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const message = JSON.parse(input.slice(0, newline));
    if (message.type === "status") {
      if (behavior === "concurrent") writeFileSync(readyPath, "", "utf8");
      const ready = behavior !== "concurrent" || existsSync(peerReadyPath);
      const port = app === "daemon" ? process.env.READABLE_PORT : "32123";
      socket.end(JSON.stringify({
        ok: true,
        result: {
          descriptor: ${JSON.stringify(descriptor)},
          pid: behavior === "stale" ? process.pid + 1 : process.pid,
          state: "running",
          updatedAt: new Date().toISOString(),
          url: ready ? "http://127.0.0.1:" + port : null,
        },
      }) + "\\n", () => { if (behavior === "stale") process.exit(3); });
      return;
    }
    socket.end(JSON.stringify({ ok: true, result: { accepted: true } }) + "\\n");
    trace(app + ":shutdown");
    if (behavior === "hung-child") return;
    const finish = () => server.close(() => {
      if (!isPipe) rmSync(ipcPath, { force: true });
      process.exit(0);
    });
    if (probe) {
      probe.once("exit", finish);
      if (process.platform === "win32") execFile("taskkill.exe", ["/PID", String(probe.pid), "/T", "/F"], { windowsHide: true }, error => { if (error) console.error(error); });
      else probe.kill("SIGKILL");
    } else finish();
  });
});

const listenIpc = () => server.listen(ipcPath, () => {
  trace(app + ":listening");
  if (behavior !== "concurrent") return;
  setTimeout(() => {
    if (existsSync(readyPath) && existsSync(peerReadyPath)) return;
    console.error(app + " timed out waiting for concurrent status polling");
    server.close(() => {
      if (!isPipe) rmSync(ipcPath, { force: true });
      process.exit(2);
    });
  }, 750);
});
let probe;
if (behavior === "hung-child" || behavior === "drain-child") {
  probe = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  writeFileSync(join(root, "probe.pid"), String(probe.pid));
}
if (app === "daemon" && behavior !== "no-http") {
  createHttpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }).listen(Number(process.env.READABLE_PORT), "127.0.0.1", listenIpc);
} else listenIpc();
`;
}

function fixturePaths(root: string, namespace: string): PackagedNamespacePaths {
  const namespaceRoot = join(root, "namespaces", namespace);
  return {
    cacheRoot: join(namespaceRoot, "cache"),
    dataRoot: join(namespaceRoot, "data"),
    desktopIdentityPath: join(namespaceRoot, "runtime", "desktop-root.json"),
    desktopLogPath: join(namespaceRoot, "logs", "desktop", "latest.log"),
    desktopLogsRoot: join(namespaceRoot, "logs", "desktop"),
    electronSessionDataRoot: join(namespaceRoot, "user-data", "session"),
    electronUserDataRoot: join(namespaceRoot, "user-data"),
    headlessIdentityPath: join(namespaceRoot, "runtime", "headless-root.json"),
    installationRoot: root,
    logsRoot: join(namespaceRoot, "logs"),
    namespaceRoot,
    resourceRoot: join(root, "resources"),
    runtimeRoot: join(namespaceRoot, "runtime"),
    webIdentityPath: join(namespaceRoot, "runtime", "web-root.json"),
  };
}

type FixtureHarness = {
  daemonLogPath: string;
  webLogPath: string;
  fixturesRoot: string;
  phases: string[];
  events: EventEmitter;
  root: string;
  start(): Promise<PackagedSidecarHandle>;
};

function createFixtureHarness(
  daemonBehavior: FixtureBehavior,
  webBehavior: FixtureBehavior,
  onDaemonFailure?: (error: unknown) => Promise<'retry' | 'quit'>,
): FixtureHarness {
  const root = mkdtempSync(join(tmpdir(), "readable-packaged-startup-"));
  const namespace = `startup-${randomUUID()}`;
  const paths = fixturePaths(root, namespace);
  const fixturesRoot = join(root, "fixtures");
  const daemonEntry = join(fixturesRoot, "daemon.mjs");
  const webEntry = join(fixturesRoot, "web.mjs");
  const phases: string[] = [];
  const events = new EventEmitter();

  mkdirSync(fixturesRoot, { recursive: true });
  writeFileSync(
    daemonEntry,
    fixtureSource("daemon", fixturesRoot, daemonBehavior),
    "utf8",
  );
  writeFileSync(webEntry, fixtureSource("web", fixturesRoot, webBehavior), "utf8");

  const runtime: SidecarRuntimeContext<SidecarStamp> = {
    app: APP_KEYS.DESKTOP,
    base: paths.runtimeRoot,
    ipc: resolveAppIpcPath({
      app: APP_KEYS.DESKTOP,
      contract: SIDECAR_CONTRACT,
      namespace,
    }),
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  };

  return {
    daemonLogPath: join(paths.logsRoot, 'daemon', 'latest.log'),
    webLogPath: join(paths.logsRoot, 'web', 'latest.log'),
    fixturesRoot,
    phases,
    events,
    root,
    async start() {
      return await startPackagedSidecars(runtime, paths, {
        appVersion: "1.2.3",
        amrProfile: null,
        daemonCliEntry: null,
        daemonSidecarEntry: daemonEntry,
        desktopApprovalToken: "approval-token",
        nodeCommand: process.execPath,
        pathsAlreadyEnsured: false,
        requireDesktopAuth: true,
        webSidecarEntry: webEntry,
        webStandaloneRoot: null,
        webOutputMode: "server",
        onDaemonFailure,
        logStartupPhase: (phase) => { phases.push(phase); events.emit(phase); },
      });
    },
  };
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Shutdown contract: a failed start only rejects after every child it spawned has been stopped,
 * either gracefully (shutdown IPC) or by the product's forced-termination fallback. Both are valid,
 * so assert the outcome (the PID is gone and the product logged completion), not which path ran.
 */
function spawnedPids(fixture: FixtureHarness, app: 'daemon' | 'web'): number[] {
  const trace = readFileSync(join(fixture.fixturesRoot, 'trace.log'), 'utf8');
  return [...trace.matchAll(new RegExp(`^${app}:pid:(\\d+)$`, 'gm'))].map(match => Number(match[1]));
}

function expectChildStopped(fixture: FixtureHarness, app: 'daemon' | 'web', pid: number): void {
  expect(pidAlive(pid)).toBe(false);
  const log = readFileSync(app === 'daemon' ? fixture.daemonLogPath : fixture.webLogPath, 'utf8');
  expect(log).toContain(`exited app=${app} pid=${pid} `);
}

describe("startPackagedSidecars", () => {
  it('restarts an exited daemon on the same port, namespace and data root without restarting web', async () => {
    const fixture = createFixtureHarness('ready', 'ready');
    let sidecars: PackagedSidecarHandle | null = null;
    try {
      sidecars = await fixture.start();
      const first = { ...sidecars.daemon };
      const envPath = join(fixture.fixturesRoot, 'daemon.env.json');
      const originalEnv = JSON.parse(readFileSync(envPath, 'utf8'));
      const restarted = once(fixture.events, 'daemon-restart-ready', { signal: AbortSignal.timeout(12_000) });
      process.kill(first.pid!, 'SIGKILL');
      await restarted;
      expect(sidecars.daemon.pid).not.toBe(first.pid);
      expect(sidecars.daemon.url).toBe(first.url);
      const received = JSON.parse(readFileSync(envPath, 'utf8'));
      for (const key of ['READABLE_DATA_DIR', 'READABLE_PACKAGED_NAMESPACE', 'READABLE_SIDECAR_IPC_PATH', 'READABLE_PORT']) {
        expect(received[key]).toBe(originalEnv[key]);
        expect(received[key]).toBeTruthy();
      }
      const trace = readFileSync(join(fixture.fixturesRoot, 'trace.log'), 'utf8');
      expect(trace.match(/daemon:spawned:/g)).toHaveLength(2);
      expect(trace.match(/web:spawned:/g)).toHaveLength(1);
    } finally { await sidecars?.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  }, 15_000);

  it('offers the runtime failure dialog after three restart attempts are exhausted', async () => {
    let resolveFailure!: (error: unknown) => void;
    const failure = new Promise<unknown>(resolve => { resolveFailure = resolve; });
    const onFailure = vi.fn(async (error: unknown) => { resolveFailure(error); return 'quit' as const; });
    const fixture = createFixtureHarness('ready', 'ready', onFailure);
    let sidecars: PackagedSidecarHandle | null = null;
    try {
      sidecars = await fixture.start();
      for (let attempt = 0; attempt < 3; attempt++) {
        const restarted = once(fixture.events, 'daemon-restart-ready', { signal: AbortSignal.timeout(12_000) });
        process.kill(sidecars.daemon.pid!, 'SIGKILL');
        await restarted;
      }
      const exhausted = Promise.race([failure, new Promise<never>((_, reject) => {
        AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error('failure callback missing')), { once: true });
      })]);
      process.kill(sidecars.daemon.pid!, 'SIGKILL');
      const error = await exhausted;
      expect(onFailure).toHaveBeenCalledTimes(1);
      const options = resolvePackagedStartupFailureDialog(error, true, fixture.root);
      expect(options).toMatchObject({ defaultId: 0, cancelId: 1 });
      expect(options.buttons).toHaveLength(2);
      expect(error).toMatchObject({ code: 'DAEMON_STOPPED' });
    } finally { await sidecars?.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  }, 25_000);
  it.each(['hung-child', 'drain-child', 'source-drain'] as const)('normal close leaves no in-flight descendant by PID (%s)', async (behavior) => {
    const fixture = createFixtureHarness(behavior, 'ready');
    let sidecars: PackagedSidecarHandle | null = null;
    let probePid: number | undefined;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      sidecars = await fixture.start();
      probePid = Number(readFileSync(join(fixture.fixturesRoot, 'probe.pid'), 'utf8'));
      expect(alive(probePid)).toBe(true);
      const started = performance.now();
      await sidecars.close();
      expect(alive(probePid)).toBe(false);
      expect(sidecars.daemon.pid).toBeTypeOf('number');
      expect(alive(sidecars.daemon.pid!)).toBe(false);
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(3_500);
      if (behavior === 'source-drain') {
        const daemonLog = readFileSync(fixture.daemonLogPath, 'utf8');
        expect(daemonLog).toContain('shutdown requested app=daemon');
        expect(daemonLog).not.toContain('forcing tree stop');
        process.stdout.write(JSON.stringify({ sourceDaemon: true, daemonPid: sidecars.daemon.pid, probePid, daemonAliveAfter: false, probeAliveAfter: false, elapsedMs, forced: false }) + '\n');
      } else expect(readFileSync(join(fixture.fixturesRoot, 'trace.log'), 'utf8')).toContain('daemon:shutdown');
    } finally {
      const pidFile = join(fixture.fixturesRoot, 'probe.pid');
      if (probePid === undefined && existsSync(pidFile)) probePid = Number(readFileSync(pidFile, 'utf8'));
      if (probePid && alive(probePid)) {
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(probePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(probePid, 'SIGKILL');
      }
      await sidecars?.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 15_000);

  it("forwards corporate CA paths but strips inherited privileges when launching the packaged daemon", async () => {
    // Given: real child fixtures and corporate trust settings in the desktop parent.
    const fixture = createFixtureHarness("ready", "ready");
    const certPath = join(fixture.fixturesRoot, "corporate ca.pem");
    writeFileSync(certPath, rootCertificates.join("\n"), "utf8");
    const caEnv = {
      NODE_EXTRA_CA_CERTS: certPath,
      SSL_CERT_FILE: certPath,
      SSL_CERT_DIR: fixture.fixturesRoot,
      REQUESTS_CA_BUNDLE: certPath,
      CURL_CA_BUNDLE: certPath,
    };
    const blockedEnv = {
      DATABRICKS_TOKEN: "inherited-databricks-token",
      DATABRICKS_API_KEY: "inherited-databricks-key",
      NODE_OPTIONS: "--require=untrusted-loader",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      UNRELATED_SECRET: "inherited-secret",
    };
    let sidecars: PackagedSidecarHandle | null = null;
    try {
      for (const [key, value] of Object.entries({ ...caEnv, ...blockedEnv })) vi.stubEnv(key, value);
      vi.stubEnv(SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN, "inherited-bearer");
      // When: the real packaged launcher spawns its daemon and receives ready status.
      sidecars = await fixture.start();
      // Then: read what the actual daemon child received, not an assembled expectation.
      const received: unknown = JSON.parse(readFileSync(join(fixture.fixturesRoot, "daemon.env.json"), "utf8"));
      expect(received).toMatchObject(caEnv);
      for (const key of Object.keys(blockedEnv)) expect(received).not.toHaveProperty(key);
      expect(received).toHaveProperty(SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN, "approval-token");
    } finally {
      vi.unstubAllEnvs();
      try {
        await sidecars?.close();
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    }
  });

  it("starts web before daemon readiness and polls both statuses concurrently", async () => {
    const fixture = createFixtureHarness("concurrent", "concurrent");
    let sidecars: PackagedSidecarHandle | null = null;

    try {
      sidecars = await fixture.start();

      expect(fixture.phases.indexOf("web-child-spawned")).toBeLessThan(
        fixture.phases.indexOf("daemon-status-ready"),
      );
      expect(fixture.phases).toEqual(expect.arrayContaining([
        "daemon-status-ready",
        "web-status-ready",
      ]));
      expect(sidecars.daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      expect(sidecars.web.url).toBe("http://127.0.0.1:32123");
      expect(readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8")).toContain("web:listening");
    } finally {
      await sidecars?.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("never reports ready from a different daemon on the namespace IPC endpoint", async () => {
    const fixture = createFixtureHarness("stale", "ready");
    try {
      await expect(fixture.start()).rejects.toThrow(/daemon.*pid|status.*pid/i);
      expect(fixture.phases).not.toContain("daemon-status-ready");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not report ready when daemon IPC reports a URL but HTTP is not serving", async () => {
    const fixture = createFixtureHarness("no-http", "ready");
    try {
      await expect(fixture.start()).rejects.toThrow(/daemon.*health/i);
      expect(fixture.phases).not.toContain("daemon-status-ready");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("carries machine-readable newer-schema refusal from the exited daemon to the dialog", async () => {
    const fixture = createFixtureHarness("newer-schema", "ready");
    try {
      let failure: unknown;
      try { await fixture.start(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(PackagedNewerSchemaError);
      expect(failure).toMatchObject({ code: 'SCHEMA_VERSION_NEWER', databaseVersion: 9, supportedVersion: 1 });
      const dialog = resolvePackagedStartupFailureDialog(failure, true, fixture.root);
      expect(dialog).toMatchObject({ defaultId: 1, cancelId: 1 });
      const trace = readFileSync(join(fixture.fixturesRoot, 'trace.log'), 'utf8');
      expect(trace.match(/daemon:spawned:/g)).toHaveLength(1);
      expect(fixture.phases).not.toContain('daemon-restart-ready');
      const [daemonPid, ...extraDaemons] = spawnedPids(fixture, 'daemon');
      expect(extraDaemons).toHaveLength(0);
      expect(pidAlive(daemonPid!)).toBe(false);
      const webPids = spawnedPids(fixture, 'web');
      expect(webPids).toHaveLength(1);
      expectChildStopped(fixture, 'web', webPids[0]!);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 15000);

  it("stops web when daemon startup fails", async () => {
    const fixture = createFixtureHarness("fail", "ready");
    try {
      await expect(fixture.start()).rejects.toThrow(/daemon exited before reporting status/);
      const trace = readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8");
      expect(trace.match(/daemon:spawned:/g)).toHaveLength(1);
      expect(trace).toContain("web:spawned");
      expect(fixture.phases).not.toContain('daemon-restart-ready');
      const daemonPids = spawnedPids(fixture, 'daemon');
      expect(daemonPids).toHaveLength(1);
      expect(pidAlive(daemonPids[0]!)).toBe(false);
      const webPids = spawnedPids(fixture, 'web');
      expect(webPids).toHaveLength(1);
      expectChildStopped(fixture, 'web', webPids[0]!);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops daemon when web startup fails", async () => {
    const fixture = createFixtureHarness("ready", "fail");
    try {
      await expect(fixture.start()).rejects.toThrow(/web exited before reporting status/);
      const trace = readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8");
      expect(trace).toContain("daemon:spawned");
      expect(fixture.phases).not.toContain('daemon-restart-ready');
      const webPids = spawnedPids(fixture, 'web');
      expect(webPids).toHaveLength(1);
      expect(pidAlive(webPids[0]!)).toBe(false);
      const daemonPids = spawnedPids(fixture, 'daemon');
      expect(daemonPids).toHaveLength(1);
      expectChildStopped(fixture, 'daemon', daemonPids[0]!);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("retries once with a new daemon port after EADDRINUSE", async () => {
    const fixture = createFixtureHarness("port-conflict-once", "ready");
    let sidecars: PackagedSidecarHandle | null = null;
    try {
      sidecars = await fixture.start();
      const daemonStarts = readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("daemon:spawned:"));
      expect(daemonStarts).toHaveLength(2);
      expect(daemonStarts[0]).not.toBe(daemonStarts[1]);
      const webPids = spawnedPids(fixture, 'web');
      expect(webPids.length).toBeGreaterThanOrEqual(2);
      // The restarted web reopens the web log, so only the PID outcome of the first web is observable.
      expect(pidAlive(webPids[0]!)).toBe(false);
      expect(pidAlive(webPids.at(-1)!)).toBe(true);
    } finally {
      await sidecars?.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
