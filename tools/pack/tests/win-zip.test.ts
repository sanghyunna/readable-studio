import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createRuntimeDescriptor, type RuntimeDescriptor } from "@readable-studio/sidecar-proto";
import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { winResources } from "../src/resources.js";
import { buildWinPortableZipCacheKeyInput } from "../src/win/builder.js";
import {
  buildWinPortableZip,
  resolvePortableZipCompression,
  resolveWinPortableZipLocalePruneEntries,
  shouldPruneWinPortableZipLocales,
  WIN_PORTABLE_CHROMIUM_LOCALE_PAKS,
} from "../src/win/zip.js";
import type { WinBuiltAppManifest, WinPaths } from "../src/win/types.js";

const execFileAsync = promisify(execFile);

describe("resolvePortableZipCompression", () => {
  it("defaults to release compression when unset", () => {
    expect(resolvePortableZipCompression(undefined)).toBe(5);
  });

  it("accepts local portable overrides within the 7z range", () => {
    expect(resolvePortableZipCompression("1")).toBe(1);
    expect(resolvePortableZipCompression("0")).toBe(0);
  });

  it("rejects compression values outside the 7z range", () => {
    expect(() => resolvePortableZipCompression("10")).toThrow(/must be an integer from 0 to 9/);
    expect(() => resolvePortableZipCompression("fast")).toThrow(/must be an integer from 0 to 9/);
  });
});

describe("Windows portable zip locale pruning", () => {
  it("maps supported app locales to Chromium pak names explicitly", () => {
    expect(WIN_PORTABLE_CHROMIUM_LOCALE_PAKS).toEqual(["en-US.pak", "ko.pak"]);
  });

  it("is guarded to unsigned portable ZIP builds", () => {
    expect(shouldPruneWinPortableZipLocales({ signed: false } as ToolPackConfig)).toBe(true);
    expect(shouldPruneWinPortableZipLocales({ signed: true } as ToolPackConfig)).toBe(false);
  });

  it("selects only unsupported top-level Chromium locale paks", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-tools-pack-locale-prune-"));
    try {
      await mkdir(join(root, "locales"), { recursive: true });
      await writeFile(join(root, "locales", "en-US.pak"), "en", "utf8");
      await writeFile(join(root, "locales", "ko.pak"), "ko", "utf8");
      await writeFile(join(root, "locales", "ja.pak"), "ja", "utf8");
      await writeFile(join(root, "locales", "README.txt"), "keep", "utf8");

      await expect(
        resolveWinPortableZipLocalePruneEntries({
          config: { signed: false } as ToolPackConfig,
          unpackedRoot: root,
        }),
      ).resolves.toEqual(["locales/ja.pak"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

// Integration: drives the real bundled 7z twice (archive, then the portable
// patch pass) and verifies the second pass replaced the config entry in place
// while leaving the rest of the tree intact. Win32-only and tiny.
describe.skipIf(process.platform !== "win32")("buildWinPortableZip portable injection", () => {
  async function buildPortableZipFixture(compression: string | undefined): Promise<{
    extractedConfig: Record<string, unknown>;
    originalConfig: {
      appVersion: string;
      descriptor: RuntimeDescriptor;
      futureField: number;
      namespace: string;
      portable: boolean;
    };
    extractedAppI18nLocales: string[];
    extractedChromiumLocales: string[];
    timings: Awaited<ReturnType<typeof buildWinPortableZip>>;
  }> {
    const root = await mkdtemp(join(tmpdir(), "readable-tools-pack-portable-zip-"));
    const previousCompression = process.env.READABLE_PORTABLE_ZIP_COMPRESSION;
    if (compression == null) {
      delete process.env.READABLE_PORTABLE_ZIP_COMPRESSION;
    } else {
      process.env.READABLE_PORTABLE_ZIP_COMPRESSION = compression;
    }

    try {
      const unpackedRoot = join(root, "win-unpacked");
      await mkdir(join(unpackedRoot, "resources"), { recursive: true });
      // A config WITHOUT a portable flag, WITH an unknown field, and WITH a
      // baked build-machine namespaceBaseRoot — exactly like a non-portable
      // shared unpacked tree's config. The zip copy must gain portable:true
      // and LOSE the baked root (which would otherwise win over the
      // exe-adjacent fallback at runtime).
      const originalConfig = {
        appVersion: "1.2.3",
        descriptor: createRuntimeDescriptor("1.2.3"),
        futureField: 7,
        namespace: "rg",
        portable: true,
      };
      await writeFile(
        join(unpackedRoot, "resources", "readable-studio-config.json"),
        `${JSON.stringify(originalConfig, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(unpackedRoot, "Readable Studio.exe"), "fake-exe", "utf8");
      await writeFile(join(unpackedRoot, "resources", "app.txt"), "fake-resource", "utf8");
      await mkdir(join(unpackedRoot, "locales"), { recursive: true });
      await writeFile(join(unpackedRoot, "locales", "en-US.pak"), "en", "utf8");
      await writeFile(join(unpackedRoot, "locales", "ko.pak"), "ko", "utf8");
      await writeFile(join(unpackedRoot, "locales", "ja.pak"), "ja", "utf8");
      await mkdir(join(unpackedRoot, "resources", "app", "i18n", "locales"), { recursive: true });
      await writeFile(join(unpackedRoot, "resources", "app", "i18n", "locales", "ja.ts"), "app i18n", "utf8");

      const setupZipPath = join(root, "builder", "Readable Studio-rg-portable.zip");
      const paths = fakePaths(root, setupZipPath, unpackedRoot);
      const builtApp: WinBuiltAppManifest = {
        appBuilderOutputRoot: paths.appBuilderOutputRoot,
        cacheEntryPath: null,
        configPath: join(unpackedRoot, "resources", "readable-studio-config.json"),
        executablePath: paths.unpackedExePath,
        source: "namespace",
        unpackedRoot,
        version: 1,
        webStandaloneHookAuditPath: null,
      };

      const timings = await buildWinPortableZip({ signed: false } as ToolPackConfig, paths, builtApp);

      const extractRoot = join(root, "extracted");
      await mkdir(extractRoot, { recursive: true });
      await execFileAsync(winResources.sevenZipExe, ["x", setupZipPath, `-o${extractRoot}`, "-y"]);

      const extractedConfig = JSON.parse(
        await readFile(join(extractRoot, "resources", "readable-studio-config.json"), "utf8"),
      ) as Record<string, unknown>;
      const extractedChromiumLocales = (await readdir(join(extractRoot, "locales"))).sort();
      const extractedAppI18nLocales = (await readdir(join(extractRoot, "resources", "app", "i18n", "locales"))).sort();

      return { extractedAppI18nLocales, extractedChromiumLocales, extractedConfig, originalConfig, timings };
    } finally {
      if (previousCompression == null) {
        delete process.env.READABLE_PORTABLE_ZIP_COMPRESSION;
      } else {
        process.env.READABLE_PORTABLE_ZIP_COMPRESSION = previousCompression;
      }
      await rm(root, { force: true, recursive: true });
    }
  }

  function fakePaths(root: string, setupZipPath: string, unpackedRoot: string): WinPaths {
    // Only the fields buildWinPortableZip reads matter; the rest are filled so
    // the shape stays a real WinPaths without leaking into the assertions.
    const namespaceRoot = join(root, "namespaces", "rg");
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
      setupZipPath,
      tarballsRoot: join(namespaceRoot, "tarballs"),
      webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
      webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
      webSidecarPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "web-sidecar.meta.json"),
      webSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "web", "web-sidecar.mjs"),
      winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
      unpackedExePath: join(unpackedRoot, "Readable Studio.exe"),
      unpackedRoot,
    };
  }

  it("uses the release default compression when no override is set", async () => {
    const { extractedAppI18nLocales, extractedChromiumLocales, extractedConfig, originalConfig, timings } = await buildPortableZipFixture(undefined);
    const compressedArgs = timings.find(({ phase }) => phase === "portable-zip:7z:process")?.details?.args as
      | string[]
      | undefined;

    expect(compressedArgs).toContain("-mx=5");
    expect(extractedConfig).toEqual(originalConfig);
    expect(extractedChromiumLocales).toEqual(["en-US.pak", "ko.pak"]);
    expect(extractedAppI18nLocales).toEqual(["ja.ts"]);
  }, 20_000);

  it("produces identical bytes after source timestamps change", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-tools-pack-deterministic-"));
    const unpackedRoot = join(root, "win-unpacked");
    const setupZipPath = join(root, "builder", "Readable Studio-rg-portable.zip");
    const paths = fakePaths(root, setupZipPath, unpackedRoot);
    const builtApp: WinBuiltAppManifest = {
      appBuilderOutputRoot: paths.appBuilderOutputRoot,
      cacheEntryPath: null,
      configPath: join(unpackedRoot, "resources", "readable-studio-config.json"),
      executablePath: paths.unpackedExePath,
      source: "namespace",
      unpackedRoot,
      version: 1,
      webStandaloneHookAuditPath: null,
    };
    const digest = async () => createHash("sha256").update(await readFile(setupZipPath)).digest("hex");

    try {
      await mkdir(join(unpackedRoot, "resources", "nested"), { recursive: true });
      await writeFile(paths.unpackedExePath, "exe", "utf8");
      await writeFile(builtApp.configPath, "{}\n", "utf8");
      await writeFile(join(unpackedRoot, "resources", "nested", "asset.txt"), "asset\n", "utf8");

      await buildWinPortableZip({ signed: false } as ToolPackConfig, paths, builtApp);
      const first = await digest();
      const changed = new Date("2035-06-07T08:09:10.000Z");
      await utimes(paths.unpackedExePath, changed, changed);
      await utimes(join(unpackedRoot, "resources", "nested", "asset.txt"), changed, changed);
      await buildWinPortableZip({ signed: false } as ToolPackConfig, paths, builtApp);

      expect(await digest()).toBe(first);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("uses a faster local compression level override", async () => {
    const { extractedConfig, originalConfig, timings } = await buildPortableZipFixture("1");
    const compressedArgs = timings.find(({ phase }) => phase === "portable-zip:7z:process")?.details?.args as
      | string[]
      | undefined;

    expect(compressedArgs).toContain("-mx=1");
    expect(extractedConfig).toEqual(originalConfig);
  }, 20_000);
});
