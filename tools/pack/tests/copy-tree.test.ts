import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyTreeConcurrent } from "../src/copy-tree.js";

describe("bounded tree materialization", () => {
  it("matches recursive cp bytes, modes, hidden files and empty directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-copy-"));
    try {
      const source = join(root, "source");
      await mkdir(join(source, "nested", "empty"), { recursive: true });
      const names = [".hidden", "한글.txt", ...Array.from({ length: 140 }, (_, i) => `file-${i}`)];
      await Promise.all(names.map((name, i) => writeFile(join(source, "nested", name), Buffer.from([i, 0, 255]))));
      await cp(source, join(root, "reference"), { recursive: true });
      await copyTreeConcurrent(source, join(root, "candidate"));
      expect((await readdir(join(root, "candidate", "nested"))).sort()).toEqual((await readdir(join(root, "reference", "nested"))).sort());
      expect((await stat(join(root, "candidate", "nested", "empty"))).isDirectory()).toBe(true);
      for (const name of names) {
        expect(await readFile(join(root, "candidate", "nested", name))).toEqual(await readFile(join(root, "reference", "nested", name)));
        expect((await stat(join(root, "candidate", "nested", name))).mode).toBe((await stat(join(root, "reference", "nested", name))).mode);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("propagates source errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-copy-error-"));
    try { await expect(copyTreeConcurrent(join(root, "missing"), join(root, "out"))).rejects.toThrow(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
