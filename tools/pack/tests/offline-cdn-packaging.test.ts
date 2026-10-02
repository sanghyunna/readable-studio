import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyBundledResourceTrees } from "../src/resources.js";

type Manifest = {
  libraries: { lib: string; major: number; version: string; files: string[] }[];
};

const sourceRoot = resolve(import.meta.dirname, "../../../vendor/offline-cdn");

describe("offline CDN packaged resources", () => {
  it("ships the manifest and every listed asset byte-for-byte in the daemon resource layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-offline-cdn-packaging-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "app", "resources", "readable-studio");
    try {
      for (const directory of [
        "skills", "design-templates", "design-systems", "craft",
        "plugins/_official", "plugins/registry", "assets/frames",
        "assets/community-pets", "data/plugin-previews",
      ]) {
        await mkdir(join(workspaceRoot, directory), { recursive: true });
      }
      await cp(sourceRoot, join(workspaceRoot, "vendor", "offline-cdn"), { recursive: true });
      await copyBundledResourceTrees({ workspaceRoot, resourceRoot });
      const originalManifest = await readFile(join(sourceRoot, "manifest.json"));
      const packagedRoot = join(resourceRoot, "offline-cdn");
      expect(await readFile(join(packagedRoot, "manifest.json"))).toEqual(originalManifest);
      const manifest = JSON.parse(originalManifest.toString()) as Manifest;
      expect(manifest.libraries.map(({ lib, major }) => `${lib}/${major}`)).toEqual([
        "fontawesome/4", "fontawesome/5", "fontawesome/6", "fontawesome/7",
        "chartjs/2", "chartjs/3", "chartjs/4",
      ]);
      for (const library of manifest.libraries) {
        expect(library.files.length).toBeGreaterThan(0);
        expect(library.files).toEqual([...library.files].sort());
        for (const file of library.files) {
          const relative = join(library.lib, String(library.major), file);
          const packaged = await readFile(join(packagedRoot, relative));
          const source = await readFile(join(sourceRoot, relative));
          expect(createHash("sha256").update(packaged).digest("hex")).toBe(
            createHash("sha256").update(source).digest("hex"),
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
