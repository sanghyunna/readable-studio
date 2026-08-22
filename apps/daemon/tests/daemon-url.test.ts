import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJsonIpcServer, type JsonIpcServerHandle } from "@readable-studio/sidecar";
import { SIDECAR_ENV, SIDECAR_MESSAGES } from "@readable-studio/sidecar-proto";
import { resolveDaemonUrl, DEFAULT_DAEMON_URL } from "../src/daemon-url.js";
import { namedPipePath, writeExecutableScript } from "./helpers/fake-agent.js";

// Verifies the resolution chain: --daemon-url > READABLE_DAEMON_URL > sidecar
// IPC status discovery > legacy default. Each layer must short-circuit the next
// so `readable` clients follow the live daemon across ephemeral-port restarts.

describe("resolveDaemonUrl", () => {
  let ipcBaseDir: string;
  let fakeBinDir: string;
  let emptyBinDir: string;

  beforeAll(() => {
    ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "readable-mcp-resolve-"));
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "readable-tools-dev-resolve-"));
    emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "readable-tools-dev-empty-"));
  });

  afterAll(() => {
    fs.rmSync(ipcBaseDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    fs.rmSync(emptyBinDir, { recursive: true, force: true });
  });

  it("prefers the explicit --daemon-url flag", async () => {
    const url = await resolveDaemonUrl({
      flagUrl: "http://flag.example:1111",
      env: {
        READABLE_DAEMON_URL: "http://env.example:2222",
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "daemon.sock"),
      },
    });
    expect(url).toBe("http://flag.example:1111");
  });

  it("falls back to READABLE_DAEMON_URL when no flag given", async () => {
    const url = await resolveDaemonUrl({
      env: {
        READABLE_DAEMON_URL: "http://env.example:2222",
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "daemon.sock"),
      },
    });
    expect(url).toBe("http://env.example:2222");
  });

  it("returns the legacy default when no flag/env/socket is available", async () => {
    const url = await resolveDaemonUrl({
      env: {
        PATH: emptyBinDir,
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "missing.sock"),
      },
      timeoutMs: 200,
    });
    expect(url).toBe(DEFAULT_DAEMON_URL);
  });

  it("discovers the default tools-dev daemon URL when no sidecar IPC path is available", async () => {
    const status = {
      apps: {
        daemon: {
          url: "http://127.0.0.1:60123",
        },
      },
    };
    await writeExecutableScript(
      fakeBinDir,
      "pnpm",
      `console.log('pnpm warning before json');\nconsole.log(JSON.stringify(${JSON.stringify(status)}));`,
    );

    const url = await resolveDaemonUrl({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeoutMs: 1000,
    });
    expect(url).toBe("http://127.0.0.1:60123");
  });

  it("discovers the live daemon URL via the concrete sidecar IPC status endpoint", async () => {
    const socketPath = process.platform === "win32"
      ? namedPipePath(`readable-studio-daemon-url-${process.pid}-${Date.now()}`)
      : path.join(ipcBaseDir, "daemon.sock");
    let ipc: JsonIpcServerHandle | null = null;
    try {
      ipc = await createJsonIpcServer({
        socketPath,
        handler: (message) => {
          if (
            message != null &&
            typeof message === "object" &&
            (message as { type?: unknown }).type === SIDECAR_MESSAGES.STATUS
          ) {
            return {
              pid: 4242,
              state: "running",
              updatedAt: new Date().toISOString(),
              url: "http://127.0.0.1:54321",
            };
          }
          throw new Error("unexpected message");
        },
      });

      const url = await resolveDaemonUrl({
        env: {
          [SIDECAR_ENV.IPC_PATH]: socketPath,
        },
        timeoutMs: 1000,
      });
      expect(url).toBe("http://127.0.0.1:54321");
    } finally {
      await ipc?.close();
    }
  });
});
