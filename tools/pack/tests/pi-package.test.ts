import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { assertPiPackageIntegrity, assertPiPackageOutput, assertPiShutdownPatched, patchPiPackage, PI_RPC_ENTRY_RELATIVE_PATH } from "../src/pi-package.js";
import piPackage from "../src/pi-package.json" with { type: "json" };
import { WIN_PREBUNDLE_RUNTIME_DEPENDENCIES } from "../src/win-prebundle.js";
import { createAssembledAppDependencies } from "../src/win/app.js";
import { ELECTRON_BUILDER_ASAR, ELECTRON_BUILDER_FILE_PATTERNS, INTERNAL_PACKAGES } from "../src/win/constants.js";

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
if (process.argv[2] !== '--list-models' || process.env.PI_OFFLINE !== '1' || !process.env.OPENAI_API_KEY) process.exit(1);
console.log('provider model context max-out thinking images');
console.log('openai fixture-model 128K 16K yes yes');
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
      await expect(assertPiPackageOutput(source)).rejects.toThrow(/staged Pi RPC entry point is missing or invalid/);
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

  it.each(["package", "entry", "export", "version", "cli", "launcher", "catalogue"])("refuses output with a missing or invalid %s", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-invalid-"));
    try {
      await writePiFixture(root, failure === "export" ? { exports: {} } : failure === "version" ? { version: "0.0.0" } : {});
      await patchPiPackage(root, workspaceRoot);
      if (failure === "package") await rm(join(root, "node_modules"), { recursive: true });
      if (failure === "entry") await rm(join(root, PI_RPC_ENTRY_RELATIVE_PATH));
      if (failure === "cli") await rm(join(root, "node_modules", piPackage.name, "dist", "cli.js"));
      if (failure === "launcher") await rm(join(root, "pi.cmd"));
      if (failure === "catalogue") await writeFile(join(root, "node_modules", piPackage.name, "dist", "cli.js"), "console.log('No models available');\n");
      await expect(assertPiPackageOutput(root)).rejects.toThrow(/staged Pi RPC entry point is missing or invalid/);
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
      await expect(assertPiPackageOutput(root)).rejects.toThrow(/staged Pi RPC entry point is missing or invalid/);
    } finally {
      await rm(root, { recursive: true, force: true });
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
