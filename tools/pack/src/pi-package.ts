import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import piPackage from "./pi-package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
export const PI_RPC_ENTRY_RELATIVE_PATH = `node_modules/${piPackage.name}/dist/rpc-entry.js`;
export const PI_CLI_LAUNCHER = "pi.cmd";
const piCliLauncher = `@echo off\r\nnode "%~dp0node_modules\\${piPackage.name.replaceAll("/", "\\")}\\dist\\cli.js" %*\r\n`;

export async function stagePiCliLauncher(appRoot: string): Promise<void> {
  await writeFile(join(appRoot, PI_CLI_LAUNCHER), piCliLauncher);
}

// Capture before a caller can clean up its staging tree. Diagnostic I/O failures
// are evidence too, and must never replace the original child failure.
async function describePiPath(path: string) {
  try {
    const metadata = await lstat(path);
    return {
      path, pathLength: path.length, exists: true,
      realPath: await realpath(path), size: metadata.size,
      kind: metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : "file",
      entries: metadata.isDirectory() ? (await readdir(path)).sort() : undefined,
    };
  } catch (error) {
    return { path, pathLength: path.length, error: error instanceof Error ? error.message : String(error) };
  }
}

// Prove the ordinary CLI starts at the pinned version, without provider credentials.
// Model availability belongs to runtime account setup, not artifact verification.
export async function assertPiCliVersion(appRoot: string): Promise<void> {
  appRoot = resolve(appRoot);
  const packageRoot = join(appRoot, "node_modules", piPackage.name);
  const cli = join(packageRoot, "dist", "cli.js");
  const home = await mkdtemp(join(tmpdir(), "readable-pi-version-"));
  let started = false;
  try {
    if (await readFile(join(appRoot, PI_CLI_LAUNCHER), "utf8") !== piCliLauncher) {
      throw new Error("staged Pi CLI launcher is missing or invalid");
    }
    const env = {
      SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
      TEMP: home, TMP: home, HOME: home, USERPROFILE: home,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : ""}`,
      PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1",
    };
    // The launcher bytes are checked above. Own Node directly instead of a
    // cmd.exe wrapper so completion/timeout applies to Pi, not just its shell.
    const execution = execFileAsync(process.execPath, [cli, "--version"],
      // Cold-start on an idle machine is already ~5s: Pi loads its bundled module
      // graph before printing a version. Under a concurrent electron-builder pass
      // that grew past a 20s budget and the child died on SIGTERM with empty output,
      // which reads as a broken package rather than a starved one.
      { env, cwd: home, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    started = true;
    // Register before awaiting: even an execution error must not let cleanup
    // race the process or its stdio handles. 'exit' alone is insufficient.
    const closed = new Promise<void>((resolve) => execution.child.once("close", () => resolve()));
    const { stdout, stderr } = await execution.finally(() => closed);
    if (stdout.trim() !== piPackage.version) {
      throw Object.assign(new Error(`staged Pi CLI did not report pinned version ${piPackage.version}`), {
        stdout, stderr, code: 0,
      });
    }
  } catch (cause) {
    const failure = cause as Error & {
      code?: string | number; signal?: string; killed?: boolean; stdout?: string; stderr?: string;
    };
    const diagnostics = {
      appRoot, executable: process.execPath, nodeVersion: process.version,
      args: [cli, "--version"], cwd: home, started,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      code: failure.code ?? null, signal: failure.signal ?? null, killed: failure.killed ?? false,
      stdout: failure.stdout ?? "", stderr: failure.stderr ?? "",
      tree: await Promise.all([
        appRoot, join(appRoot, "package.json"), join(appRoot, "package-lock.json"),
        join(appRoot, PI_CLI_LAUNCHER), join(appRoot, "node_modules"), dirname(packageRoot),
        packageRoot, join(packageRoot, "package.json"), join(packageRoot, "node_modules"), cli,
      ].map(describePiPath)),
    };
    throw Object.assign(new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\nPi CLI diagnostics: ${JSON.stringify(diagnostics, null, 2)}`,
      { cause },
    ), { code: failure.code, diagnostics });
  } finally {
    try {
      // Windows scanners can briefly retain handles even after the child closes.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Cleanup is not a Pi validity assertion, and must not replace its result.
      console.warn("[tools-pack pi] cleanup:warning", { path: home, error });
    }
  }
}

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
  ], { cwd: tmpdir(), timeout: 10_000, windowsHide: true });
  assertPiShutdownPatched(packageRoot);
  await stagePiCliLauncher(appRoot);
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
    const parent = pathToFileURL(join(appRoot, "prebundled", "daemon", "daemon-cli.mjs")).href;
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-import-meta-resolve", "--input-type=module", "--eval",
      `import { fileURLToPath } from 'node:url'; console.log(fileURLToPath(import.meta.resolve(${JSON.stringify(`${piPackage.name}/rpc-entry`)}, ${JSON.stringify(parent)})));`,
    ], { cwd: appRoot, timeout: 10_000, windowsHide: true });
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
    throw new Error(`staged Pi RPC entry point is missing or invalid under ${appRoot}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  assertPiShutdownPatched(join(appRoot, "node_modules", piPackage.name));
  try {
    await assertPiCliVersion(appRoot);
  } catch (cause) {
    throw new Error(`staged Pi CLI version verification failed under ${appRoot}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
