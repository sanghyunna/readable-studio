import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { createBuildEventWriter, type BuildEvent, type BuildReceipt } from "../src/build-events.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("build event receipts", () => {
  it("atomically renames a complete receipt before publishing sorted manifest hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "build-events-"));
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const order: string[] = [];
    const events = join(root, "events.jsonl");
    try {
      await mkdir(join(root, "output", ".hidden"), { recursive: true });
      await writeFile(join(root, "output", "z.txt"), "last");
      await writeFile(join(root, "output", ".hidden", "a.txt"), "first");
      vi.mocked(rename).mockImplementationOnce(async (source, target) => {
        expect(String(source)).toBe(`${target}.tmp`);
        expect(existsSync(target)).toBe(false);
        const receipt = JSON.parse(await readFile(source, "utf8")) as BuildReceipt;
        expect(receipt.files).toHaveLength(2);
        expect(existsSync(events)).toBe(false);
        order.push("rename");
        await real.rename(source, target);
      });
      vi.mocked(appendFileSync).mockImplementationOnce((path, data, options) => {
        const event = JSON.parse(String(data)) as BuildEvent;
        expect(existsSync(event.receipt!)).toBe(true);
        expect(existsSync(`${event.receipt}.tmp`)).toBe(false);
        const receipt = JSON.parse(readFileSync(event.receipt!, "utf8")) as BuildReceipt;
        expect(receipt.manifestHash).toBe(event.outputManifestHash);
        order.push("append");
        realFs.appendFileSync(path, data, options);
      });
      const writer = createBuildEventWriter({ READABLE_BUILD_EVENTS: events, READABLE_BUILD_RUN_ID: "run-1" })!;
      const receipt = await writer.ready({
        event: "node-ready", node: "@readable-studio/contracts", inputHash: "input",
        outputRoot: join(root, "output"),
      });
      expect(order).toEqual(["rename", "append"]);
      expect(receipt.files).toEqual([
        { path: ".hidden/a.txt", size: 5, sha256: createHash("sha256").update("first").digest("hex") },
        { path: "z.txt", size: 4, sha256: createHash("sha256").update("last").digest("hex") },
      ]);
      expect(receipt.manifestHash).toBe(createHash("sha256").update(JSON.stringify(receipt.files)).digest("hex"));
      const event = JSON.parse(await readFile(events, "utf8")) as BuildEvent;
      expect(event).toMatchObject({ v: 1, runId: "run-1", event: "node-ready", inputHash: "input" });
      expect(new Date(event.ts).toISOString()).toBe(event.ts);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes a single ZIP file receipt and graph and failure events", async () => {
    const root = await mkdtemp(join(tmpdir(), "build-zip-events-"));
    try {
      await writeFile(join(root, "artifact.zip"), "zip bytes");
      const writer = createBuildEventWriter({
        READABLE_BUILD_EVENTS: join(root, "events.jsonl"), READABLE_BUILD_RUN_ID: "zip-run",
      })!;
      const packages = [{ name: "a", dir: root, dependencies: [], inputHash: "hash" }];
      await writer.graphReady(packages);
      const receipt = await writer.ready({
        event: "zip-ready", node: "zip", inputHash: "zip-input", outputRoot: root, paths: ["artifact.zip"],
      });
      await writer.failed("final-tree", "tree-input", new Error("broken tree"));
      expect(receipt.files).toHaveLength(1);
      expect(receipt.files[0]).toMatchObject({ path: "artifact.zip", size: 9 });
      const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(["graph-ready", "zip-ready", "failed"]);
      expect(events[0].packages).toEqual(packages);
      expect(events[1].packages).toBeUndefined();
      expect(events[2]).toMatchObject({ node: "final-tree", error: "broken tree", receipt: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes no ready event if the atomic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "build-event-failure-"));
    try {
      await writeFile(join(root, "output.txt"), "output");
      const events = join(root, "events.jsonl");
      const writer = createBuildEventWriter({ READABLE_BUILD_EVENTS: events, READABLE_BUILD_RUN_ID: "fail" })!;
      vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
      await expect(writer.ready({
        event: "final-tree-ready", node: "final-tree", inputHash: "hash", outputRoot: root, paths: ["output.txt"],
      })).rejects.toThrow("rename failed");
      expect(existsSync(events)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does nothing when events are unset and rejects incomplete enabled configuration", () => {
    expect(createBuildEventWriter({ READABLE_BUILD_RUN_ID: "unused" })).toBeUndefined();
    expect(() => createBuildEventWriter({ READABLE_BUILD_EVENTS: "relative.jsonl" })).toThrow("absolute");
    expect(() => createBuildEventWriter({ READABLE_BUILD_EVENTS: join(tmpdir(), "events.jsonl") })).toThrow("RUN_ID");
  });
});
