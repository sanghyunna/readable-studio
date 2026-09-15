import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ToolPackCache } from "../src/cache.js";
import { resolveToolPackConfig } from "../src/config.js";
import piPackage from "../src/pi-package.json" with { type: "json" };
import { prepareWinPackagedApp } from "../src/win/app.js";
import { INTERNAL_PACKAGES } from "../src/win/constants.js";
import { resolveWinPaths } from "../src/win/paths.js";

// Replace only installation/download work. Cache transactions, finalization and
// Pi verification (including the child process) stay real.
vi.mock("@readable-studio/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@readable-studio/platform")>();
  return { ...actual, createCommandInvocation: () => ({ command: process.execPath, args: ["--eval", ""], windowsVerbatimArguments: false }) };
});
vi.mock("../src/databricks-cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/databricks-cli.js")>();
  return { ...actual, stageDatabricksCli: async () => {}, assertDatabricksCliOutput: async () => {} };
});
vi.mock("../src/pi-package.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pi-package.js")>();
  return { ...actual, patchPiPackage: async (appRoot: string, workspaceRoot: string) => {
    const packageRoot = join(appRoot, "node_modules", piPackage.name);
    const rpc = join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js");
    await mkdir(dirname(rpc), { recursive: true });
    await writeFile(rpc, `async function shutdown(exitCode = 0, signal) {
      if (shuttingDown) { return; }
      if (process.platform === "win32") { process.exitCode = exitCode; return; }
      process.exit(exitCode);
    }`);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ ...piPackage, type: "module", exports: { "./rpc-entry": "./dist/rpc-entry.js" } }));
    await writeFile(join(packageRoot, "dist", "rpc-entry.js"), "export {};\n");
    await writeFile(join(packageRoot, "dist", "cli.js"), await readFile(join(workspaceRoot, "fixture-cli.txt"), "utf8"));
    await writeFile(join(appRoot, "package-lock.json"), JSON.stringify({ packages: { [`node_modules/${piPackage.name}`]: piPackage } }));
    const native = join(appRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    await mkdir(dirname(native), { recursive: true });
    await writeFile(native, Buffer.alloc(100_000));
    await actual.stagePiCliLauncher(appRoot);
  } };
});

describe("finalized Windows Pi gate", () => {
  it.each([true, false])("checks the final cache payload on misses and hits, retaining failures (valid=%s)", async (valid) => {
    const root = await mkdtemp(join(tmpdir(), "readable-pi-finalized-"));
    try {
      const workspaceRoot = join(root, "workspace");
      await mkdir(join(workspaceRoot, "apps", "desktop", "dist", "main"), { recursive: true });
      await mkdir(join(workspaceRoot, "apps", "desktop", "assets"), { recursive: true });
      await writeFile(join(workspaceRoot, "apps", "desktop", "dist", "main", "preload.cjs"), "");
      await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ pnpm: { patchedDependencies: { [`${piPackage.name}@${piPackage.version}`]: "pi.patch" } } }));
      await writeFile(join(workspaceRoot, "pi.patch"), "fixture");
      await writeFile(join(workspaceRoot, "fixture-cli.txt"), `
if (import.meta.url.includes('.tmp-')) process.exit(19);
console.log(${JSON.stringify(valid ? piPackage.version : "CLI_FAILED_SENTINEL")});
process.exitCode = ${valid ? 0 : 7};
`);
      const config = { ...resolveToolPackConfig("win", { dir: join(root, "pack"), appVersion: "1.0.4" }), workspaceRoot, webOutputMode: "server" as const };
      const paths = resolveWinPaths(config);
      const cache = new ToolPackCache(config.roots.cacheRoot);
      const tarballs = { key: "fixture", tarballs: INTERNAL_PACKAGES.map(({ name }, index) => ({ packageName: name, fileName: `${index}.tgz` })) };
      for (const status of ["miss", "hit"]) {
        const result = prepareWinPackagedApp(config, paths, tarballs, cache);
        if (valid) await expect(result).resolves.toMatchObject({ packagedVersion: "1.0.4" });
        else await expect(result).rejects.toMatchObject({ cause: { diagnostics: { exitCode: 7, stdout: "CLI_FAILED_SENTINEL\n" } } });
        const report = cache.report().entries.at(-1)!;
        expect(report.status).toBe(status);
        expect(report.entryPath).not.toContain(".tmp-");
        expect((await stat(join(report.entryPath, "app", "node_modules", piPackage.name, "dist", "cli.js"))).isFile()).toBe(true);
        expect((await stat(join(report.entryPath, "manifest.json"))).isFile()).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
