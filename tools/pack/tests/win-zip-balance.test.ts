import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToolPackConfig } from "../src/config.js";
import { winResources } from "../src/resources.js";
import { resolveWinPaths } from "../src/win/paths.js";
import { balancePortableZipShards, buildWinPortableZip, portableZipShardCacheKey, runPortableZipShards } from "../src/win/zip.js";

const execFileAsync = promisify(execFile);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("portable ZIP shard admission", () => {
  it.each([
    ["1", 1], ["3", 3], ["30", 20], [undefined, 20],
    ["invalid", 20], ["0", 20], ["-1", 20], ["1.5", 20],
  ] as const)("limits controllable compressors with budget %s to %i", async (budget, limit) => {
    // Deliberately put the largest shard last to distinguish size order from index order.
    const shards = Array.from({ length: 20 }, (_, index) => [{ path: `${index}.bin`, size: index + 1 }]);
    const original = structuredClone(shards);
    const signals = shards.map(() => new EventEmitter());
    const starts = signals.map((signal) =>
      once(signal, "start", { signal: AbortSignal.timeout(10_000) }));
    const releaseFirst = Promise.withResolvers<void>();
    const releaseAll = Promise.withResolvers<void>();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    vi.stubEnv("READABLE_BUILD_CONCURRENCY", budget);
    vi.stubEnv("READABLE_BUILD_EVENTS", join(tmpdir(), "readable-shard-admission.jsonl"));
    const work = runPortableZipShards(shards, async (index) => {
      order.push(index);
      active += 1;
      peak = Math.max(peak, active);
      signals[order.length - 1]!.emit("start");
      try {
        await (index === 19 ? Promise.race([releaseFirst.promise, releaseAll.promise]) : releaseAll.promise);
      } finally { active -= 1; }
    });
    try {
      await Promise.all(starts.slice(0, limit));
      expect(order).toEqual(Array.from({ length: limit }, (_, index) => 19 - index));
      expect(active).toBe(limit);
      if (limit < shards.length) {
        releaseFirst.resolve();
        await starts[limit];
        expect(active).toBe(limit);
      }
    } finally { releaseAll.resolve(); await work; }
    expect(peak).toBe(limit);
    expect(order).toEqual(Array.from({ length: 20 }, (_, index) => 19 - index));
    expect(shards).toEqual(original);
  });

  it("starts all plain-build shards even when a verification budget is inherited", async () => {
    vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
    vi.stubEnv("READABLE_BUILD_CONCURRENCY", "1");
    const release = Promise.withResolvers<void>();
    const started: number[] = [];
    const work = runPortableZipShards(Array.from({ length: 20 }, () => []), async (index) => {
      started.push(index);
      await release.promise;
    });
    try { expect(started).toHaveLength(20); }
    finally { release.resolve(); await work; }
  });
});

describe("portable ZIP LPT assignment", () => {
  it("isolates one huge file and balances many small files across the other shards", () => {
    const files = [{ path: "huge.exe", size: 1_000_000 },
      ...Array.from({ length: 190 }, (_, i) => ({ path: `small-${i}`, size: 100 }))];
    const shards = balancePortableZipShards(files, 20);
    expect(shards[0]).toEqual([files[0]]);
    expect(shards.slice(1).map((shard) => shard.reduce((sum, file) => sum + file.size, 0)))
      .toEqual(Array(19).fill(1_000));
    expect(shards.flat()).toHaveLength(files.length);
    expect(new Set(shards.flat().map((file) => file.path)).size).toBe(files.length);
  });

  it("breaks size ties by path and load ties by index regardless of inventory completion order", () => {
    const files = ["d", "a", "c", "b"].map((path) => ({ path, size: 10 }));
    expect(balancePortableZipShards(files, 2)).toEqual([
      [{ path: "a", size: 10 }, { path: "c", size: 10 }],
      [{ path: "b", size: 10 }, { path: "d", size: 10 }],
    ]);
    expect(balancePortableZipShards([...files].reverse(), 2)).toEqual(balancePortableZipShards(files, 2));
  });

  it("keys content rather than size or timestamps and includes engine and compression settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-shard-key-"));
    const files = [{ path: "large.exe", size: 4 }, { path: "other", size: 1 }];
    const key = (version = "7-Zip 25", level = 5, threads = 1) =>
      portableZipShardCacheKey(root, files, version, level, threads);
    try {
      await writeFile(join(root, "large.exe"), "aaaa");
      await writeFile(join(root, "other"), "x");
      const first = await key();
      await utimes(join(root, "large.exe"), new Date(0), new Date(0));
      expect(await key()).toBe(first);
      expect(await portableZipShardCacheKey(root, [...files].reverse(), "7-Zip 25", 5, 1)).toBe(first);
      expect(await key("7-Zip 26")).not.toBe(first);
      expect(await key("7-Zip 25", 1)).not.toBe(first);
      expect(await key("7-Zip 25", 5, 2)).not.toBe(first);
      expect(await portableZipShardCacheKey(root, files.slice(0, 1), "7-Zip 25", 5, 1)).not.toBe(first);
      await writeFile(join(root, "large.exe"), "bbbb");
      expect(await key()).not.toBe(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("portable ZIP shard cache", () => {
  beforeEach(() => vi.stubEnv("READABLE_BUILD_EVENTS", join(tmpdir(), "readable-shard-cache.jsonl")));
  it("reuses identical shards, misses same-size content changes, and preserves native entry order", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-shard-cache-"));
    const config = resolveToolPackConfig("win", { dir: root, namespace: "cache", fastBuild: true });
    const paths = resolveWinPaths(config);
    const manifest = {
      version: 1 as const, source: "namespace" as const, appBuilderOutputRoot: paths.appBuilderOutputRoot,
      unpackedRoot: paths.unpackedRoot, executablePath: paths.unpackedExePath,
      cacheEntryPath: null, configPath: paths.packagedConfigPath, webStandaloneHookAuditPath: null,
    };
    const shardProcesses = (segments: Awaited<ReturnType<typeof buildWinPortableZip>>) =>
      segments.filter(({ phase }) => phase.startsWith("portable-zip:7z:shard-")).length;
    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      await writeFile(join(paths.unpackedRoot, "huge.exe"), Buffer.alloc(128 * 1024, 1));
      await Promise.all(Array.from({ length: 139 }, (_, i) =>
        writeFile(join(paths.unpackedRoot, `file-${i}.txt`), `bytes ${i}`)));
      expect(shardProcesses(await buildWinPortableZip(config, paths, manifest))).toBeGreaterThan(1);
      const first = await readFile(paths.setupZipPath);
      expect(shardProcesses(await buildWinPortableZip(config, paths, manifest))).toBe(0);
      expect(await readFile(paths.setupZipPath)).toEqual(first);
      await writeFile(join(paths.unpackedRoot, "huge.exe"), Buffer.alloc(128 * 1024, 2));
      expect(shardProcesses(await buildWinPortableZip(config, paths, manifest))).toBe(1);
      const merged = await readFile(paths.setupZipPath);
      expect(merged).not.toEqual(first);
      const native = join(root, "native.zip");
      await execFileAsync(winResources.sevenZipExe, ["a", "-tzip", "-mx=5", "-mmt=1",
        "-mtc=off", "-mta=off", "-mtm=off", native, "*"], { cwd: paths.unpackedRoot, windowsHide: true });
      expect(merged).toEqual(await readFile(native));
      const extracted = join(root, "extracted");
      await execFileAsync(winResources.sevenZipExe, ["x", paths.setupZipPath, `-o${extracted}`, "-y"], { windowsHide: true });
      expect(await readFile(join(extracted, "huge.exe"))).toEqual(Buffer.alloc(128 * 1024, 2));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it("detects a corrupted cached shard and rebuilds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-shard-cache-corrupt-"));
    const config = resolveToolPackConfig("win", { dir: root, namespace: "cache-corrupt", fastBuild: true });
    const paths = resolveWinPaths(config);
    const manifest = {
      version: 1 as const,
      source: "namespace" as const,
      appBuilderOutputRoot: paths.appBuilderOutputRoot,
      unpackedRoot: paths.unpackedRoot,
      executablePath: paths.unpackedExePath,
      cacheEntryPath: null,
      configPath: paths.packagedConfigPath,
      webStandaloneHookAuditPath: null,
    };
    const shardProcesses = (segments: Awaited<ReturnType<typeof buildWinPortableZip>>) =>
      segments.filter(({ phase }) => phase.startsWith("portable-zip:7z:shard-")).length;
    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      await writeFile(join(paths.unpackedRoot, "huge.exe"), Buffer.alloc(128 * 1024, 1));
      await Promise.all(Array.from({ length: 139 }, (_, i) =>
        writeFile(join(paths.unpackedRoot, `file-${i}.txt`), `bytes ${i}`)));
      expect(shardProcesses(await buildWinPortableZip(config, paths, manifest))).toBeGreaterThan(1);
      const first = await readFile(paths.setupZipPath);

      const cacheDir = join(config.roots.cacheRoot, "portable-zip-shards");
      const cached = (await readdir(cacheDir)).filter((name) => name.endsWith(".zip"));
      expect(cached.length).toBeGreaterThan(0);
      const target = join(cacheDir, cached[0]!);
      const data = await readFile(target);
      data[0] ^= 0xff;
      await writeFile(target, data);

      expect(shardProcesses(await buildWinPortableZip(config, paths, manifest))).toBeGreaterThan(0);
      const rebuilt = await readFile(paths.setupZipPath);
      expect(rebuilt).toEqual(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
