import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(toolRoot, "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(toolRoot, relativePath), "utf8");
}

describe("tools-pack launcher layout", () => {
  it("keeps portable startup and stop without an update-generation layout", () => {
    const manifest = JSON.parse(source("package.json")) as { dependencies?: Record<string, string> };
    const lifecycleSource = source("src/win/lifecycle.ts");
    const reportSource = source("src/win/report.ts");

    expect(existsSync(join(workspaceRoot, "packages", "launcher-proto", "package.json"))).toBe(false);
    expect(existsSync(join(toolRoot, "src", "launcher-layout.ts"))).toBe(false);
    expect(existsSync(join(toolRoot, "src", "launcher-runtime-snapshot.ts"))).toBe(false);
    expect(manifest.dependencies).not.toHaveProperty("@readable-studio/launcher-proto");
    expect(lifecycleSource).not.toContain("LauncherRuntime");
    expect(lifecycleSource).not.toContain("removedLauncherNamespaceRoot");
    expect(reportSource).not.toContain("shouldBuildWinLauncherPayload");
  });

  it("does not expose payload, release-pointer, rollback, or update commands", () => {
    const commandSource = source("src/index.ts");
    for (const action of ["payload", "release", "rollback", "update"]) {
      expect(commandSource).not.toMatch(new RegExp(`case ["']${action}["']`));
    }
  });
});
