import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { normalizeDesktopSidecarMessage, SidecarContractError } from "@readable-studio/sidecar-proto";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../..");

function source(relativePath: string): string {
  return readFileSync(join(desktopRoot, relativePath), "utf8");
}

describe("desktop updater removal boundary", () => {
  it("does not register updater IPC or a release-check scheduler", () => {
    const runtime = source("src/main/runtime.ts");
    const main = source("src/main/index.ts");

    expect(runtime).not.toContain("readable-studio:update:");
    expect(runtime).not.toContain("UPDATER_STATUS_EVENT");
    expect(main).not.toContain("createDesktopUpdater");
    expect(main).not.toContain("createDesktopUpdaterScheduler");
  });

  it("rejects the removed updater sidecar action", () => {
    expect(() => normalizeDesktopSidecarMessage({
      input: { action: "check" },
      type: "update",
    })).toThrow(SidecarContractError);
  });

  it("does not retain updater environment, feed, timer, or network code", () => {
    const main = source("src/main/index.ts");
    const runtime = source("src/main/runtime.ts");

    for (const removedToken of [
      "READABLE_UPDATE_",
      "releases.readable-studio.ai",
      "checkForUpdates",
      "updateScheduler",
      "updateMetadataUrl",
    ]) {
      expect(main).not.toContain(removedToken);
      expect(runtime).not.toContain(removedToken);
    }
  });
});
