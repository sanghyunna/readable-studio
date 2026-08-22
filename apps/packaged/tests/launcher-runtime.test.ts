import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagedRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(join(packagedRoot, relativePath), "utf8");
}

describe("packaged launcher runtime absence", () => {
  it("starts only the packaged sidecar stack without update generations or rollback pointers", () => {
    const startupSource = [source("src/index.ts"), source("src/headless.ts")].join("\n");
    const manifest = JSON.parse(source("package.json")) as { dependencies?: Record<string, string> };

    expect(existsSync(join(packagedRoot, "src", "launcher-runtime.ts"))).toBe(false);
    expect(manifest.dependencies).not.toHaveProperty("@readable-studio/launcher-proto");
    for (const removedToken of [
      "confirmPackagedLauncherRuntime",
      "lastSuccessful",
      "parseLauncherAfterQuitArgs",
      "resolvePackagedLauncherRuntime",
      "waitForLauncherAfterQuit",
    ]) {
      expect(startupSource).not.toContain(removedToken);
    }
  });

  it("does not ship an after-quit update entry path", () => {
    expect(existsSync(join(packagedRoot, "src", "launcher-after-quit.ts"))).toBe(false);
    expect(source("src/index.ts")).not.toContain("--readable-launcher-after-quit");
  });
});
