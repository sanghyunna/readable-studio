import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { materializeCacheTree, removeMaterializedTree, ToolPackCache } from "../src/cache.js";
import { watchPackagedAppInstall, type InstallProcessProgress } from "../src/win/app.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual, link: vi.fn(actual.link), lstat: vi.fn(actual.lstat), mkdir: vi.fn(actual.mkdir),
    readdir: vi.fn(actual.readdir), writeFile: vi.fn(actual.writeFile),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const writeSet = ["main.cjs", "package.json", "resources/app/package.json", "resources/readable-studio-config.json", "Readable Studio.exe"];
const files = [...writeSet, "resources/app/runtime.cjs", "locales/en-US.pak"];
const scratch = resolve(import.meta.dirname, "../../../.tmp/build-verify-speed/run1/cachefix/tests");

describe("private cache materialization", () => {
  let root: string;
  let cache: ToolPackCache;
  beforeEach(async () => {
    await mkdir(scratch, { recursive: true });
    root = await mkdtemp(join(scratch, "materialize-"));
    cache = new ToolPackCache(join(root, "cache"));
  });
  afterEach(async () => {
    vi.mocked(link).mockClear();
    await removeMaterializedTree(root);
  });
  const node = () => ({
    id: "private-tree", key: "one", outputs: ["payload"], invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }) => {
      for (const file of files) {
        const path = join(entryRoot, "payload", file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `original:${file}`);
      }
      return {};
    },
  });

  it.each(["acquire", "readHit"] as const)("links immutable files and copies the write set through %s", async (method) => {
    const fixture = node();
    const entry = await cache.acquire({ materialize: [], node: fixture });
    const out = join(root, "out");
    await cache[method]({ materialize: [{ from: "payload", to: out, writeSet }], node: fixture });
    for (const file of files) {
      const source = join(entry.entryPath, "payload", file);
      const destination = join(out, file);
      const before = await stat(source);
      const after = await stat(destination);
      expect(after.dev).toBe(before.dev);
      expect(after.ino === before.ino).toBe(!writeSet.includes(file));
      if (writeSet.includes(file)) {
        // Exercise the dangerous production pattern after materialization.
        await chmod(destination, 0o666);
        await writeFile(destination, "stamped in place");
      }
      expect(await readFile(source, "utf8")).toBe(`original:${file}`);
      expect((await stat(source)).mode).toBe(before.mode);
    }
    await removeMaterializedTree(out);
    for (const file of files) {
      const source = join(entry.entryPath, "payload", file);
      expect(await readFile(source, "utf8")).toBe(`original:${file}`);
      expect((await stat(source)).mode & 0o200).toBe(0);
      expect((await stat(source)).nlink).toBe(1);
    }
  });

  it.each(["EXDEV", "EMLINK", "EPERM"])("copies safely when a hardlink fails with %s", async (code) => {
    const source = join(root, "source.txt");
    const out = join(root, "out.txt");
    await writeFile(source, "source");
    await chmod(source, 0o444);
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await materializeCacheTree(source, out, []);
    expect((await stat(source)).ino).not.toBe((await stat(out)).ino);
    await writeFile(out, "private");
    expect(await readFile(source, "utf8")).toBe("source");
    expect((await stat(source)).mode & 0o200).toBe(0);
  });

  it("replaces a linked output without changing cache attributes", async () => {
    const fixture = node();
    const target = { from: "payload", to: join(root, "out"), writeSet };
    const entry = await cache.acquire({ materialize: [target], node: fixture });
    await cache.readHit({ materialize: [target], node: fixture });
    const source = join(entry.entryPath, "payload", "locales/en-US.pak");
    expect((await stat(source)).nlink).toBe(2);
    expect((await stat(source)).mode & 0o200).toBe(0);
  });

  it("hashes only declared required cache files during publication and hit validation", async () => {
    const fixture = node();
    const target = {
      from: "payload", to: join(root, "out"), reuse: true,
      reuseRequiredPaths: [["main.cjs", "absent.cjs"], ["resources/app"]],
    };
    const expected = ["main.cjs", "resources/app/package.json", "resources/app/runtime.cjs"];
    vi.mocked(createReadStream).mockClear();
    const entry = await cache.acquire({ materialize: [target], node: fixture });
    expect(entry.files.filter((file) => file.sha256 != null).map((file) => file.path).sort())
      .toEqual(expected.map((path) => `payload/${path}`).sort());
    const publicationReads = vi.mocked(createReadStream).mock.calls.map(([path]) => String(path))
      .filter((path) => !path.startsWith(target.to) && !path.endsWith("manifest.json"));
    expect(publicationReads.map((path) => path.replaceAll("\\", "/").split("/payload/")[1]).sort()).toEqual(expected.sort());

    vi.mocked(createReadStream).mockClear();
    await cache.readHit({ materialize: [target], node: fixture });
    const cacheReads = vi.mocked(createReadStream).mock.calls.map(([path]) => String(path))
      .filter((path) => path.startsWith(entry.entryPath) && !path.endsWith("manifest.json"));
    expect(cacheReads.sort()).toEqual(expected.map((path) => join(entry.entryPath, "payload", path)).sort());
  });

  it.each(["acquire", "readHit"] as const)("rejects required bytes changed without changing metadata through %s", async (method) => {
    const original = node();
    const fixture = {
      ...original,
      build: async (context: { entryRoot: string }) => {
        await original.build(context);
        await utimes(join(context.entryRoot, "payload", "main.cjs"), 1_600_000_000, 1_600_000_000);
        return {};
      },
    };
    const target = {
      from: "payload", to: join(root, "out"), reuse: true, reuseRequiredPaths: [["main.cjs"]],
    };
    const entry = await cache.acquire({ materialize: [target], node: fixture });
    const source = join(entry.entryPath, "payload", "main.cjs");
    const metadata = await stat(source);
    await chmod(source, 0o666);
    await writeFile(source, "x".repeat(metadata.size));
    await chmod(source, metadata.mode);
    await utimes(source, metadata.atime, metadata.mtime);
    const changed = await stat(source);
    expect([changed.size, changed.mtimeMs, changed.mode]).toEqual([metadata.size, metadata.mtimeMs, metadata.mode]);
    if (method === "acquire") {
      await cache.acquire({ materialize: [target], node: fixture });
      expect(cache.report().entries.at(-1)?.status).toBe("stale");
    } else expect(await cache.readHit({ materialize: [], node: fixture })).toBeNull();
  });

  it("uses directory entries without per-file stat or parent mkdir for immutable links", async () => {
    const source = join(root, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "first.txt"), "first");
    await writeFile(join(source, "nested", "second.txt"), "second");
    vi.mocked(lstat).mockClear();
    vi.mocked(mkdir).mockClear();
    await materializeCacheTree(source, join(root, "out"), []);
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, "out", "nested", "second.txt"), "utf8")).toBe("second");
  });

  it.each(["acquire", "readHit"] as const)(
    "seals every published file and skips retained marker rewrites and unrelated hashing through %s",
    async (method) => {
      const fixture = node();
      const out = join(root, "retained");
      const retainedNode = {
        ...fixture,
        build: async (context: { entryRoot: string }) => {
          await fixture.build(context);
          await cp(join(context.entryRoot, "payload"), out, { recursive: true });
          return {};
        },
      };
      const target = {
        from: "payload", to: out, retainOnBuild: true, reuse: true,
        reuseRequiredPaths: [["main.cjs", "absent.cjs"], ["resources/app"]],
      };
      const entry = await cache.acquire({ materialize: [target], node: retainedNode });
      const markerPath = join(cache.root, "materialized", createHash("sha256").update(out).digest("hex"), "marker.json");
      const marker = await readFile(markerPath, "utf8");
      for (const path of [...entry.files.map((file) => file.path), "manifest.json", "complete.json"]) {
        expect((await stat(join(entry.entryPath, path))).mode & 0o222).toBe(0);
      }

      // A stale acquire exercises retainOnBuild again with an already valid
      // marker. readHit exercises the corresponding warm reuse path.
      const nextNode = method === "acquire"
        ? { ...retainedNode, invalidate: async () => ({ reason: "republish identical payload" }) }
        : retainedNode;
      vi.mocked(createReadStream).mockClear();
      vi.mocked(readdir).mockClear();
      vi.mocked(writeFile).mockClear();
      await cache[method]({ materialize: [target], node: nextNode });
      expect(cache.report().entries.at(-1)?.materialized[0]?.skipped).toBe(true);
      const retainedReads = vi.mocked(createReadStream).mock.calls
        .map(([path]) => String(path)).filter((path) => path.startsWith(`${out}\\`) || path.startsWith(`${out}/`));
      expect(retainedReads.sort()).toEqual([
        join(out, "main.cjs"), join(out, "resources/app/package.json"), join(out, "resources/app/runtime.cjs"),
      ].sort());
      expect(vi.mocked(readdir).mock.calls.some(([path]) => path === out)).toBe(false);
      expect(vi.mocked(writeFile).mock.calls.some(([path]) => path === markerPath)).toBe(false);
      expect(await readFile(markerPath, "utf8")).toBe(marker);
    },
  );

  it("invalidates the reuse marker when the write set changes", async () => {
    const fixture = node();
    const target = { from: "payload", to: join(root, "out"), reuse: true, writeSet: [] as string[] };
    const entry = await cache.acquire({ materialize: [target], node: fixture });
    await cache.readHit({ materialize: [{ ...target, writeSet }], node: fixture });
    expect(cache.report().entries.at(-1)?.materialized[0]?.skipped).toBeUndefined();
    expect((await stat(join(entry.entryPath, "payload", "main.cjs"))).ino)
      .not.toBe((await stat(join(target.to, "main.cjs"))).ino);
  });

  it("retires a stale entry without clearing attributes on a live materialization", async () => {
    const fixture = node();
    const target = { from: "payload", to: join(root, "out"), writeSet };
    const entry = await cache.acquire({ materialize: [target], node: fixture });
    const live = join(target.to, "locales/en-US.pak");
    const before = await stat(live);
    await cache.acquire({ materialize: [], node: { ...fixture, invalidate: async () => ({ reason: "forced stale" }) } });
    expect((await stat(live)).ino).toBe(before.ino);
    expect((await stat(live)).mode).toBe(before.mode);
    expect(await readFile(live, "utf8")).toBe("original:locales/en-US.pak");
    const retired = (await readdir(dirname(entry.entryPath))).filter((name) => name.includes(".retired-"));
    expect(retired).toHaveLength(1);
    await removeMaterializedTree(target.to);
    const retiredFile = join(dirname(entry.entryPath), retired[0]!, "payload/locales/en-US.pak");
    expect((await stat(retiredFile)).mode).toBe(before.mode);
    expect(await readFile(retiredFile, "utf8")).toBe("original:locales/en-US.pak");
  });

  it("measures 1000 small file copies and links on the same volume", async () => {
    const source = join(root, "benchmark-source");
    const copied = join(root, "benchmark-copy");
    const linked = join(root, "benchmark-link");
    await Promise.all([source, copied, linked].map((path) => mkdir(path)));
    const names = Array.from({ length: 1000 }, (_, index) => `${index}.txt`);
    for (let offset = 0; offset < names.length; offset += 20) {
      await Promise.all(names.slice(offset, offset + 20).map(async (name) => {
        const path = join(source, name);
        await writeFile(path, "x".repeat(256));
        await chmod(path, 0o444);
      }));
    }
    const copyStart = performance.now();
    for (let offset = 0; offset < names.length; offset += 20) {
      await Promise.all(names.slice(offset, offset + 20).map(async (name) => {
        const path = join(copied, name);
        await copyFile(join(source, name), path);
        await chmod(path, 0o666);
      }));
    }
    const copyMs = performance.now() - copyStart;
    const linkStart = performance.now();
    await materializeCacheTree(source, linked, []);
    const linkMs = performance.now() - linkStart;
    expect((await readdir(linked)).length).toBe(1000);
    expect((await stat(join(source, "0.txt"))).ino).toBe((await stat(join(linked, "0.txt"))).ino);
    console.log("MATERIALIZE_BENCHMARK", JSON.stringify({ files: 1000, bytesPerFile: 256, concurrency: 20, copyMs, linkMs, volume: root.slice(0, 2), node: process.version }));
  });
});

describe("packaged app install progress", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function processFixture() {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 43210 });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const terminate = vi.fn(async (pid: number) => {
      expect(pid).toBe(child.pid);
      child.emit("close", null, "SIGTERM");
    });
    return { child, terminate };
  }

  it("kills only the silent idle process tree at 120 seconds", async () => {
    const { child, terminate } = processFixture();
    const sample = vi.fn(async () => [{ identity: "43210:created", cpu: 0, io: 0 }]);
    const done = watchPackagedAppInstall(child, { sample, terminate });
    const rejection = expect(done).rejects.toThrow("packaged-app:npm-install: no output or child CPU/IO progress for 120 s");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish a partially installed cache entry after a stall", async () => {
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "install-"));
    const { child, terminate } = processFixture();
    const cache = new ToolPackCache(join(root, "cache"));
    const started = once(child, "watching");
    const build = cache.acquire({
      materialize: [],
      node: {
        id: "stalled-install", key: "one", outputs: ["app"], invalidate: async () => null,
        build: async ({ entryRoot }) => {
          await mkdir(join(entryRoot, "app"));
          await writeFile(join(entryRoot, "app", "partial.txt"), "incomplete");
          const done = watchPackagedAppInstall(child, { sample: async () => [], terminate });
          child.emit("watching");
          await done;
          return {};
        },
      },
    });
    const rejection = expect(build).rejects.toThrow("no output or child CPU/IO progress");
    try {
      await started;
      await vi.advanceTimersByTimeAsync(120_000);
      await rejection;
      expect(await readdir(join(cache.root, "entries", "stalled-install"))).toEqual([]);
      expect(cache.report().entries).toEqual([]);
    } finally {
      await removeMaterializedTree(root);
    }
  });

  it.each(["cpu", "io"] as const)("does not stop a silent child with %s progress", async (counter) => {
    const { child, terminate } = processFixture();
    let ticks = 0;
    const sample = vi.fn(async (): Promise<InstallProcessProgress[]> => [
      { identity: "43210:created", cpu: 0, io: 0 },
      { identity: "43211:compiler", cpu: 0, io: 0, [counter]: ++ticks },
    ]);
    const done = watchPackagedAppInstall(child, { sample, terminate });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(terminate).not.toHaveBeenCalled();
    const closed = once(child, "close");
    child.emit("close", 0, null);
    await closed;
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the idle deadline on output and rejects a failed installer", async () => {
    const { child, terminate } = processFixture();
    const done = watchPackagedAppInstall(child, { sample: async () => [], terminate });
    const rejection = expect(done).rejects.toThrow("packaged-app:npm-install exited 1");
    await vi.advanceTimersByTimeAsync(115_000);
    child.stderr!.emit("data", Buffer.from("install is active"));
    await vi.advanceTimersByTimeAsync(115_000);
    expect(terminate).not.toHaveBeenCalled();
    child.emit("close", 1, null);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["CIM unavailable", "CIM sample timed out"])("keeps a healthy install alive after %s", async (message) => {
    const { child, terminate } = processFixture();
    let ticks = 0;
    const sample = vi.fn(async () => {
      if (++ticks % 2 === 1) throw new Error(message);
      return [{ identity: "43210:created", cpu: ticks, io: 0 }];
    });
    const done = watchPackagedAppInstall(child, { sample, terminate });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(terminate).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat repeated observation errors as evidence of a stall", async () => {
    const { child, terminate } = processFixture();
    const done = watchPackagedAppInstall(child, {
      sample: async () => { throw new Error("CIM unavailable"); }, terminate,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(terminate).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires three consecutive successful idle samples after an observation error", async () => {
    const { child, terminate } = processFixture();
    const sample = vi.fn(async () => [{ identity: "43210:created", cpu: 0, io: 0 }]);
    const done = watchPackagedAppInstall(child, { sample, terminate });
    const rejection = expect(done).rejects.toThrow("no output or child CPU/IO progress");
    await vi.advanceTimersByTimeAsync(115_000);
    sample.mockRejectedValueOnce(new Error("CIM timed out"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for close after termination fails before releasing staging", async () => {
    const { child } = processFixture();
    const terminate = vi.fn(async () => { throw new Error("taskkill denied"); });
    const done = watchPackagedAppInstall(child, { sample: async () => [], terminate });
    const rejection = expect(done).rejects.toThrow("process-tree termination failed: Error: taskkill denied");
    let settled = false;
    void done.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failed", "successful"])("bounds the close wait after %s termination and reports surviving PIDs", async (result) => {
    const { child } = processFixture();
    const terminate = vi.fn(async () => {
      if (result === "failed") throw new Error("taskkill denied");
    });
    const sample = vi.fn(async () => [
      { identity: "43210:created", cpu: 0, io: 0 },
      { identity: "43211:compiler", cpu: 0, io: 0 },
    ]);
    const done = watchPackagedAppInstall(child, { sample, terminate });
    const rejection = expect(done).rejects.toThrow("child did not close within 30 s; surviving PIDs: 43210, 43211");
    await vi.advanceTimersByTimeAsync(149_999);
    expect(terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
