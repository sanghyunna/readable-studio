import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { ToolPackConfig } from "../config.js";
import { winResources } from "../resources.js";
import type { WinBuiltAppManifest, WinPackTiming, WinPaths } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PORTABLE_ZIP_COMPRESSION = 5;
const PORTABLE_ZIP_COMPRESSION_ENV = "READABLE_PORTABLE_ZIP_COMPRESSION";
export const WIN_PORTABLE_CHROMIUM_LOCALE_PAKS = ["en-US.pak", "ko.pak"] as const;

const CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR = "locales";
const PORTABLE_ZIP_METADATA_ARGS = ["-mtc=off", "-mta=off", "-mtm=off"] as const;

async function collectPortableArchiveFiles(
  root: string,
  excludedEntries: ReadonlySet<string>,
  relativeRoot = "",
): Promise<string[]> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
    if (excludedEntries.has(relativePath)) continue;
    if (entry.isDirectory()) {
      files.push(...await collectPortableArchiveFiles(root, excludedEntries, relativePath));
      continue;
    }
    if (relativePath.includes("\n") || relativePath.includes("\r")) {
      throw new Error(`portable ZIP paths must not contain newlines: ${JSON.stringify(relativePath)}`);
    }
    files.push(relativePath);
  }
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function shouldPruneWinPortableZipLocales(config: ToolPackConfig): boolean {
  return config.signed !== true;
}

export async function resolveWinPortableZipLocalePruneEntries(input: {
  config: ToolPackConfig;
  unpackedRoot: string;
}): Promise<string[]> {
  if (!shouldPruneWinPortableZipLocales(input.config)) return [];
  const localeRoot = join(input.unpackedRoot, CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR);
  const allowed = new Set<string>(WIN_PORTABLE_CHROMIUM_LOCALE_PAKS);
  let entries: string[];
  try {
    entries = await readdir(localeRoot);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".pak") && !allowed.has(entry))
    .sort()
    .map((entry) => `${CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR}/${entry}`);
}

export function resolvePortableZipCompression(value = process.env[PORTABLE_ZIP_COMPRESSION_ENV]): number {
  const normalized = value?.trim();
  if (normalized == null || normalized.length === 0) return DEFAULT_PORTABLE_ZIP_COMPRESSION;

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${PORTABLE_ZIP_COMPRESSION_ENV} must be an integer from 0 to 9: ${value}`);
  }

  const parsed = Number(normalized);
  if (parsed < 0 || parsed > 9) {
    throw new Error(`${PORTABLE_ZIP_COMPRESSION_ENV} must be an integer from 0 to 9: ${value}`);
  }

  return parsed;
}

function logWinZipProgress(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`[tools-pack win] ${message}${suffix.length === 0 ? "" : ` ${suffix}`}\n`);
}

// Produces a portable ZIP from the extracted Electron build. Files are flat at
// the archive root so users can extract it anywhere and run the app.
export async function buildWinPortableZip(
  config: ToolPackConfig,
  paths: WinPaths,
  builtApp: WinBuiltAppManifest,
): Promise<WinPackTiming[]> {
  if (process.platform !== "win32") throw new Error("Windows portable zip build must run on Windows");
  const portableZipCompression = resolvePortableZipCompression();
  const timings: WinPackTiming[] = [];
  const runSegment = async <T>(phase: string, task: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    logWinZipProgress("segment:start", { phase });
    try {
      const result = await task();
      logWinZipProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinZipProgress("segment:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      throw error;
    } finally {
      timings.push({ durationMs: Date.now() - startedAt, phase });
    }
  };
  const runExecSegment = async (
    phase: string,
    command: string,
    args: string[],
    options: { cwd: string; outputPath?: string },
  ): Promise<void> => {
    const startedAt = Date.now();
    const details: Record<string, unknown> = {
      args,
      command,
      cwd: options.cwd,
    };
    logWinZipProgress("segment:start", { phase });
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        windowsHide: true,
      });
      details.stdoutBytes = result.stdout.length;
      details.stderrBytes = result.stderr.length;
      details.stdoutTail = result.stdout.slice(-2000);
      details.stderrTail = result.stderr.slice(-2000);
      if (options.outputPath != null) {
        details.outputBytes = (await stat(options.outputPath)).size;
        details.outputPath = options.outputPath;
      }
      logWinZipProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      timings.push({ details, durationMs: Date.now() - startedAt, phase });
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
      details.code = failure.code;
      details.stdoutTail = typeof failure.stdout === "string" ? failure.stdout.slice(-2000) : undefined;
      details.stderrTail = typeof failure.stderr === "string" ? failure.stderr.slice(-2000) : undefined;
      logWinZipProgress("segment:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      timings.push({ details, durationMs: Date.now() - startedAt, phase });
      throw error;
    }
  };

  const archiveListPath = `${paths.setupZipPath}.files.txt`;
  await runSegment("portable-zip:prepare", async () => {
    await mkdir(dirname(paths.setupZipPath), { recursive: true });
    await rm(paths.setupZipPath, { force: true });
    const pruneEntries = await resolveWinPortableZipLocalePruneEntries({ config, unpackedRoot: builtApp.unpackedRoot });
    const files = await collectPortableArchiveFiles(builtApp.unpackedRoot, new Set(pruneEntries));
    await writeFile(archiveListPath, `${files.join("\n")}\n`, "utf8");
  });
  try {
    await runSegment("portable-zip:7z", async () => {
      await runExecSegment(
        "portable-zip:7z:process",
        winResources.sevenZipExe,
        [
          "a",
          "-tzip",
          `-mx=${portableZipCompression}`,
          ...PORTABLE_ZIP_METADATA_ARGS,
          "-scsUTF-8",
          paths.setupZipPath,
          `@${archiveListPath}`,
        ],
        {
          cwd: builtApp.unpackedRoot,
          outputPath: paths.setupZipPath,
        },
      );
    });
  } finally {
    await rm(archiveListPath, { force: true });
  }
  await runSegment("portable-zip:stat", async () => {
    await stat(paths.setupZipPath);
  });
  return timings;
}
