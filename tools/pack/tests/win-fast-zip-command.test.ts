import type { ExecFileOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";
import { winResources } from "../src/resources.js";
import { resolveWinPaths } from "../src/win/paths.js";
import type { WinBuiltAppManifest } from "../src/win/types.js";
import { buildWinPortableZip } from "../src/win/zip.js";

// Intercept only the archiver process. No portable/Electron build is launched.
// Real preparation, sorted inventory, exclusions, and command assembly execute.
const invoke = vi.hoisted(() => vi.fn<(
  command: string, args: readonly string[], options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>>());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: invoke }) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  availableParallelism: () => 20,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  invoke.mockReset();
});

describe.skipIf(process.platform !== "win32")("portable ZIP command boundary", () => {
  it.each([
    { fastBuild: false, profile: false, override: undefined, compressionArgs: ["-mx=5"] },
    { fastBuild: false, profile: true, override: undefined, compressionArgs: ["-mx=5", "-bt"] },
    { fastBuild: true, profile: false, override: undefined, compressionArgs: ["-mx=5", "-mmt=20", "-bt"] },
    { fastBuild: true, profile: false, override: "1", compressionArgs: ["-mx=1", "-mmt=20", "-bt"] },
  ])("retains inventory with settings %j", async ({ fastBuild, profile, override, compressionArgs }) => {
    // Given the same unpacked files, including a hidden file and pruned locale
    vi.stubEnv("READABLE_PORTABLE_ZIP_COMPRESSION", override);
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", profile ? "1" : undefined);
    const root = await mkdtemp(join(tmpdir(), "readable-fast-zip-command-"));
    const config = resolveToolPackConfig("win", { dir: root, namespace: "perf", fastBuild });
    const paths = resolveWinPaths(config);
    const manifest: WinBuiltAppManifest = {
      appBuilderOutputRoot: paths.appBuilderOutputRoot,
      cacheEntryPath: null,
      configPath: join(paths.unpackedRoot, "resources", "readable-studio-config.json"),
      executablePath: paths.unpackedExePath,
      source: "namespace",
      unpackedRoot: paths.unpackedRoot,
      version: 1,
      webStandaloneHookAuditPath: null,
    };
    const files = ["Readable Studio.exe", ".hidden", "resources/readable-studio-config.json", "locales/en-US.pak", "locales/ko.pak", "locales/ja.pak"];
    let inventory = "";
    try {
      for (const file of files) {
        await mkdir(dirname(join(paths.unpackedRoot, file)), { recursive: true });
        await writeFile(join(paths.unpackedRoot, file), file);
      }
      invoke.mockImplementation(async () => {
        inventory = await readFile(`${paths.setupZipPath}.files.txt`, "utf8");
        await writeFile(paths.setupZipPath, "intercepted archiver output");
        return { stdout: "", stderr: "" };
      });
      // When the real ZIP stage assembles its subprocess request
      await buildWinPortableZip(config, paths, manifest);
      // Then only compression/thread settings differ; paths and metadata stay identical
      expect(invoke).toHaveBeenCalledExactlyOnceWith(winResources.sevenZipExe, [
        "a", "-tzip", ...compressionArgs, "-mtc=off", "-mta=off", "-mtm=off", "-scsUTF-8",
        paths.setupZipPath, `@${paths.setupZipPath}.files.txt`,
      ], { cwd: paths.unpackedRoot, windowsHide: true });
      expect(inventory.split("\n").filter(Boolean)).toEqual([
        ".hidden", "Readable Studio.exe", "locales/en-US.pak", "locales/ko.pak", "resources/readable-studio-config.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
