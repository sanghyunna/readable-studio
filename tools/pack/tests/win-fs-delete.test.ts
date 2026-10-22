import { chmod, link, mkdir, mkdtemp, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { removeMaterializedTree } from "../src/cache.js";
import { removeTree } from "../src/win/fs.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, chmod: vi.fn(actual.chmod), rm: vi.fn(actual.rm), unlink: vi.fn(actual.unlink), rmdir: vi.fn(actual.rmdir) };
});

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

describe("Windows output deletion", () => {
  it.each(["file", "tree"] as const)("preserves cache bytes and attributes when deleting a linked %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "readable-delete-link-"));
    try {
      const cacheFile = join(root, "cache.txt");
      const out = join(root, "out");
      await mkdir(join(out, "nested"), { recursive: true });
      const linked = join(out, "nested", "linked.txt");
      await writeFile(cacheFile, "immutable");
      await chmod(cacheFile, 0o444);
      await link(cacheFile, linked);
      const before = await stat(cacheFile);
      vi.mocked(chmod).mockClear();
      vi.mocked(rm).mockClear();
      await removeTree(kind === "file" ? linked : out);
      expect(chmod).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      const after = await stat(cacheFile);
      expect(await readFile(cacheFile, "utf8")).toBe("immutable");
      expect(after.ino).toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      expect(after.nlink).toBe(1);
      await expect(stat(kind === "file" ? linked : out)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeMaterializedTree(root);
    }
  });

  it("accepts a missing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-delete-missing-"));
    try {
      await expect(removeTree(join(root, "missing"))).resolves.toBeUndefined();
    } finally {
      await removeMaterializedTree(root);
    }
  });

  it.each(["EBUSY", "EPERM", "ENOTEMPTY"])("retries transient %s on linked files and directories without chmod", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "readable-delete-retry-"));
    try {
      const cacheFile = join(root, "cache.txt");
      const out = join(root, "out");
      await mkdir(join(out, "nested"), { recursive: true });
      await writeFile(cacheFile, "immutable");
      await chmod(cacheFile, 0o444);
      await link(cacheFile, join(out, "nested", "linked.txt"));
      const before = await stat(cacheFile);
      vi.mocked(chmod).mockClear();
      vi.mocked(delay).mockClear();
      vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await removeTree(out);
      expect(chmod).not.toHaveBeenCalled();
      expect(delay).toHaveBeenCalledTimes(2);
      expect(await readFile(cacheFile, "utf8")).toBe("immutable");
      expect((await stat(cacheFile)).mode).toBe(before.mode);
      expect((await stat(cacheFile)).nlink).toBe(1);
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeMaterializedTree(root);
    }
  });

  it.each(["file", "directory"] as const)("retries a top-level %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "readable-delete-top-"));
    try {
      const out = join(root, "out");
      if (kind === "directory") await mkdir(out);
      else await writeFile(out, "private");
      const operation = kind === "directory" ? rmdir : unlink;
      vi.mocked(operation).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
      await removeTree(out);
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeMaterializedTree(root);
    }
  });

  it.each(["EBUSY", "EACCES"])("bounds deletion attempts for %s", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "readable-delete-bound-"));
    try {
      const out = join(root, "out");
      await writeFile(out, "private");
      vi.mocked(unlink).mockClear();
      vi.mocked(delay).mockClear();
      vi.mocked(unlink).mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(removeTree(out)).rejects.toMatchObject({ code });
      expect(unlink).toHaveBeenCalledTimes(code === "EBUSY" ? 20 : 1);
      expect(delay).toHaveBeenCalledTimes(code === "EBUSY" ? 19 : 0);
    } finally {
      vi.mocked(unlink).mockReset();
      await removeMaterializedTree(root);
    }
  });
});
