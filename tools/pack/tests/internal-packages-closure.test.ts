import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTERNAL_PACKAGES } from "../src/win/constants.js";
import { shouldInstallInternalPackageForWinPrebundle } from "../src/win-prebundle.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type PackageEntry = { readonly directory: string; readonly name: string };

function runtimeWorkspaceDeps(directory: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(workspaceRoot, directory, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {}).filter((dependency) => dependency.startsWith("@readable-studio/"));
}

describe("Windows INTERNAL_PACKAGES dependency closure", () => {
  it("installs every runtime workspace dependency locally", () => {
    // Given the packages installed into the standalone Windows artifact
    const installed = INTERNAL_PACKAGES.filter((entry) =>
      shouldInstallInternalPackageForWinPrebundle({ packageName: entry.name, webOutputMode: "standalone" })
    );
    const installedNames = new Set<string>(installed.map((entry) => entry.name));

    // When their runtime workspace dependency closure is inspected
    const missing: { readonly dependency: string; readonly dependent: string }[] = [];
    for (const entry of installed) {
      for (const dependency of runtimeWorkspaceDeps(entry.directory)) {
        if (!installedNames.has(dependency)) missing.push({ dependency, dependent: entry.name });
      }
    }

    // Then no workspace package would be fetched from the public registry
    expect(missing).toEqual([]);
  });
});
