import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuildEvent, BuildReceipt } from "../src/build-events.js";
import { compareSealedPortableContent } from "../src/content-equivalence.js";
import { resolveToolPackConfig } from "../src/config.js";
import { winResources } from "../src/resources.js";
import { sealAndBuildWinPortableZip, sealFinalPortableTree } from "../src/win/builder.js";
import { resolveWinPaths } from "../src/win/paths.js";
import type { WinBuiltAppManifest } from "../src/win/types.js";
import { buildWinPortableZip } from "../src/win/zip.js";

const execFileAsync = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

function signal() {
  const events = new EventEmitter();
  const promise = once(events, "ready", { signal: AbortSignal.timeout(10_000) }).then(() => undefined);
  return { promise, resolve: () => { events.emit("ready"); } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "readable-seal-zip-"));
  const config = resolveToolPackConfig("win", { dir: root, namespace: "sealzip", fastBuild: true });
  const paths = resolveWinPaths(config);
  const top = join(root, "tree");
  for (const path of [
    "Readable Studio.exe", "app/Readable Studio.exe", "app/locales/en-US.pak", "app/locales/ko.pak",
    "app/locales/fr.pak", "app/resources/update-helper/update-broker.ps1",
    "app/resources/update-helper/update-helper.ps1", "app/resources/update-helper/common.ps1",
  ]) {
    await mkdir(dirname(join(top, path)), { recursive: true });
    await writeFile(join(top, path), path);
  }
  await mkdir(dirname(paths.setupZipPath), { recursive: true });
  const eventPath = join(root, "events.jsonl");
  vi.stubEnv("READABLE_BUILD_EVENTS", eventPath);
  vi.stubEnv("READABLE_BUILD_RUN_ID", "sealzip-test");
  return { root, config, paths, top, eventPath };
}

async function events(path: string): Promise<BuildEvent[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as BuildEvent);
}

const runSegment = async <T>(_phase: string, task: () => Promise<T>): Promise<T> => task();

describe("frozen portable tree seal and ZIP overlap", () => {
  it("skips sealing without build events and produces the same real ZIP bytes as a sealed build", async () => {
    const f = await fixture();
    const manifestPath = join(dirname(f.paths.setupZipPath), "final-tree-manifest.json");
    const layout: WinBuiltAppManifest = {
      version: 1, source: "namespace", appBuilderOutputRoot: f.paths.appBuilderOutputRoot,
      unpackedRoot: f.top, executablePath: join(f.top, "Readable Studio.exe"),
      cacheEntryPath: null, configPath: f.paths.packagedConfigPath, webStandaloneHookAuditPath: null,
    };
    try {
      await sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        await buildWinPortableZip(f.config, f.paths, layout);
      }, runSegment);
      const sealedZip = await readFile(f.paths.setupZipPath);
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready", "zip-ready"]);
      expect(JSON.parse(await readFile(manifestPath, "utf8")).files.length).toBeGreaterThan(0);
      await rm(manifestPath);
      await rm(f.eventPath);
      await rm(f.paths.setupZipPath);
      await rm(join(f.config.roots.cacheRoot, "portable-zip-shards"), { recursive: true, force: true });
      vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
      vi.stubEnv("READABLE_BUILD_RUN_ID", undefined);
      const phases: string[] = [];
      await sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        await buildWinPortableZip(f.config, f.paths, layout);
      }, async (phase, task) => {
        phases.push(phase);
        return task();
      });
      expect(phases).toEqual(["portable-zip:cache"]);
      await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await events(f.eventPath)).toEqual([]);
      expect(await readFile(f.paths.setupZipPath)).toEqual(sealedZip);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 20_000);

  it("starts compression before the seal finishes and orders readiness when ZIP finishes first", async () => {
    const f = await fixture();
    const sealStarted = signal();
    const releaseSeal = signal();
    const archiveFinished = signal();
    const work = sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
      await sealStarted.promise;
      await writeFile(f.paths.setupZipPath, "archive");
      archiveFinished.resolve();
    }, async (phase, task) => {
      if (phase === "portable-zip:seal-final-tree") {
        sealStarted.resolve();
        await releaseSeal.promise;
      }
      return task();
    });
    try {
      await archiveFinished.promise;
      expect(await events(f.eventPath)).toEqual([]);
      releaseSeal.resolve();
      await work;
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready", "zip-ready"]);
    } finally {
      releaseSeal.resolve();
      await work;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("publishes the sealed tree immediately but holds zip-ready until compression finishes", async () => {
    const f = await fixture();
    const sealFinished = signal();
    const releaseArchive = signal();
    const work = sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
      await releaseArchive.promise;
      await writeFile(f.paths.setupZipPath, "archive");
    }, async (phase, task) => {
      const result = await task();
      if (phase === "portable-zip:seal-final-tree") sealFinished.resolve();
      return result;
    });
    try {
      await sealFinished.promise;
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready"]);
      releaseArchive.resolve();
      await work;
      const ready = await events(f.eventPath);
      expect(ready.map((event) => event.event)).toEqual(["final-tree-ready", "zip-ready"]);
      expect(ready[1]!.inputHash).toBe(ready[0]!.inputHash);
      const receipt = JSON.parse(await readFile(ready[1]!.receipt!, "utf8")) as BuildReceipt;
      expect(receipt.files).toEqual([{
        path: basename(f.paths.setupZipPath), size: 7,
        sha256: createHash("sha256").update("archive").digest("hex"),
      }]);
    } finally {
      releaseArchive.resolve();
      await work;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails on a real seal write error and drains compression without publishing readiness", async () => {
    const f = await fixture();
    const sealFailed = signal();
    const releaseArchive = signal();
    await mkdir(join(dirname(f.paths.setupZipPath), "final-tree-manifest.json"));
    let archiveDrained = false;
    let finished = false;
    const work = sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
      await releaseArchive.promise;
      archiveDrained = true;
    }, async (phase, task) => {
      try { return await task(); }
      catch (error) {
        if (phase === "portable-zip:seal-final-tree") sealFailed.resolve();
        throw error;
      }
    });
    const result = work.catch((error: unknown) => error).finally(() => { finished = true; });
    try {
      await sealFailed.promise;
      expect(finished).toBe(false);
      expect(archiveDrained).toBe(false);
      expect(await events(f.eventPath)).toEqual([]);
      releaseArchive.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(archiveDrained).toBe(true);
      expect(await events(f.eventPath)).toEqual([]);
    } finally {
      releaseArchive.resolve();
      await result;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails compression without zip-ready and drains the pending seal", async () => {
    const f = await fixture();
    const archiveFailed = signal();
    const releaseSeal = signal();
    const failure = new Error("compression failed");
    let finished = false;
    const work = sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
      archiveFailed.resolve();
      throw failure;
    }, async (phase, task) => {
      if (phase === "portable-zip:seal-final-tree") await releaseSeal.promise;
      return task();
    });
    const result = work.catch((error: unknown) => error).finally(() => { finished = true; });
    try {
      await archiveFailed.promise;
      expect(finished).toBe(false);
      releaseSeal.resolve();
      expect(await result).toBe(failure);
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready"]);
    } finally {
      releaseSeal.resolve();
      await result;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each(["rewrite", "add", "delete"] as const)("rejects a tree %s after sealing instead of publishing zip-ready", async (mutation) => {
    const f = await fixture();
    const sealFinished = signal();
    try {
      await expect(sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        await sealFinished.promise;
        const target = join(f.top, "app", "Readable Studio.exe");
        if (mutation === "rewrite") await writeFile(target, Buffer.alloc((await stat(target)).size, 42));
        if (mutation === "add") await writeFile(join(f.top, "app", "added.txt"), "added");
        if (mutation === "delete") await rm(target);
        await writeFile(f.paths.setupZipPath, "archive");
      }, async (phase, task) => {
        const result = await task();
        if (phase === "portable-zip:seal-final-tree") sealFinished.resolve();
        return result;
      })).rejects.toThrow("final portable tree changed");
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects a modification during sealing before either readiness event", async () => {
    const f = await fixture();
    const archiveFinished = signal();
    try {
      await expect(sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        await writeFile(join(f.top, "app", "added.txt"), "changed while sealing");
        await writeFile(f.paths.setupZipPath, "archive");
        archiveFinished.resolve();
      }, async (phase, task) => {
        if (phase === "portable-zip:seal-final-tree") await archiveFinished.promise;
        return task();
      })).rejects.toThrow("final portable tree changed");
      expect(await events(f.eventPath)).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each([true, false])("only detaches immutable cache links when build events are enabled (%s)", async (enabled) => {
    const f = await fixture();
    if (!enabled) vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
    const cached = join(f.root, "cached.bin");
    const target = join(f.top, "app", "cached.bin");
    await writeFile(cached, "immutable");
    await chmod(cached, 0o444);
    await link(cached, target);
    try {
      await sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        expect((await stat(target)).ino === (await stat(cached)).ino).toBe(!enabled);
        expect(((await stat(target)).mode & 0o222) !== 0).toBe(enabled);
        await writeFile(f.paths.setupZipPath, "archive");
      }, runSegment);
      expect((await stat(cached)).mode & 0o222).toBe(0);
      expect(await readFile(cached, "utf8")).toBe("immutable");
    } finally {
      await chmod(cached, 0o666);
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("produces the same real sharded ZIP bytes and sealed extracted content as sequential sealing", async () => {
    const f = await fixture();
    const layout: WinBuiltAppManifest = {
      version: 1, source: "namespace", appBuilderOutputRoot: f.paths.appBuilderOutputRoot,
      unpackedRoot: f.top, executablePath: join(f.top, "Readable Studio.exe"),
      cacheEntryPath: null, configPath: f.paths.packagedConfigPath, webStandaloneHookAuditPath: null,
    };
    try {
      await Promise.all(Array.from({ length: 140 }, (_, index) =>
        writeFile(join(f.top, "app", `payload-${index}.txt`), `payload ${index}`)));
      vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
      await sealFinalPortableTree(f.config, f.top, join(f.root, "sequential.txt"));
      await buildWinPortableZip(f.config, f.paths, layout);
      const sequential = await readFile(f.paths.setupZipPath);
      await rm(join(f.config.roots.cacheRoot, "portable-zip-shards"), { recursive: true, force: true });
      vi.stubEnv("READABLE_BUILD_EVENTS", f.eventPath);
      let processes = 0;
      await sealAndBuildWinPortableZip(f.config, f.paths, f.top, async () => {
        const segments = await buildWinPortableZip(f.config, f.paths, layout);
        processes = segments.filter(({ phase }) => phase.startsWith("portable-zip:7z:shard-")).length;
      }, runSegment);
      expect(processes).toBeGreaterThan(1);
      expect(await readFile(f.paths.setupZipPath)).toEqual(sequential);
      expect((await events(f.eventPath)).map((event) => event.event)).toEqual(["final-tree-ready", "zip-ready"]);
      const manifest = JSON.parse(await readFile(join(dirname(f.paths.setupZipPath), "final-tree-manifest.json"), "utf8"));
      const extracted = join(f.root, "extracted");
      await execFileAsync(winResources.sevenZipExe, ["x", f.paths.setupZipPath, `-o${extracted}`, "-y"], { windowsHide: true });
      expect((await compareSealedPortableContent(manifest, extracted)).equal).toBe(true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 20_000);
});
