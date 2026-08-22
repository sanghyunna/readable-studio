import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { probeIsolatedAgentSupport, spawnIsolatedAgent } from "../src/index.js";

const helper = fileURLToPath(new URL("../dist/native/win32/agent-isolator.exe", import.meta.url));
const nativeAvailable = process.platform === "win32" && existsSync(helper);
const temporaryPaths: string[] = [];

function makeTemp(root = tmpdir()): string {
  const path = mkdtempSync(join(root, "readable-isolator-"));
  temporaryPaths.push(path);
  return path;
}

function testEnv(temp: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SystemRoot: process.env.SystemRoot,
    TEMP: temp,
    TMP: temp,
    WINDIR: process.env.WINDIR,
  };
}

async function collect(child: ChildProcess): Promise<{ code: number | null; stderr: string; stdout: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  return { code, stderr, stdout };
}

async function controlMessage(stream: Readable): Promise<{ profileName: string; status: string }> {
  return await new Promise((resolveMessage, rejectMessage) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolveMessage(JSON.parse(buffer.slice(0, newline)) as { profileName: string; status: string });
      } catch (error) {
        rejectMessage(error);
      }
    });
    stream.once("error", rejectMessage);
  });
}

function aclSddl(path: string): string {
  const escapedPath = path.replace(/'/g, "''");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl -LiteralPath '${escapedPath}').Sddl`],
    { encoding: "utf8" },
  ).trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nonAclDrive(): string | null {
  const drive = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Volume | Where-Object { $_.DriveLetter -and $_.FileSystemType -in @('FAT','FAT32','exFAT') } | Select-Object -First 1 -ExpandProperty DriveLetter)",
    ],
    { encoding: "utf8" },
  ).trim();
  return drive ? `${drive}:\\` : null;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe.skipIf(!nativeAvailable)("Windows AppContainer agent isolation", () => {
  it("probes real filesystem and loopback denial", { timeout: 15_000 }, async () => {
    await expect(probeIsolatedAgentSupport()).resolves.toEqual({
      capabilities: {
        appContainer: true,
        filesystemAcl: true,
        internetClient: true,
        killOnJobClose: true,
        loopbackDenied: true,
      },
      supported: true,
    });
  });

  it("allows only the requested writable tree and denies protected files and loopback", { timeout: 15_000 }, async () => {
    const base = makeTemp();
    const allowed = join(base, "allowed");
    const protectedDir = join(base, "protected");
    mkdirSync(allowed);
    mkdirSync(protectedDir);
    const secret = join(protectedDir, "secret.txt");
    const deniedWrite = join(protectedDir, "denied.txt");
    writeFileSync(secret, "secret");

    const server = await new Promise<Server>((resolveListen) => {
      const instance = createServer();
      instance.listen(0, "127.0.0.1", () => resolveListen(instance));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback test server has no TCP port");
      const child = await spawnIsolatedAgent({
        args: ["--harness-files", secret, deniedWrite, String(address.port)],
        command: helper,
        cwd: allowed,
        env: testEnv(allowed),
        readExecutePaths: [dirname(helper)],
        writablePaths: [allowed],
      });
      child.stdin.end();
      const result = await collect(child);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      expect(JSON.parse(result.stdout)).toEqual({
        allowedWrite: true,
        internetClient: true,
        loopbackDenied: true,
        protectedReadDenied: true,
        protectedWriteDenied: true,
      });
      expect(readFileSync(join(allowed, "allowed-write.txt"), "utf8")).toBe("ok");
      expect(existsSync(deniedWrite)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("kills descendants and removes the profile and package-SID ACL", { timeout: 15_000 }, async () => {
    const allowed = makeTemp();
    const pidFile = join(allowed, "descendant.pid");
    const beforeAcl = aclSddl(allowed);
    const child = spawn(helper, ["--exec"], {
      cwd: allowed,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const control = child.stdio[3] as Readable;
    child.stdin?.write(
      `${JSON.stringify({
        args: ["--harness-descendant", pidFile],
        command: helper,
        cwd: allowed,
        env: testEnv(allowed),
        readExecutePaths: [dirname(helper)],
        windowsVerbatimArguments: false,
        writablePaths: [allowed],
      })}\n`,
    );
    child.stdin?.end();
    const ready = await controlMessage(control);
    expect(ready.status).toBe("ready");
    const result = await collect(child);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    expect(descendantPid).toBeGreaterThan(0);
    expect(isAlive(descendantPid)).toBe(false);
    expect(aclSddl(allowed)).toBe(beforeAcl);
    expect(
      execFileSync(helper, ["--check-profile-deleted", ready.profileName], { encoding: "utf8" }),
    ).toBe("");
  });

  it("runs Windows command shims without weakening their existing quoting", { timeout: 15_000 }, async () => {
    const base = makeTemp();
    const allowed = join(base, "allowed with spaces");
    mkdirSync(allowed);
    const shim = join(allowed, "agent shim.cmd");
    writeFileSync(shim, "@echo off\r\n>result.txt echo %~1\r\n");
    const child = await spawnIsolatedAgent({
      args: ["hello world"],
      command: shim,
      cwd: allowed,
      env: testEnv(allowed),
      readExecutePaths: [],
      writablePaths: [allowed],
    });
    child.stdin.end();
    const result = await collect(child);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(readFileSync(join(allowed, "result.txt"), "utf8").trim()).toBe("hello world");
  });

  it("keeps arbitrary descendant executables inside the contained job", { timeout: 15_000 }, async () => {
    const allowed = makeTemp();
    const stagedNode = join(allowed, "node.exe");
    copyFileSync(process.execPath, stagedNode);
    const child = await spawnIsolatedAgent({
      args: ["--harness-spawn-external", stagedNode, "-e", "process.stdout.write('child-ok')"],
      command: helper,
      cwd: allowed,
      env: testEnv(allowed),
      readExecutePaths: [dirname(helper)],
      writablePaths: [allowed],
    });
    child.stdin.end();
    const result = await collect(child);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "child-ok" });
  });

  it("fails closed on a filesystem without persistent ACLs", { timeout: 15_000 }, async () => {
    const drive = nonAclDrive();
    if (!drive) return;
    const cwd = makeTemp(drive);
    await expect(
      spawnIsolatedAgent({
        command: helper,
        cwd,
        env: testEnv(cwd),
        readExecutePaths: [dirname(helper)],
        writablePaths: [cwd],
      }),
    ).rejects.toThrow(/persistent ACLs/);
  });

  it("rejects junctions instead of granting through a reparse point", { timeout: 15_000 }, async () => {
    const base = makeTemp();
    const target = join(base, "target");
    const junction = join(base, "junction");
    mkdirSync(target);
    symlinkSync(target, junction, "junction");

    await expect(spawnIsolatedAgent({
      command: helper,
      cwd: junction,
      env: testEnv(target),
      readExecutePaths: [dirname(helper)],
      writablePaths: [junction],
    })).rejects.toThrow(/reparse point/);
  });

  it("rejects a native helper inside an agent-writable path", async () => {
    const writable = makeTemp();
    const mutableHelper = join(writable, "agent-isolator.exe");
    copyFileSync(helper, mutableHelper);

    await expect(spawnIsolatedAgent({
      command: helper,
      cwd: writable,
      helperPath: mutableHelper,
      readExecutePaths: [dirname(helper)],
      writablePaths: [writable],
    })).rejects.toThrow(/helper must stay outside agent-writable paths/);
  });

  it("fails closed when the native helper is absent", { timeout: 15_000 }, async () => {
    const hidden = `${helper}.missing`;
    renameSync(helper, hidden);
    try {
      await expect(probeIsolatedAgentSupport()).resolves.toMatchObject({ supported: false });
      await expect(
        spawnIsolatedAgent({
          command: hidden,
          cwd: dirname(hidden),
          readExecutePaths: [dirname(hidden)],
          writablePaths: [dirname(hidden)],
        }),
      ).rejects.toThrow(/helper is missing/);
    } finally {
      renameSync(hidden, helper);
    }
  });
});
