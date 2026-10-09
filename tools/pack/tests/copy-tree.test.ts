import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  it.each([false, true])("matches cp for directory links with dereference=%s", async (dereference) => {
    const root = await mkdtemp(join(tmpdir(), "pack-copy-links-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await mkdir(source);
      await mkdir(join(target, "empty"), { recursive: true });
      await writeFile(join(target, "payload"), "linked bytes");
      await symlink(target, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
      await cp(source, join(root, "reference"), { recursive: true, dereference });
      await copyTreeConcurrent(source, join(root, "candidate"), { dereference });
      expect(await readFile(join(root, "candidate", "linked", "payload"))).toEqual(await readFile(join(root, "reference", "linked", "payload")));
      expect((await stat(join(root, "candidate", "linked", "empty"))).isDirectory()).toBe(true);
      if (!dereference) expect(await readlink(join(root, "candidate", "linked"))).toBe(await readlink(join(root, "reference", "linked")));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a dangling dereferenced link and drains copies before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-copy-dangling-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(source, `file-${i}`), "payload")));
      await symlink(join(root, "missing"), join(source, "dangling"), process.platform === "win32" ? "junction" : "dir");
      await expect(copyTreeConcurrent(source, join(root, "out"), { dereference: true })).rejects.toMatchObject({ code: "ENOENT" });
      await rm(join(root, "out"), { recursive: true, force: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("propagates source errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-copy-error-"));
    try { await expect(copyTreeConcurrent(join(root, "missing"), join(root, "out"))).rejects.toThrow(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
