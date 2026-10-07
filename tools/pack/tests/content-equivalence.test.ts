import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPortableContentEquivalent, portableContentManifest } from "../src/content-equivalence.js";

describe("portable content equivalence", () => {
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
