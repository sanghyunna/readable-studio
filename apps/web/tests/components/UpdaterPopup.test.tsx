import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("updater UI absence", () => {
  it("has no updater component or entry-shell control", () => {
    // Given the shipped web component surface
    const updaterComponent = join(webRoot, "src", "components", "UpdaterPopup.tsx");
    const entryShell = readFileSync(join(webRoot, "src", "components", "EntryShell.tsx"), "utf8");

    // When the former updater entry points are inspected
    const updaterSurface = {
      componentExists: existsSync(updaterComponent),
      entryShellImportsUpdater: entryShell.includes("UpdaterPopup"),
    };

    // Then no update control can be rendered
    expect(updaterSurface).toEqual({
      componentExists: false,
      entryShellImportsUpdater: false,
    });
  });
});
