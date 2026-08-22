import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REMOVED_PLATFORM_PATHS = [
  "e2e/lib/linux-helpers.ts",
  "e2e/specs/linux.spec.ts",
  "e2e/specs/mac.spec.ts",
  "e2e/tests/linux-helpers.test.ts",
  "scripts/install-unsafe-dmg.sh",
  "tools/pack/resources/linux",
  "tools/pack/resources/mac",
  "tools/pack/src/linux.ts",
  "tools/pack/src/mac",
  "tools/pack/src/mac-prebundle.ts",
  "tools/pack/tests/linux.test.ts",
  "tools/pack/tests/mac-identity.test.ts",
  "tools/pack/tests/mac-lifecycle.test.ts",
  "tools/pack/tests/mac-prebundle.test.ts",
  "tools/pack/tests/mac.test.ts",
] as const;

function readToolsPackPackage(): { readonly dependencies?: Readonly<Record<string, string>> } {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, "tools", "pack", "package.json"), "utf8"));
}

describe("supported packaged platforms", () => {
  it("has no macOS or Linux packaging implementation artifacts", () => {
    // Given the repository root and the unsupported-platform artifact inventory
    const paths = REMOVED_PLATFORM_PATHS.map((path) => join(REPOSITORY_ROOT, path));

    // When the tracked packaging surface is inspected
    const existingPaths = paths.filter((path) => existsSync(path));

    // Then every unsupported-platform artifact is absent
    expect(existingPaths).toEqual([]);
  });

  it("has no dependencies used exclusively by macOS packaging", () => {
    // Given the tools-pack runtime dependency set
    const dependencies = readToolsPackPackage().dependencies ?? {};

    // When dependencies exclusive to the removed macOS lane are selected
    const exclusiveDependencies = ["@electron/notarize", "@electron/rebuild"].filter(
      (dependency) => dependency in dependencies,
    );

    // Then none remain in the package manifest
    expect(exclusiveDependencies).toEqual([]);
  });

  it.each([
    ["mac", "dmg"],
    ["linux", "appimage"],
  ] as const)("rejects the unsupported %s packaging command", (platform, target) => {
    // Given the TypeScript tools-pack entrypoint
    const entrypoint = join(REPOSITORY_ROOT, "tools", "pack", "src", "index.ts");

    // When an unsupported platform build is requested
    const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint, platform, "build", "--to", target], {
      encoding: "utf8",
    });

    // Then the CLI fails explicitly rather than silently succeeding
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unsupported tools-pack command: ${platform} build --to ${target}`);
  });

  it.each([
    [["updater"], "unsupported tools-pack command: updater"],
    [["win", "updater"], "unsupported tools-pack command: win updater"],
    [["win", "update"], "unsupported tools-pack command: win update"],
    [["win", "install"], "unsupported tools-pack command: win install"],
    [["win", "uninstall"], "unsupported tools-pack command: win uninstall"],
    [["win", "reset"], "unsupported tools-pack command: win reset"],
    [["win", "list"], "unsupported tools-pack command: win list"],
  ] as const)("rejects removed command %j", (args, diagnostic) => {
    // Given the TypeScript tools-pack entrypoint
    const entrypoint = join(REPOSITORY_ROOT, "tools", "pack", "src", "index.ts");

    // When a removed updater action is requested
    const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...args], {
      encoding: "utf8",
    });

    // Then the CLI rejects it nonzero with an explicit boundary diagnostic
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it.each(["all", "app", "dir", "dmg", "nsis", "appimage"])(
    "rejects removed build target %s",
    (target) => {
      const entrypoint = join(REPOSITORY_ROOT, "tools", "pack", "src", "index.ts");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entrypoint, "win", "build", "--to", target],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option `--to`");
    },
  );

  it("rejects the removed portable compatibility flag", () => {
    const entrypoint = join(REPOSITORY_ROOT, "tools", "pack", "src", "index.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entrypoint, "win", "build", "--portable"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option `--portable`");
  });
});
