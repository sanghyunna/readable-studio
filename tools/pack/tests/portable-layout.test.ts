import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";
import { PRODUCT_NAME, RESOURCE_TREE_NAME, WEB_STANDALONE_RESOURCE_NAME } from "../src/win/constants.js";
import { resolveWinPaths } from "../src/win/paths.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("Windows portable layout", () => {
  it("uses the Readable Studio artifact and standalone resource names", () => {
    expect(PRODUCT_NAME).toBe("Readable Studio");
    expect(RESOURCE_TREE_NAME).toBe("readable-studio");
    expect(WEB_STANDALONE_RESOURCE_NAME).toBe("readable-studio-web-standalone");
  });

  it.each(["1.2.1", "1.2.2", "1.2.3-beta.4", "1.2.3.nightly.5"])(
    "never includes version %s or the namespace in the portable artifact name",
    (appVersion) => {
      const config = resolveToolPackConfig("win", { appVersion, namespace: `release-${appVersion}` });
      const artifactName = basename(resolveWinPaths(config).setupZipPath);

      expect(artifactName).toBe("Readable-Studio-win-x64-portable.zip");
      expect(artifactName).not.toMatch(/\d+\.\d+\.\d+/);
    },
  );

  it("materializes Electron under app while the archive launch target is top-level", () => {
    const paths = resolveWinPaths(resolveToolPackConfig('win', { namespace: 'layout' }));
    expect(paths.unpackedRoot).toBe(join(paths.appBuilderOutputRoot, 'win-unpacked', 'app'));
    expect(paths.unpackedExePath).toBe(join(paths.unpackedRoot, 'Readable Studio.exe'));
  });

  it("keeps the root build entrypoint on the canonical artifact identity", () => {
    const source = readFileSync(join(REPOSITORY_ROOT, "build-portable.ps1"), "utf8");

    expect(source.match(/^\$ArtifactName = "([^"]+)"/m)?.[1]).toBe("Readable-Studio-win-x64-portable.zip");
    expect(source).toContain("$DropPath = Join-Path $dropDirRoot $ArtifactName");
    expect(source).not.toContain("$DropArtifactName");
    expect(source).toContain("Readable Studio portable build");
    expect(source).not.toContain(["Open", "Design"].join(" "));
    expect(source).not.toMatch(/OpenDesignData|0\.1\.5/);
  });
});
