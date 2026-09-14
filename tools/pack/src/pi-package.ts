import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import piPackage from "./pi-package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
export const PI_RPC_ENTRY_RELATIVE_PATH = `node_modules/${piPackage.name}/dist/rpc-entry.js`;

export async function resolvePiPackagePatch(workspaceRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
    pnpm?: { patchedDependencies?: Record<string, string> };
  };
  const patch = manifest.pnpm?.patchedDependencies?.[`${piPackage.name}@${piPackage.version}`];
  if (!patch) throw new Error("pinned Pi package has no declared pnpm patch");
  return join(workspaceRoot, patch);
}

export function assertPiShutdownPatched(packageRoot: string): void {
  const source = readFileSync(join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js"), "utf8");
  if (!/async function shutdown\(exitCode = 0, signal\)\s*\{\s*if \(shuttingDown\)\s*\{\s*return;\s*\}/.test(source)
    || !/if \(process\.platform === "win32"\)\s*\{\s*process\.exitCode = exitCode;\s*return;\s*\}\s*process\.exit\(exitCode\);/.test(source)) {
    throw new Error("staged Pi is missing the Windows graceful shutdown patch");
  }
}

export async function patchPiPackage(appRoot: string, workspaceRoot: string): Promise<void> {
  // The integrity pin covers the original registry tarball, NOT post-patch bytes.
  // Only after npm verifies that tarball do we apply the exact pnpm-declared patch.
  await assertPiPackageIntegrity(appRoot);
  const patch = await resolvePiPackagePatch(workspaceRoot);
  const packageRoot = join(appRoot, "node_modules", piPackage.name);
  // Run outside the repository so git cannot filter ignored node_modules paths.
  // --unsafe-paths permits this explicit absolute staging destination, not an index edit.
  await execFileAsync("git", [
    "-c", "core.autocrlf=false", "apply", "--unsafe-paths",
    `--directory=${packageRoot.replaceAll("\\", "/")}`, patch,
  ], { cwd: tmpdir(), timeout: 10_000 });
  assertPiShutdownPatched(packageRoot);
}

// npm verifies downloaded bytes against the integrity recorded in this lockfile.
// Refuse a registry response that differs from the same pin used by hosted builds.
export async function assertPiPackageIntegrity(appRoot: string): Promise<void> {
  const lock = JSON.parse(await readFile(join(appRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  const installed = lock.packages?.[`node_modules/${piPackage.name}`];
  if (installed?.version !== piPackage.version || installed.integrity !== piPackage.integrity) {
    throw new Error(`staged Pi package does not match pinned ${piPackage.name}@${piPackage.version} integrity`);
  }
}

// Run Node's ESM resolver from the daemon's packaged location, not tools-pack's
// workspace. A successful resolve alone is insufficient: Node can return a URL
// for a nonexistent export target, and a workspace symlink is not portable.
export async function assertPiPackageOutput(appRoot: string): Promise<void> {
  try {
    const packageRoot = join(appRoot, "node_modules", piPackage.name);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name?: string; version?: string;
    };
    if (manifest.name !== piPackage.name || manifest.version !== piPackage.version) {
      throw new Error(`expected ${piPackage.name}@${piPackage.version}`);
    }
    assertPiShutdownPatched(packageRoot);
    const parent = pathToFileURL(join(appRoot, "prebundled", "daemon", "daemon-cli.mjs")).href;
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-import-meta-resolve", "--input-type=module", "--eval",
      `import { fileURLToPath } from 'node:url'; console.log(fileURLToPath(import.meta.resolve(${JSON.stringify(`${piPackage.name}/rpc-entry`)}, ${JSON.stringify(parent)})));`,
    ], { cwd: appRoot, timeout: 10_000 });
    const entry = stdout.trim();
    if (!(await stat(entry)).isFile()) throw new Error("RPC entry point is not a file");
    const physicalEntry = await realpath(entry);
    const relativeEntry = relative(await realpath(appRoot), physicalEntry);
    if (isAbsolute(relativeEntry) || relativeEntry === ".." || relativeEntry.startsWith(`..${sep}`)) {
      throw new Error("RPC entry point escapes the packaged app");
    }
    if (physicalEntry !== await realpath(join(appRoot, PI_RPC_ENTRY_RELATIVE_PATH))) {
      throw new Error("RPC export does not resolve to dist/rpc-entry.js");
    }
  } catch (cause) {
    throw new Error(`staged Pi RPC entry point is missing or invalid under ${appRoot}`, { cause });
  }
}
