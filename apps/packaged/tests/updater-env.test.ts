import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagedRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOVED_RUNTIME_TOKENS = [
  "READABLE_UPDATE_",
  "releases.readable-studio.ai",
  "updateMetadataUrl",
  "setInterval(",
  "setTimeout(",
] as const;

describe("packaged updater absence", () => {
  it("has no updater environment module, timer, or release-feed client", () => {
    // Given every packaged startup source that can schedule side effects
    const updaterEnvironmentModule = join(packagedRoot, "src", "updater-env.ts");
    const startupSource = ["config.ts", "headless.ts", "index.ts", "launch.ts", "sidecars.ts"]
      .map((fileName) => readFileSync(join(packagedRoot, "src", fileName), "utf8"))
      .join("\n");

    // When updater-owned environment, timer, and network tokens are selected
    const retainedTokens = REMOVED_RUNTIME_TOKENS.filter((token) => startupSource.includes(token));

    // Then the packaged runtime cannot activate an updater
    expect({
      retainedTokens,
      updaterEnvironmentModuleExists: existsSync(updaterEnvironmentModule),
    }).toEqual({
      retainedTokens: [],
      updaterEnvironmentModuleExists: false,
    });
  });
});
