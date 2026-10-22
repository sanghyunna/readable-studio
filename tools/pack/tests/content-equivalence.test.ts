import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertPortableContentEquivalent, compareSealedPortableContent, portableContentInventory, portableContentManifest } from "../src/content-equivalence.js";
import type { PortableContentFile } from "../src/content-equivalence.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

describe("portable content equivalence", () => {
  it("produces the serial manifest byte-for-byte and filters before hashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-parallel-content-"));
    const paths = [
      "2", "10", ".hidden", "empty", "excluded.bin", "app/Z.bin", "app/a.bin",
      ...Array.from({ length: 45 }, (_, index) => `app/payload-${index}.bin`),
    ];
    const include = (path: string) => path !== "excluded.bin";
    try {
      await mkdir(join(root, "app"));
      for (const [index, path] of paths.entries()) {
        await writeFile(join(root, path), path === "empty" ? Buffer.alloc(0) : Buffer.alloc(index * 4097 + 1, index));
      }
      await chmod(join(root, ".hidden"), 0o444);
      // Reproduce the original serial hash object, then its second metadata pass.
      const hashes: Record<string, string> = {};
      for (const path of [...paths].sort()) {
        const metadata = await lstat(join(root, path));
        expect(metadata.isFile()).toBe(true);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(join(root, path))) hash.update(chunk);
        hashes[path] = hash.digest("hex");
      }
      const files: PortableContentFile[] = [];
      const readOnlyFiles: string[] = [];
      for (const [path, sha256] of Object.entries(hashes)) {
        if (!include(path)) continue;
        const metadata = await lstat(join(root, path));
        files.push({ path, size: metadata.size, sha256 });
        if ((metadata.mode & 0o222) === 0) readOnlyFiles.push(path);
      }
      vi.mocked(createReadStream).mockClear();
      const parallel = await portableContentInventory(root, include);
      expect(JSON.stringify(parallel)).toBe(JSON.stringify({ manifest: { v: 1, files }, readOnlyFiles }));
      const hashedPaths = vi.mocked(createReadStream).mock.calls.map(([path]) => path);
      expect(hashedPaths).toHaveLength(paths.length - 1);
      expect(hashedPaths).not.toContain(join(root, "excluded.bin"));
      expect(JSON.stringify(await portableContentManifest(root))).toBe(JSON.stringify(hashes));
      expect((await portableContentInventory(root, () => false)).manifest.files).toEqual([]);
    } finally {
      await chmod(join(root, ".hidden"), 0o666);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects locale-set, byte-size, wrong-root and read-only extraction differences", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-sealed-content-"));
    try {
      await mkdir(join(root, "app", "locales"), { recursive: true });
      await writeFile(join(root, "Readable Studio.exe"), "launcher");
      await writeFile(join(root, "app", "locales", "en-US.pak"), "locale");
      const { manifest } = await portableContentInventory(root);
      expect((await compareSealedPortableContent(manifest, root)).equal).toBe(true);
      const wrongSize = { ...manifest, files: manifest.files.map((file) => ({ ...file, size: file.size + 1 })) };
      expect((await compareSealedPortableContent(wrongSize, root)).error).toContain("sizes differ");
      expect((await compareSealedPortableContent(manifest, join(root, "app"))).equal).toBe(false);
      await writeFile(join(root, "app", "locales", "fr.pak"), "extra");
      expect((await compareSealedPortableContent(manifest, root)).error).toContain("fr.pak");
      await rm(join(root, "app", "locales", "fr.pak"));
      await chmod(join(root, "Readable Studio.exe"), 0o444);
      const readonly = await compareSealedPortableContent(manifest, root);
      expect(readonly.equal).toBe(false);
      expect(readonly.readOnlyFiles).toEqual(["Readable Studio.exe"]);
    } finally {
      await chmod(join(root, "Readable Studio.exe"), 0o666);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("checks every file path and SHA-256, including hidden files and same-size changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-content-gate-"));
    const expected = join(root, "expected");
    const actual = join(root, "actual");
    try {
      for (const directory of [expected, actual]) {
        await mkdir(join(directory, "app"), { recursive: true });
        await writeFile(join(directory, "app", "payload.bin"), Buffer.from([0, 1, 2, 3]));
        await writeFile(join(directory, ".hidden"), "hidden");
      }
      expect(await assertPortableContentEquivalent(expected, actual)).toBe(2);
      expect(Object.keys(await portableContentManifest(actual))).toEqual([".hidden", "app/payload.bin"]);
      await writeFile(join(actual, "app", "payload.bin"), Buffer.from([0, 1, 2, 4]));
      await expect(assertPortableContentEquivalent(expected, actual)).rejects.toThrow('"changed":["app/payload.bin"]');
      await rm(join(actual, ".hidden"));
      await writeFile(join(actual, "extra"), "extra");
      await expect(assertPortableContentEquivalent(expected, actual)).rejects.toThrow('"missing":[".hidden"],"extra":["extra"]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
