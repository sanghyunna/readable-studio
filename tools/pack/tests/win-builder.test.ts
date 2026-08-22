import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { describe, expect, it } from "vitest";

import { hashJson } from "../src/cache.js";
import type { ToolPackConfig } from "../src/config.js";
import {
  buildWinPortableZipCacheKeyInput,
  materializeCachedUnpackedForPortableZip,
} from "../src/win/builder.js";
import type { WinPaths } from "../src/win/types.js";
import { readWinExecutableVersionSnapshot } from "../src/win/version-resource.js";

function createPaths(root: string): WinPaths {
  const namespaceRoot = join(root, "namespaces", "second");
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", "prebundled"),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-cli.mjs"),
    daemonPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", "prebundled", "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-sidecar.mjs"),
    packagedConfigPath: join(namespaceRoot, "readable-studio-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "packaged-main.mjs"),
    resourceRoot: join(namespaceRoot, "resources", "readable-studio"),
    setupZipPath: join(namespaceRoot, "builder", "Readable Studio-second-portable.zip"),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "web-sidecar.mjs"),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", "win-unpacked", "Readable Studio.exe"),
    unpackedRoot: join(namespaceRoot, "builder", "win-unpacked"),
  };
}

describe("Windows portable builder update-feed absence", () => {
  it("does not configure publish metadata or a generic feed", () => {
    // Given the electron-builder configuration source
    const builderSource = readFileSync(new URL("../src/win/builder.ts", import.meta.url), "utf8");

    // When publish/feed configuration tokens are selected
    const retainedTokens = ["publish:", 'provider: "generic"', "updates.invalid"].filter((token) =>
      builderSource.includes(token),
    );

    // Then a portable build cannot emit updater feed metadata
    expect(retainedTokens).toEqual([]);
  });
});

describe("materializeCachedUnpackedForPortableZip", () => {
  it("overwrites cached packaged config and app package version", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-builder-"));
    const cachedUnpackedRoot = join(root, "cache", "builder", "win-unpacked");
    const paths = createPaths(root);

    try {
      await mkdir(join(cachedUnpackedRoot, "resources"), { recursive: true });
      await writeFile(join(cachedUnpackedRoot, "Readable Studio.exe"), await createVersionedExecutable("0.5.0-beta.1"));
      await writeFile(
        join(cachedUnpackedRoot, "resources", "readable-studio-config.json"),
        `${JSON.stringify({ namespace: "first", version: 1 })}\n`,
        "utf8",
      );
      await mkdir(join(cachedUnpackedRoot, "resources", "app"), { recursive: true });
      await writeFile(
        join(cachedUnpackedRoot, "resources", "app", "package.json"),
        `${JSON.stringify({ name: "readable-studio-packaged-app", version: "0.5.0-beta.1" })}\n`,
        "utf8",
      );
      await mkdir(join(paths.packagedConfigPath, ".."), { recursive: true });
      await writeFile(
        paths.packagedConfigPath,
        `${JSON.stringify({ appVersion: "0.5.0-beta.2", namespace: "second", version: 1 })}\n`,
        "utf8",
      );

      const manifest = await materializeCachedUnpackedForPortableZip(cachedUnpackedRoot, paths, "0.5.0-beta.2");

      expect(manifest.source).toBe("namespace");
      expect(manifest.unpackedRoot).toBe(paths.unpackedRoot);
      await expect(readFile(join(paths.unpackedRoot, "resources", "readable-studio-config.json"), "utf8")).resolves.toContain(
        '"namespace":"second"',
      );
      await expect(readFile(join(paths.unpackedRoot, "resources", "app", "package.json"), "utf8")).resolves.toContain(
        '"version": "0.5.0-beta.2"',
      );
      await expect(readFile(join(paths.unpackedRoot, "resources", "readable-studio-config.json"), "utf8")).resolves.toContain(
        '"appVersion":"0.5.0-beta.2"',
      );
      await expect(readWinExecutableVersionSnapshot(join(paths.unpackedRoot, "Readable Studio.exe"))).resolves.toMatchObject({
        fixedFileVersion: "0.5.0.0",
        fixedProductVersion: "0.5.0.0",
        machine: "x64",
        stringTables: [
          {
            values: expect.objectContaining({
              FileDescription: "Readable Studio",
              FileVersion: "0.5.0-beta.2",
              InternalName: "Readable Studio",
              OriginalFilename: "Readable Studio.exe",
              ProductName: "Readable Studio",
              ProductVersion: "0.5.0.0",
            }),
          },
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("Windows portable ZIP cache", () => {
  it("changes the portable zip cache key when compression changes", () => {
    const base = {
      electronBuilderDirKey: "dir-key",
      packagedConfig: `${JSON.stringify({ namespace: "second", portable: true }, null, 2)}\n`,
      namespace: "second",
      packagedAppKey: "app-key",
      packagedVersion: "0.5.0-beta.2",
      portableZipCompression: 5,
      signing: null,
    };

    const defaultCompressionKey = hashJson(buildWinPortableZipCacheKeyInput(base));
    const fastCompressionKey = hashJson(buildWinPortableZipCacheKeyInput({ ...base, portableZipCompression: 1 }));

    expect(fastCompressionKey).not.toBe(defaultCompressionKey);
  });
});

async function createVersionedExecutable(packagedVersion: string): Promise<Buffer> {
  const executable = NtExecutable.createEmpty(false, false);
  const resource = NtExecutableResource.from(executable);
  const version = Resource.VersionInfo.createEmpty();
  version.lang = 1033;
  version.setFileVersion("0.5.0.0", 1033);
  version.setProductVersion("0.5.0.0", 1033);
  version.setStringValues(
    { codepage: 1200, lang: 1033 },
    {
      FileDescription: "Readable Studio",
      FileVersion: packagedVersion,
      ProductName: "Readable Studio",
      ProductVersion: "0.5.0.0",
    },
  );
  version.outputToResourceEntries(resource.entries);
  resource.outputResource(executable);
  return Buffer.from(executable.generate());
}
