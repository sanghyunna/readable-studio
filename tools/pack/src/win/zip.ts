import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { isBuildProfilingEnabled } from "../build-profile.js";
import type { ToolPackConfig } from "../config.js";
import { winResources } from "../resources.js";
import { pathExists } from './fs.js';
import { mergeWinZipShards } from "./merge-zip.js";
import type { WinBuiltAppManifest, WinPackTiming, WinPaths } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PORTABLE_ZIP_COMPRESSION = 5;
const PORTABLE_ZIP_COMPRESSION_ENV = "READABLE_PORTABLE_ZIP_COMPRESSION";
export const WIN_PORTABLE_CHROMIUM_LOCALE_PAKS = ["en-US.pak", "ko.pak"] as const;

const CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR = "locales";
const PORTABLE_ZIP_METADATA_ARGS = ["-mtc=off", "-mta=off", "-mtm=off"] as const;

export type PortableZipFile = { path: string; size: number };

export function balancePortableZipShards(files: readonly PortableZipFile[], count: number): PortableZipFile[][] {
  const shards = Array.from({ length: count }, () => [] as PortableZipFile[]);
  const bytes = Array<number>(count).fill(0);
  const sorted = [...files].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    let selected = 0;
    for (let i = 1; i < count; i++) if (bytes[i]! < bytes[selected]!) selected = i;
    shards[selected]!.push(file);
    bytes[selected]! += file.size;
  }
  return shards;
}

export async function portableZipShardCacheKey(
  root: string, files: readonly PortableZipFile[], engineVersion: string, level: number, threads: number,
): Promise<string> {
  const hash = createHash("sha256");
  // Attributes are canonicalized by merge; all timestamp fields are disabled.
  hash.update(JSON.stringify({ version: 1, engineVersion, method: "zip/Deflate", level, threads,
    metadata: { timestamps: PORTABLE_ZIP_METADATA_ARGS, externalAttributes: 0x20 } }));
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const content = createHash("sha256");
    for await (const chunk of createReadStream(join(root, file.path))) content.update(chunk);
    hash.update(JSON.stringify([file.path, content.digest("hex")]));
  }
  return hash.digest("hex");
}

type PortableZipShardSidecar = { sha256: string; size: number };

function portableZipShardSidecarPath(cached: string): string {
  return `${cached}.sha256.txt`;
}

async function hashPortableZipFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readPortableZipShardSidecar(sidecarPath: string): Promise<PortableZipShardSidecar | null> {
  try {
    const text = await readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed != null &&
      typeof (parsed as Record<string, unknown>).sha256 === "string" &&
      typeof (parsed as Record<string, unknown>).size === "number"
    ) {
      return {
        sha256: (parsed as { sha256: string }).sha256,
        size: (parsed as { size: number }).size,
      };
    }
  } catch {
    // A missing or unreadable sidecar is treated as a verification failure by callers.
  }
  return null;
}

async function verifyPortableZipShardCache(
  cached: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sidecarPath = portableZipShardSidecarPath(cached);
  const sidecar = await readPortableZipShardSidecar(sidecarPath);
  if (sidecar == null) return { ok: false, reason: "missing-sidecar" };
  let info;
  try {
    info = await stat(cached);
  } catch {
    return { ok: false, reason: "missing-file" };
  }
  if (info.size !== sidecar.size) return { ok: false, reason: "size-mismatch" };
  const actualSha256 = await hashPortableZipFile(cached);
  if (actualSha256 !== sidecar.sha256) return { ok: false, reason: "sha256-mismatch" };
  return { ok: true };
}

async function publishPortableZipShardCache(output: string, cached: string): Promise<void> {
  const sha256 = await hashPortableZipFile(output);
  const { size } = await stat(output);
  const sidecar = portableZipShardSidecarPath(cached);
  const staging = await mkdtemp(join(dirname(cached), ".publish-"));
  try {
    const staged = join(staging, "shard.zip");
    const stagedSidecar = join(staging, "shard.sha256.txt");
    await copyFile(output, staged);
    await writeFile(stagedSidecar, `${JSON.stringify({ sha256, size })}\n`, "utf8");
    const existing = await verifyPortableZipShardCache(cached).catch(() => ({ ok: false, reason: "verify-error" }));
    if (!existing.ok) {
      logWinZipProgress("portable-zip:shard-cache-replace", { cached, reason: existing.reason });
      await rm(cached, { force: true });
      await rm(sidecar, { force: true });
      await link(staged, cached).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      await link(stagedSidecar, sidecar).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    } else {
      await link(stagedSidecar, sidecar).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function collectPortableArchiveFiles(
  root: string,
  excludedEntries: ReadonlySet<string>,
  relativeRoot = "",
  sizes?: Map<string, number>,
): Promise<string[]> {
  const directories = [relativeRoot];
  const files: string[] = [];
  const concurrency = Math.min(20, availableParallelism());
  for (let cursor = 0; cursor < directories.length;) {
    const batch = directories.slice(cursor, cursor + concurrency);
    cursor += batch.length;
    await Promise.all(batch.map(async (directory) => {
      const entries = await readdir(join(root, directory), { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const relativePath = directory.length === 0 ? entry.name : `${directory}/${entry.name}`;
        if (excludedEntries.has(relativePath)) return;
        if (entry.isDirectory()) {
          directories.push(relativePath);
          return;
        }
        if (relativePath.includes("\n") || relativePath.includes("\r")) {
          throw new Error(`portable ZIP paths must not contain newlines: ${JSON.stringify(relativePath)}`);
        }
        files.push(relativePath);
        if (sizes != null) sizes.set(relativePath, (await stat(join(root, relativePath))).size);
      }));
    }));
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
  const prefix = await pathExists(join(input.unpackedRoot, 'app', 'Readable Studio.exe')) ? 'app/' : '';
  const localeRoot = join(input.unpackedRoot, prefix, CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR);
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
    .map((entry) => `${prefix}${CHROMIUM_LOCALES_ARCHIVE_RELATIVE_DIR}/${entry}`);
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

export function resolvePortableZipThreads(fastBuild = false): number | undefined {
  return fastBuild ? Math.min(20, availableParallelism()) : undefined;
}

export function resolvePortableZipShards(fastBuild = false): number | undefined {
  const threads = resolvePortableZipThreads(fastBuild);
  // ZIP compression workers cannot hide a single reader's file-open waits.
  // Allocate the budget to independent readers rather than idle workers.
  return threads != null && threads > 1 ? threads : undefined;
}

export function parseSevenZipTiming(stdout: string): { cpuSeconds: number; wallSeconds: number; averageBusyCores: number } | null {
  const cpu = /Process\s+Time\s*=\s*([\d.]+)/.exec(stdout);
  const wall = /Global\s+Time\s*=\s*([\d.]+)/.exec(stdout);
  if (cpu == null || wall == null) return null; // Legacy commands omit -bt.
  const cpuSeconds = Number(cpu[1]);
  const wallSeconds = Number(wall[1]);
  if (!Number.isFinite(cpuSeconds) || !Number.isFinite(wallSeconds) || wallSeconds <= 0) return null;
  return { cpuSeconds, wallSeconds, averageBusyCores: cpuSeconds / wallSeconds };
}

function logWinZipProgress(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const timestamp = isBuildProfilingEnabled() ? ` timestampMs=${Date.now()} pid=${process.pid}` : "";
  process.stderr.write(`[tools-pack win] ${message}${suffix.length === 0 ? "" : ` ${suffix}`}${timestamp}\n`);
}

export async function runPortableZipShards(
  shards: readonly (readonly PortableZipFile[])[],
  run: (index: number) => Promise<void>,
): Promise<void> {
  const budget = process.env.READABLE_BUILD_EVENTS == null ? Infinity : Number(process.env.READABLE_BUILD_CONCURRENCY);
  const concurrency = Math.min(shards.length,
    Number.isInteger(budget) && budget > 0 ? budget : Infinity);
  logWinZipProgress("portable-zip:concurrency", { concurrency });
  const order = shards.map((files, index) => ({
    index, bytes: files.reduce((sum, file) => sum + file.size, 0),
  })).sort((a, b) => b.bytes - a.bytes || a.index - b.index);
  let active = 0;
  const waiters: Array<() => void> = [];
  const running = order.map(async ({ index }) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiters.push(resolve));
    else active += 1;
    try {
      await run(index);
    } finally {
      const next = waiters.shift();
      if (next == null) active -= 1;
      else next();
    }
  });
  await Promise.allSettled(running);
  await Promise.all(running);
}

// Archive only the immutable stub and app/ payload. Never ship runtime user data
// or stale flat-layout files left in a reused build namespace.
export async function buildWinPortableZip(
  config: ToolPackConfig,
  paths: WinPaths,
  builtApp: WinBuiltAppManifest,
): Promise<WinPackTiming[]> {
  if (process.platform !== "win32") throw new Error("Windows portable zip build must run on Windows");
  const portableZipCompression = resolvePortableZipCompression();
  const portableZipThreads = resolvePortableZipThreads(config.fastBuild);
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
      details.archiverTiming = parseSevenZipTiming(result.stdout);
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
  const plainFileSizes = process.env.READABLE_BUILD_EVENTS == null && resolvePortableZipShards(config.fastBuild) != null
    ? new Map<string, number>() : undefined;
  let files: string[] = [];
  await runSegment("portable-zip:prepare", async () => {
    await mkdir(dirname(paths.setupZipPath), { recursive: true });
    await rm(paths.setupZipPath, { force: true });
    const pruneEntries = await resolveWinPortableZipLocalePruneEntries({ config, unpackedRoot: builtApp.unpackedRoot });
    const layout = await pathExists(join(builtApp.unpackedRoot, 'app', 'Readable Studio.exe'));
    files = layout
      ? ['Readable Studio.exe', ...await collectPortableArchiveFiles(builtApp.unpackedRoot, new Set(pruneEntries), 'app', plainFileSizes)]
      : await collectPortableArchiveFiles(builtApp.unpackedRoot, new Set(pruneEntries), "", plainFileSizes);
    if (layout && plainFileSizes != null) {
      plainFileSizes.set('Readable Studio.exe', (await stat(join(builtApp.unpackedRoot, 'Readable Studio.exe'))).size);
    }
    await writeFile(archiveListPath, `${files.join("\n")}\n`, "utf8");
  });
  const compress = async (phase: string, output: string, list: string, threads = portableZipThreads) => runExecSegment(
    phase, winResources.sevenZipExe,
    ["a", "-tzip", `-mx=${portableZipCompression}`,
      ...(threads == null ? [] : [`-mmt=${threads}`]),
      ...(threads != null || isBuildProfilingEnabled() ? ["-bt"] : []),
      ...PORTABLE_ZIP_METADATA_ARGS, "-scsUTF-8", output, `@${list}`],
    { cwd: builtApp.unpackedRoot, outputPath: output },
  );
  try {
    await runSegment("portable-zip:7z", async () => {
      const shardCount = files.length >= 128 ? resolvePortableZipShards(config.fastBuild) ?? 1 : 1;
      if (shardCount === 1) {
        logWinZipProgress("portable-zip:concurrency", { concurrency: 1 });
        await compress("portable-zip:7z:process", paths.setupZipPath, archiveListPath);
        return;
      }
      const scratch = await mkdtemp(join(dirname(paths.setupZipPath), ".zip-shards-"));
      try {
        if (process.env.READABLE_BUILD_EVENTS == null) {
          const shards = balancePortableZipShards(files.map((path) => ({ path, size: plainFileSizes!.get(path)! })), shardCount);
          const outputs = shards.map((_, index) => join(scratch, `${index}.zip`));
          await runPortableZipShards(shards, async (index) => {
            const list = join(scratch, `${index}.txt`);
            await writeFile(list, `${shards[index]!.map((file) => file.path).join("\n")}\n`, "utf8");
            await compress(`portable-zip:7z:shard-${index}`, outputs[index]!, list,
              Math.max(1, Math.floor(portableZipThreads! / shardCount)));
          });
          const legacyOrder = new Map(files.map((file, index) => [file.replaceAll("\\", "/"), index % shardCount]));
          const merged = await runSegment("portable-zip:merge", () => mergeWinZipShards(outputs, paths.setupZipPath, legacyOrder));
          if (!merged) await compress("portable-zip:7z:process", paths.setupZipPath, archiveListPath);
          return;
        }
        const inventory: PortableZipFile[] = [];
        let nextFile = 0;
        await Promise.all(Array.from({ length: shardCount }, async () => {
          while (nextFile < files.length) {
            const path = files[nextFile++]!;
            inventory.push({ path, size: (await stat(join(builtApp.unpackedRoot, path))).size });
          }
        }));
        const shards = balancePortableZipShards(inventory, shardCount);
        const version = await execFileAsync(winResources.sevenZipExe, ["i"], { windowsHide: true });
        const engineVersion = /^7-Zip[^\r\n]*/m.exec(version.stdout)?.[0];
        if (engineVersion == null) throw new Error("7-Zip version banner missing");
        const cacheRoot = join(config.roots.cacheRoot, "portable-zip-shards");
        await mkdir(cacheRoot, { recursive: true });
        const outputs: string[] = [];
        const tasks: Array<Promise<() => Promise<void>>> = [];
        for (let i = 0; i < shardCount; i++) {
          const list = join(scratch, `${i}.txt`);
          const output = join(scratch, `${i}.zip`);
          outputs.push(output);
          await writeFile(list, `${shards[i]!.map((file) => file.path).join("\n")}\n`, "utf8");
          tasks.push((async () => {
            const threads = Math.max(1, Math.floor(portableZipThreads! / shardCount));
            const key = await portableZipShardCacheKey(builtApp.unpackedRoot, shards[i]!, engineVersion, portableZipCompression, threads);
            const cached = join(cacheRoot, `${key}.zip`);
            const cachedValid = await verifyPortableZipShardCache(cached).catch(() => ({ ok: false, reason: "verify-error" }));
            if (cachedValid.ok) {
              outputs[i] = cached;
              logWinZipProgress("portable-zip:shard-cache-hit", { shard: i, key });
              return async () => {};
            }
            logWinZipProgress("portable-zip:shard-cache-miss", { shard: i, key, reason: cachedValid.reason });
            return async () => {
              await compress(`portable-zip:7z:shard-${i}`, output, list, threads);
              // Publish a complete private file atomically, never replacing a winner.
              // Neither readers nor publishers modify a published cache file.
              await publishPortableZipShardCache(output, cached);
            };
          })());
        }
        // Finish cache lookup before admission so hashing cannot reorder compressor starts.
        await Promise.allSettled(tasks);
        const prepared = await Promise.all(tasks);
        await runPortableZipShards(shards, (index) => prepared[index]!());
        const legacyOrder = new Map(files.map((file, index) => [file.replaceAll("\\", "/"), index % shardCount]));
        const merged = await runSegment("portable-zip:merge", () => mergeWinZipShards(outputs, paths.setupZipPath, legacyOrder));
        if (!merged) {
          logWinZipProgress("portable-zip:shards-unsupported", { reason: "ZIP64 requires native single-process assembly" });
          await compress("portable-zip:7z:process", paths.setupZipPath, archiveListPath);
        }
      } finally { await rm(scratch, { recursive: true, force: true }); }
    });
  } finally {
    await rm(archiveListPath, { force: true });
  }
  await runSegment("portable-zip:stat", async () => {
    await stat(paths.setupZipPath);
  });
  return timings;
}
