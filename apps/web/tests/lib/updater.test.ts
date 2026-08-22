import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("updater web library absence", () => {
  it("has no updater library or host capability consumer", () => {
    // Given the shipped web library and host-boundary sources
    const updaterLibrary = join(webRoot, "src", "lib", "updater.ts");
    const entryShell = readFileSync(join(webRoot, "src", "components", "EntryShell.tsx"), "utf8");

    // When former updater library consumers are inspected
    const updaterLibrarySurface = {
      entryShellUsesUpdater: /\bupdater\b/i.test(entryShell),
      libraryExists: existsSync(updaterLibrary),
    };

    // Then the web runtime has no updater library path
    expect(updaterLibrarySurface).toEqual({
      entryShellUsesUpdater: false,
      libraryExists: false,
    });
  });
});
