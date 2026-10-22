import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPackCache } from "../src/cache.js";
import { withDirectoryLock } from "../src/lock.js";

vi.mock("../src/lock.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lock.js")>();
  // Observe actual filesystem lock scopes without replacing lock behavior.
  return { ...original, withDirectoryLock: vi.fn(original.withDirectoryLock) };
});
beforeEach(() => vi.clearAllMocks());

describe("cache producer concurrency", () => {
  it("does not expose a partial generation while its producer is held", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-cache-publish-"));
    const cache = new ToolPackCache(join(root, "cache"));
    const events = new EventEmitter();
    const staged = once(events, "staged", { signal: AbortSignal.timeout(3000) });
    const release = Promise.withResolvers<void>();
    const keyHash = createHash("sha256").update("atomic\none").digest("hex");
    const published = join(cache.root, "entries", "atomic", keyHash);
    const acquisition = cache.acquire({
      materialize: [],
      node: {
        id: "atomic", key: "one", outputs: ["payload"], invalidate: async () => null,
        build: async ({ entryRoot }) => {
          await writeFile(join(entryRoot, "payload"), "partial");
          events.emit("staged", entryRoot);
          await release.promise;
          await writeFile(join(entryRoot, "payload"), "complete");
          return {};
        },
      },
    });
    try {
      const [staging] = await staged;
      await expect(readFile(join(published, "payload"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(staging, "complete.json"))).rejects.toMatchObject({ code: "ENOENT" });
      release.resolve();
      const result = await acquisition;
      expect(result.entryPath).toBe(published);
      expect(await readFile(join(published, "payload"), "utf8")).toBe("complete");
      expect(JSON.parse(await readFile(join(published, "complete.json"), "utf8")).key).toBe("one");
    } finally {
      release.resolve();
      await Promise.allSettled([acquisition]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the same destination lock across different nodes and readHit restores", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-cache-destination-lock-"));
    const cache = new ToolPackCache(join(root, "cache"));
    const out = join(root, "shared");
    const node = (id: string) => ({
      id, key: "one", outputs: ["payload"], invalidate: async () => null,
      build: async ({ entryRoot }: { entryRoot: string }) => { await writeFile(join(entryRoot, "payload"), id); return {}; },
    });
    try {
      await cache.acquire({ materialize: [{ from: "payload", to: out }], node: node("first") });
      await cache.acquire({ materialize: [{ from: "payload", to: out }], node: node("second") });
      await cache.readHit({ materialize: [{ from: "payload", to: out }], node: node("first") });
      const scopes = vi.mocked(withDirectoryLock).mock.calls.map(([, name]) => name).filter((name) => name.startsWith("materialize-"));
      expect(scopes).toHaveLength(3);
      expect(new Set(scopes).size).toBe(1);
      expect(await readFile(out, "utf8")).toBe("first");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("starts independent node producers without waiting for a held sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-cache-parallel-"));
    const cache = new ToolPackCache(join(root, "cache"));
    const events = new EventEmitter();
    const firstStarted = once(events, "first", { signal: AbortSignal.timeout(3000) });
    const secondStarted = once(events, "second", { signal: AbortSignal.timeout(3000) });
    const release = Promise.withResolvers<void>();
    const node = (name: string) => ({
      id: name, key: "one", outputs: ["payload"], invalidate: async () => null,
      build: async ({ entryRoot }: { entryRoot: string }) => {
        events.emit(name);
        if (name === "first") await release.promise;
        await writeFile(join(entryRoot, "payload"), name);
        return {};
      },
    });
    const first = cache.acquire({ materialize: [], node: node("first") });
    let second: Promise<unknown> | undefined;
    try {
      await firstStarted;
      second = cache.acquire({ materialize: [], node: node("second") });
      await secondStarted;
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps one producer for concurrent requests of the same node/key", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-cache-single-producer-"));
    const cache = new ToolPackCache(join(root, "cache"));
    let builds = 0;
    const node = {
      id: "same", key: "one", outputs: ["payload"], invalidate: async () => null,
      build: async ({ entryRoot }: { entryRoot: string }) => {
        builds += 1;
        await mkdir(join(entryRoot, "payload"));
        await writeFile(join(entryRoot, "payload", "bytes"), "same bytes");
        return {};
      },
    };
    try {
      await Promise.all(["first", "second"].map((name) => cache.acquire({
        materialize: [{ from: "payload", to: join(root, name) }], node,
      })));
      expect(builds).toBe(1);
      expect(await readFile(join(root, "first", "bytes"))).toEqual(await readFile(join(root, "second", "bytes")));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
