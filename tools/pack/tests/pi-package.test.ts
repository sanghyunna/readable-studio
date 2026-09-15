import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { assertPiPackageIntegrity, assertPiPackageOutput, assertPiShutdownPatched, patchPiPackage, PI_RPC_ENTRY_RELATIVE_PATH } from "../src/pi-package.js";
import piPackage from "../src/pi-package.json" with { type: "json" };
import { WIN_PREBUNDLE_RUNTIME_DEPENDENCIES } from "../src/win-prebundle.js";
import { createAssembledAppDependencies } from "../src/win/app.js";
import { ELECTRON_BUILDER_ASAR, ELECTRON_BUILDER_FILE_PATTERNS, INTERNAL_PACKAGES } from "../src/win/constants.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => {
  vi.mocked(rm).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const rpcModeRelativePath = `node_modules/${piPackage.name}/dist/modes/rpc/rpc-mode.js`;
// The registry shutdown implementation: patch application must transform both hunks.
const unpatchedShutdown = `export async function runRpcMode(runtimeHost) {
    let detachInput = () => { };
    async function shutdown(exitCode = 0, signal) {
        if (shuttingDown) {
            process.exit(exitCode);
        }
        shuttingDown = true;
        for (const cleanup of signalCleanupHandlers) {
            cleanup();
        }
        unsubscribe?.();
        unsubscribeBackpressure?.();
        await runtimeHost.dispose();
        detachInput();
        process.stdin.pause();
        if (signal !== "SIGTERM") {
            await flushRawStdout();
        }
        process.exit(exitCode);
    }
    async function checkShutdownRequested() {
    }
}
`;

async function writePiFixture(appRoot: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const entry = join(appRoot, PI_RPC_ENTRY_RELATIVE_PATH);
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "export {};\n");
  await writeFile(join(dirname(entry), "cli.js"), `
import { readdirSync } from 'node:fs';
if (process.argv[2] !== '--version' || process.env.PI_OFFLINE !== '1') process.exit(1);
if (process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY) process.exit(2);
if (process.env.HOME !== process.cwd() || process.env.USERPROFILE !== process.cwd()
  || process.env.PI_CODING_AGENT_DIR !== process.cwd() || readdirSync(process.cwd()).length !== 0) process.exit(3);
console.log(${JSON.stringify(piPackage.version)});
`);
  const rpcMode = join(appRoot, rpcModeRelativePath);
  await mkdir(dirname(rpcMode), { recursive: true });
  await writeFile(rpcMode, unpatchedShutdown);
  await writeFile(join(appRoot, "package-lock.json"), JSON.stringify({
    packages: { [`node_modules/${piPackage.name}`]: piPackage },
  }));
  await writeFile(join(appRoot, "node_modules", piPackage.name, "package.json"), JSON.stringify({
    name: piPackage.name,
    version: piPackage.version,
    type: "module",
    exports: { "./rpc-entry": { import: "./dist/rpc-entry.js" } },
    ...overrides,
  }));
}

describe("portable Pi package layout", () => {
  it.each(["standalone", "server"] as const)("installs Pi and includes it outside asar in %s mode", (webOutputMode) => {
    const dependencies = createAssembledAppDependencies(
      { webOutputMode } as ToolPackConfig,
      { assembledAppRoot: join(tmpdir(), "app"), tarballsRoot: join(tmpdir(), "tarballs") },
      INTERNAL_PACKAGES.map(({ name }, index) => ({ packageName: name, fileName: `${index}.tgz` })),
    );
    expect(dependencies[piPackage.name]).toBe(piPackage.version);
    expect(WIN_PREBUNDLE_RUNTIME_DEPENDENCIES[piPackage.name]).toBe(piPackage.version);
    expect(ELECTRON_BUILDER_FILE_PATTERNS).toContain(`node_modules/${piPackage.name}/**/*`);
    expect(ELECTRON_BUILDER_ASAR).toBe(false);
  });

  it("resolves the import-only RPC export from the relocated daemon without the source tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-layout-"));
    const source = join(root, "assembled");
    const shipped = join(root, "portable", "resources", "app");
    try {
      await writePiFixture(source);
      await expect(assertPiPackageOutput(source)).rejects.toThrow(/Windows graceful shutdown patch/);
      await patchPiPackage(source, workspaceRoot);
      const staged = await readFile(join(source, rpcModeRelativePath), "utf8");
      expect(staged).toMatch(/if \(shuttingDown\)\s*\{\s*return;/);
      expect(staged).toMatch(/if \(process\.platform === "win32"\)\s*\{\s*process\.exitCode = exitCode;\s*return;/);
      await expect(assertPiPackageIntegrity(source)).resolves.toBeUndefined();
      await cp(source, shipped, { recursive: true });
      await rm(source, { recursive: true });
      await expect(assertPiPackageOutput(shipped)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["package", "entry", "export", "name", "version", "cli", "launcher", "cli-version"])("refuses output with a missing or invalid %s", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-invalid-"));
    try {
      await writePiFixture(root, failure === "export" ? { exports: {} }
        : failure === "version" ? { version: "0.0.0" }
        : failure === "name" ? { name: "wrong-package" } : {});
      await patchPiPackage(root, workspaceRoot);
      if (failure === "package") await rm(join(root, "node_modules"), { recursive: true });
      if (failure === "entry") await rm(join(root, PI_RPC_ENTRY_RELATIVE_PATH));
      if (failure === "cli") await rm(join(root, "node_modules", piPackage.name, "dist", "cli.js"));
      if (failure === "launcher") await rm(join(root, "pi.cmd"));
      if (failure === "cli-version") await writeFile(join(root, "node_modules", piPackage.name, "dist", "cli.js"), "console.log('0.0.0');\n");
      await expect(assertPiPackageOutput(root)).rejects.toThrow(
        ["cli", "launcher", "cli-version"].includes(failure)
          ? /Pi CLI version verification failed/
          : /Pi RPC entry point is missing or invalid/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([0, 7])("retains child output, exit code %s and tree evidence in the build error", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-diagnostics-"));
    try {
      await writePiFixture(root);
      await patchPiPackage(root, workspaceRoot);
      const cli = join(root, "node_modules", piPackage.name, "dist", "cli.js");
      const source = `console.log('CLI_STDOUT_SENTINEL'); console.error('CLI_STDERR_SENTINEL'); process.exitCode = ${code};\n`;
      await writeFile(cli, source);
      const error = await assertPiPackageOutput(root).then(() => {
        throw new Error("invalid Pi unexpectedly passed");
      }, (error: unknown) => error) as Error & { cause: { diagnostics: unknown } };
      expect(error.cause).toMatchObject({
        code,
        diagnostics: {
          appRoot: root, executable: process.execPath, args: [cli, "--version"],
          started: true, exitCode: code, signal: null, killed: false,
          stdout: "CLI_STDOUT_SENTINEL\n", stderr: "CLI_STDERR_SENTINEL\n",
          tree: expect.arrayContaining([
            expect.objectContaining({ path: cli, exists: true, size: Buffer.byteLength(source), kind: "file", pathLength: cli.length }),
            expect.objectContaining({ path: join(root, "node_modules"), entries: ["@earendil-works"] }),
            expect.objectContaining({ path: join(root, "node_modules", piPackage.name, "node_modules"), error: expect.stringContaining("ENOENT") }),
          ]),
        },
      });
      // The phase logger prints only message, not cause/custom properties.
      expect(error.message).toContain(JSON.stringify(error.cause.diagnostics, null, 2));
    } finally {
      await realFs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a real missing CLI dependency without substituting a successful version check", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-missing-dep-"));
    try {
      await writePiFixture(root);
      await patchPiPackage(root, workspaceRoot);
      await writeFile(join(root, "node_modules", piPackage.name, "dist", "cli.js"), "import 'pi-missing-dependency-sentinel';\n");
      await expect(assertPiPackageOutput(root)).rejects.toMatchObject({ cause: { diagnostics: {
        exitCode: 1, stdout: "", stderr: expect.stringContaining("pi-missing-dependency-sentinel"),
      } } });
    } finally {
      await realFs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { catalogue: "model table", output: "provider model context max-out thinking images\nopenrouter ~openai/gpt-latest 1.1M 128K yes yes", code: 0 },
    { catalogue: "unauthenticated notice", output: "No models available. Use /login to log into a provider via OAuth or API key.", code: 1 },
  ])("verifies an isolated CLI independently of its $catalogue", async ({ output, code }) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-no-auth-"));
    try {
      // Parent credentials must not leak into the CLI's empty HOME or environment.
      vi.stubEnv("OPENAI_API_KEY", "test-only-parent-value");
      vi.stubEnv("OPENROUTER_API_KEY", "test-only-parent-value");
      await writePiFixture(root);
      await patchPiPackage(root, workspaceRoot);
      const cli = join(root, "node_modules", piPackage.name, "dist", "cli.js");
      await writeFile(cli, `
if (process.argv[2] === '--list-models') {
  console.log(${JSON.stringify(output)});
  process.exit(${code});
}
${await readFile(cli, "utf8")}`);
      await expect(assertPiPackageOutput(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an RPC entry resolving outside the packaged app through a junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-escape-"));
    const app = join(root, "app");
    try {
      await writePiFixture(app);
      await patchPiPackage(app, workspaceRoot);
      const packageRoot = join(app, "node_modules", piPackage.name);
      const external = join(root, "external-pi");
      await rename(packageRoot, external);
      await symlink(external, packageRoot, "junction");
      await expect(assertPiPackageOutput(app)).rejects.toThrow(/RPC entry point escapes the packaged app/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["unpatched", "win32", "reentrant"])("rejects a staged shutdown with the %s regression", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-shutdown-"));
    try {
      await writePiFixture(root);
      if (failure !== "unpatched") {
        await patchPiPackage(root, workspaceRoot);
        const file = join(root, rpcModeRelativePath);
        const source = await readFile(file, "utf8");
        await writeFile(file, failure === "win32"
          ? source.replace("process.exitCode = exitCode;", "process.exit(exitCode);")
          : source.replace(/if \(shuttingDown\)\s*\{\s*return;/, "if (shuttingDown) {\n            process.exit(exitCode);"));
      }
      expect(() => assertPiShutdownPatched(join(root, "node_modules", piPackage.name))).toThrow(/Windows graceful shutdown patch/);
      await expect(assertPiPackageOutput(root)).rejects.toThrow(/Windows graceful shutdown patch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for a live CLI holding its temp directory until shutdown, then removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-lifecycle-"));
    const server = createServer();
    let socket: Socket | undefined;
    let outcome: Promise<unknown> | undefined;
    try {
      await writePiFixture(root);
      await patchPiPackage(root, workspaceRoot);
      const listening = once(server, "listening", { signal: AbortSignal.timeout(5_000) });
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const record = join(root, "child.json");
      const cli = join(root, "node_modules", piPackage.name, "dist", "cli.js");
      await writeFile(cli, `${await readFile(cli, "utf8")}
import { connect } from 'node:net';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const handle = openSync(join(process.cwd(), 'held-open'), 'w');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ home: process.cwd(), pid: process.pid }));
const socket = connect(${address.port}, '127.0.0.1');
socket.once('data', () => { closeSync(handle); socket.end(); });
`);
      // Subscribe before starting Pi. No sleeps: the connection is the child-ready signal.
      const connected = once(server, "connection", { signal: AbortSignal.timeout(5_000) });
      outcome = assertPiPackageOutput(root).then(() => undefined, (error: unknown) => error);
      [socket] = await connected as [Socket];
      const { home, pid } = JSON.parse(await readFile(record, "utf8")) as { home: string; pid: number };
      expect(process.kill(pid, 0)).toBe(true);
      expect(vi.mocked(rm).mock.calls.some(([path]) => path === home)).toBe(false);
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) expect(() => process.kill(pid, 0)).toThrow();
        await realFs.rm(path, options);
      });
      socket.end("release");
      await expect(outcome).resolves.toBeUndefined();
      expect(vi.mocked(rm)).toHaveBeenCalledWith(home, {
        recursive: true, force: true, maxRetries: 5, retryDelay: 100,
      });
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (socket && !socket.writableEnded) socket.end("release");
      await outcome;
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await realFs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30_000);

  it.each([true, false])("keeps cleanup failure separate from CLI verification (valid=%s)", async (valid) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-cleanup-"));
    const cleanupError = Object.assign(new Error("rmdir blocked by an open handle"), { code: "EBUSY", syscall: "rmdir" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let home: string | undefined;
    try {
      await writePiFixture(root);
      await patchPiPackage(root, workspaceRoot);
      if (!valid) await writeFile(join(root, "node_modules", piPackage.name, "dist", "cli.js"), "process.exit(7);\n");
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (typeof path === "string" && basename(path).startsWith("readable-pi-version-")) {
          home = path;
          throw cleanupError;
        }
        await realFs.rm(path, options);
      });
      if (valid) await expect(assertPiPackageOutput(root)).resolves.toBeUndefined();
      else await expect(assertPiPackageOutput(root)).rejects.toMatchObject({ cause: { code: 7 } });
      expect(home).toBeDefined();
      expect(warning).toHaveBeenCalledExactlyOnceWith("[tools-pack pi] cleanup:warning", { path: home, error: cleanupError });
    } finally {
      if (home) await realFs.rm(home, { recursive: true, force: true, maxRetries: 5 });
      await realFs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("refuses to patch bytes installed with a different integrity pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-patch-integrity-"));
    try {
      await writePiFixture(root);
      await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
      await expect(patchPiPackage(root, workspaceRoot)).rejects.toThrow(/integrity/);
      expect(await readFile(join(root, rpcModeRelativePath), "utf8")).toBe(unpatchedShutdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("checks the npm install integrity against the shared hosted pin (valid=%s)", async (valid) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-integrity-"));
    try {
      await writeFile(join(root, "package-lock.json"), JSON.stringify({
        packages: {
          [`node_modules/${piPackage.name}`]: {
            version: piPackage.version,
            integrity: valid ? piPackage.integrity : "sha512-wrong",
          },
        },
      }));
      if (valid) await expect(assertPiPackageIntegrity(root)).resolves.toBeUndefined();
      else await expect(assertPiPackageIntegrity(root)).rejects.toThrow(/integrity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
