import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CACHE_SCHEMA_VERSION, ToolPackCache, privatizeForWrite, removeMaterializedTree } from "../src/cache.js";
import { resolveToolPackConfig } from "../src/config.js";
import { materializeCachedUnpackedForPortableZip } from "../src/win/builder.js";
import { resolveWinPaths } from "../src/win/paths.js";
import { readWinExecutableVersionSnapshot } from "../src/win/version-resource.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function fixtureNode() {
  return {
    id: "immutable", key: "input-one", outputs: ["payload"], invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }) => {
      await mkdir(join(entryRoot, "payload"));
      await writeFile(join(entryRoot, "payload", "value.txt"), "original");
      await utimes(join(entryRoot, "payload", "value.txt"), 1_600_000_000, 1_600_000_000);
      return {};
    },
  };
}

describe("immutable cache publication", () => {
  let root: string;
  let cache: ToolPackCache;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "readable-cache-immutable-"));
    cache = new ToolPackCache(join(root, "cache"));
  });
  afterEach(async () => {
    await removeMaterializedTree(root);
  });

  it("keeps cache hashes and attributes unchanged through all four private stamp writes", async () => {
    const writeSet = [
      "resources/app/main.cjs", "resources/app/package.json",
      "resources/readable-studio-config.json", "Readable Studio.exe",
    ];
    const node = {
      id: "stamping", key: "shared", outputs: ["payload"], invalidate: async () => null,
      build: async ({ entryRoot }: { entryRoot: string }) => {
        const payload = join(entryRoot, "payload");
        await mkdir(join(payload, "resources", "app"), { recursive: true });
        await writeFile(join(payload, writeSet[0]!), "original");
        await writeFile(join(payload, writeSet[1]!), JSON.stringify({ version: "1.0.0" }));
        await writeFile(join(payload, writeSet[2]!), JSON.stringify({ namespace: "original", appVersion: "1.0.0" }));
        const exe = NtExecutable.createEmpty(false, false);
        const resource = NtExecutableResource.from(exe);
        const version = Resource.VersionInfo.createEmpty();
        version.setFileVersion("1.0.0.0", 1033);
        version.setProductVersion("1.0.0.0", 1033);
        version.outputToResourceEntries(resource.entries);
        resource.outputResource(exe);
        await writeFile(join(payload, writeSet[3]!), Buffer.from(exe.generate()));
        return {};
      },
    };
    const manifest = await cache.acquire({ materialize: [], node });
    const source = join(manifest.entryPath, "payload");
    const snapshot = () => Promise.all([...manifest.files.map(({ path }) => path), "manifest.json", "complete.json"]
      .map(async (path) => {
        const file = join(manifest.entryPath, path);
        const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
        return { path, sha256: sha256(bytes), mode: metadata.mode };
      }));
    const before = await snapshot();
    const outputs = await Promise.all(["first", "second"].map(async (namespace, index) => {
      const appVersion = `1.0.${index + 1}`;
      const paths = resolveWinPaths(resolveToolPackConfig("win", { dir: root, namespace, appVersion }));
      for (const path of writeSet) {
        const output = join(paths.unpackedRoot, path);
        await mkdir(dirname(output), { recursive: true });
        await link(join(source, path), output);
        await privatizeForWrite(output);
      }
      await mkdir(dirname(paths.packagedConfigPath), { recursive: true });
      await writeFile(paths.packagedConfigPath, JSON.stringify({ namespace, appVersion }));
      await writeFile(join(paths.unpackedRoot, writeSet[0]!), namespace);
      await materializeCachedUnpackedForPortableZip(paths, appVersion);
      return { namespace, appVersion, paths };
    }));
    for (const { namespace, appVersion, paths } of outputs) {
      expect(await readFile(join(paths.unpackedRoot, writeSet[0]!), "utf8")).toBe(namespace);
      expect(JSON.parse(await readFile(join(paths.unpackedRoot, writeSet[1]!), "utf8")).version).toBe(appVersion);
      expect(JSON.parse(await readFile(join(paths.unpackedRoot, writeSet[2]!), "utf8"))).toEqual({ namespace, appVersion });
      expect((await readWinExecutableVersionSnapshot(paths.unpackedExePath)).fixedFileVersion).toBe(`${appVersion}.0`);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("privatizes a read-only hardlink before changing bytes or attributes", async () => {
    const original = join(root, "cache.txt");
    const output = join(root, "out.txt");
    await writeFile(original, "original");
    await chmod(original, 0o444);
    await link(original, output);
    const before = await stat(original);
    expect((await stat(output)).ino).toBe(before.ino);
    await privatizeForWrite(output);
    await chmod(output, 0o666);
    await writeFile(output, "namespace-one");
    expect((await stat(output)).ino).not.toBe(before.ino);
    expect(await readFile(original, "utf8")).toBe("original");
    expect((await stat(original)).mode).toBe(before.mode);
    expect((await stat(original)).mode & 0o200).toBe(0);
    expect((await stat(output)).mode & 0o200).not.toBe(0);
  });

  it("seals a complete file inventory before exposing a generation", async () => {
    const manifest = await cache.acquire({ materialize: [], node: fixtureNode() });
    const metadata = await stat(join(manifest.entryPath, "payload/value.txt"));
    expect(manifest.files).toEqual([{
      path: "payload/value.txt", size: 8, mtimeMs: metadata.mtimeMs, mode: metadata.mode, kind: "file",
    }]);
    const rawManifest = await readFile(join(manifest.entryPath, "manifest.json"));
    expect(JSON.parse(await readFile(join(manifest.entryPath, "complete.json"), "utf8"))).toEqual({
      key: "input-one", nodeId: "immutable", schemaVersion: CACHE_SCHEMA_VERSION,
      manifestSha256: sha256(rawManifest),
    });
    for (const path of ["payload/value.txt", "manifest.json", "complete.json"]) {
      expect((await stat(join(manifest.entryPath, path))).mode & 0o200).toBe(0);
    }
  });

  it.each(["missing", "key", "digest", "payload", "size", "mtime", "mode"])("rejects a %s completion marker or payload", async (damage) => {
    const node = fixtureNode();
    const manifest = await cache.acquire({ materialize: [], node });
    const markerPath = join(manifest.entryPath, "complete.json");
    if (damage === "missing") await rm(markerPath, { force: true });
    else if (["payload", "size", "mtime", "mode"].includes(damage)) {
      const path = join(manifest.entryPath, "payload", "value.txt");
      const metadata = await stat(path);
      if (damage === "mtime") await utimes(path, metadata.atime, new Date(metadata.mtimeMs + 60_000));
      else {
        await chmod(path, 0o666);
        if (damage !== "mode") {
          await writeFile(path, damage === "size" ? "different size" : "modified");
          await chmod(path, metadata.mode);
          // Isolate size validation from mtime and mode validation.
          if (damage === "size") await utimes(path, metadata.atime, metadata.mtime);
        }
      }
    } else {
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (damage === "key") marker.key = "other-input";
      else marker.manifestSha256 = "0".repeat(64);
      await privatizeForWrite(markerPath);
      await writeFile(markerPath, JSON.stringify(marker));
    }
    expect(await cache.readHit({ materialize: [], node })).toBeNull();
    await cache.acquire({ materialize: [], node });
    expect(cache.report().entries.at(-1)?.status).toBe("stale");
    expect(await readFile(join(manifest.entryPath, "payload", "value.txt"), "utf8")).toBe("original");
  });

  it.each([
    { method: "acquire", change: "none" }, { method: "acquire", change: "content" }, { method: "acquire", change: "key" },
    { method: "readHit", change: "none" }, { method: "readHit", change: "content" }, { method: "readHit", change: "key" },
  ] as const)("validates required files before $method reuse (change=$change)", async ({ method, change }) => {
    const out = join(root, "output");
    const node = fixtureNode();
    const materialize = [{ from: "payload", to: out, reuse: true, reuseRequiredPaths: [["value.txt"]] }];
    await cache.acquire({ materialize, node });
    if (change === "content") {
      const path = join(out, "value.txt");
      const metadata = await stat(path);
      await writeFile(path, "modified");
      await utimes(path, metadata.atime, metadata.mtime);
      expect((await stat(path)).mtimeMs).toBe(metadata.mtimeMs);
    }
    if (change === "key") {
      const markerPath = join(cache.root, "materialized", sha256(out), "marker.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      marker.keyHash = "different-input";
      await writeFile(markerPath, JSON.stringify(marker));
    }
    await cache[method]({ materialize, node });
    expect(cache.report().entries.at(-1)?.materialized[0]?.skipped).toBe(change === "none" ? true : undefined);
    expect(await readFile(join(out, "value.txt"), "utf8")).toBe("original");
  });
});
