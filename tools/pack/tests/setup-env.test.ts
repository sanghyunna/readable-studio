import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBuildEventWriter, type BuildEvent } from "../src/build-events.js";

const keys = ["READABLE_BUILD_EVENTS", "READABLE_BUILD_RUN_ID", "READABLE_BUILD_CONCURRENCY"] as const;
const initialEnv = keys.map((key) => process.env[key]);
const initialWriter = createBuildEventWriter();

afterEach(() => { vi.unstubAllEnvs(); });

describe("test build environment isolation", () => {
  it("clears inherited build variables before the test module executes", () => {
    expect(initialEnv).toEqual([undefined, undefined, undefined]);
    expect(initialWriter).toBeUndefined();
  });

  it("deletes all three build variables from a populated environment", async () => {
    vi.stubEnv("READABLE_BUILD_EVENTS", join(tmpdir(), "inherited-events.jsonl"));
    vi.stubEnv("READABLE_BUILD_RUN_ID", "inherited-run");
    vi.stubEnv("READABLE_BUILD_CONCURRENCY", "20");
    vi.resetModules();
    await import("./setup-env.js");
    for (const key of keys) expect(process.env).not.toHaveProperty(key);
    expect(createBuildEventWriter()).toBeUndefined();
  });

  it("allows explicit event and receipt writes only to the test's temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-env-"));
    try {
      const events = join(root, "events.jsonl");
      vi.stubEnv("READABLE_BUILD_EVENTS", events);
      vi.stubEnv("READABLE_BUILD_RUN_ID", "test-run");
      await writeFile(join(root, "output.txt"), "output");
      const writer = createBuildEventWriter()!;
      await writer.ready({
        event: "node-ready", node: "test-node", inputHash: "test-input",
        outputRoot: root, paths: ["output.txt"],
      });
      const event = JSON.parse(await readFile(events, "utf8")) as BuildEvent;
      expect(event.runId).toBe("test-run");
      expect(event.receipt!.startsWith(`${root}${sep}`)).toBe(true);
      expect(JSON.parse(await readFile(event.receipt!, "utf8"))).toMatchObject({
        node: "test-node", outputRoot: root, files: [{ path: "output.txt", size: 6 }],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
