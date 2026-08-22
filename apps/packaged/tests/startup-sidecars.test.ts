import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APP_KEYS,
  createRuntimeDescriptor,
  SIDECAR_CONTRACT,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type SidecarStamp,
} from "@readable-studio/sidecar-proto";
import { resolveAppIpcPath, type SidecarRuntimeContext } from "@readable-studio/sidecar";
import { describe, expect, it } from "vitest";

import type { PackagedNamespacePaths } from "../src/paths.js";
import { startPackagedSidecars, type PackagedSidecarHandle } from "../src/sidecars.js";

type FixtureBehavior = "concurrent" | "fail" | "port-conflict-once" | "ready";

function fixtureSource(
  app: "daemon" | "web",
  root: string,
  behavior: FixtureBehavior,
): string {
  const peer = app === "daemon" ? "web" : "daemon";
  const descriptor = createRuntimeDescriptor("1.2.3");
  return `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const app = ${JSON.stringify(app)};
const behavior = ${JSON.stringify(behavior)};
const ipcPath = process.env.READABLE_SIDECAR_IPC_PATH;
const root = ${JSON.stringify(root)};
const readyPath = join(root, app + ".status-requested");
const peerReadyPath = join(root, ${JSON.stringify(peer)} + ".status-requested");
const tracePath = join(root, "trace.log");
const isPipe = ipcPath.startsWith("\\\\\\\\.\\\\pipe\\\\");
const trace = (event) => appendFileSync(tracePath, event + "\\n", "utf8");

trace(app + ":spawned:" + (process.env.READABLE_PORT ?? ""));
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
          pid: process.pid,
          state: "running",
          updatedAt: new Date().toISOString(),
          url: ready ? "http://127.0.0.1:" + port : null,
        },
      }) + "\\n");
      return;
    }
    socket.end(JSON.stringify({ ok: true, result: { accepted: true } }) + "\\n");
    trace(app + ":shutdown");
    setTimeout(() => server.close(() => {
      if (!isPipe) rmSync(ipcPath, { force: true });
      process.exit(0);
    }), 10);
  });
});

server.listen(ipcPath, () => {
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
  fixturesRoot: string;
  phases: string[];
  root: string;
  start(): Promise<PackagedSidecarHandle>;
};

function createFixtureHarness(
  daemonBehavior: FixtureBehavior,
  webBehavior: FixtureBehavior,
): FixtureHarness {
  const root = mkdtempSync(join(tmpdir(), "readable-packaged-startup-"));
  const namespace = `startup-${randomUUID()}`;
  const paths = fixturePaths(root, namespace);
  const fixturesRoot = join(root, "fixtures");
  const daemonEntry = join(fixturesRoot, "daemon.mjs");
  const webEntry = join(fixturesRoot, "web.mjs");
  const phases: string[] = [];

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
    fixturesRoot,
    phases,
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
        logStartupPhase: (phase) => phases.push(phase),
      });
    },
  };
}

describe("startPackagedSidecars", () => {
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

  it("stops web when daemon startup fails", async () => {
    const fixture = createFixtureHarness("fail", "ready");
    try {
      await expect(fixture.start()).rejects.toThrow(/daemon exited before reporting status/);
      const trace = readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8");
      expect(trace.match(/daemon:spawned:/g)).toHaveLength(1);
      expect(trace).toContain("web:spawned");
      expect(trace).toContain("web:shutdown");
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
      expect(trace).toContain("daemon:shutdown");
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
      expect(readFileSync(join(fixture.fixturesRoot, "trace.log"), "utf8")).toContain(
        "web:shutdown",
      );
    } finally {
      await sidecars?.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
