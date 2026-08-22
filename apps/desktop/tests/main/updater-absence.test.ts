import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDesktopSidecarMessage, SidecarContractError } from "@readable-studio/sidecar-proto";
import { describe, expect, it } from "vitest";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("desktop updater absence", () => {
  it("has no updater implementation or preload host capability", () => {
    // Given the desktop main-process and preload surfaces
    const updaterImplementation = join(desktopRoot, "src", "main", "updater.ts");
    const preloadSource = readFileSync(join(desktopRoot, "src", "main", "preload.cts"), "utf8");

    // When the former updater host surface is inspected
    const updaterHostSurface = {
      preloadExposesUpdater: /\bupdater\b/i.test(preloadSource),
      updaterImplementationExists: existsSync(updaterImplementation),
    };

    // Then renderer code cannot reach an updater host
    expect(updaterHostSurface).toEqual({
      preloadExposesUpdater: false,
      updaterImplementationExists: false,
    });
  });

  it("rejects the former updater sidecar action", () => {
    // Given a message using the removed updater contract
    const formerUpdaterMessage = { input: { action: "check" }, type: "update" };

    // When the desktop sidecar parser receives it
    const parseFormerUpdaterMessage = () => normalizeDesktopSidecarMessage(formerUpdaterMessage);

    // Then the contract rejects it at the boundary
    expect(parseFormerUpdaterMessage).toThrow(SidecarContractError);
  });
});
