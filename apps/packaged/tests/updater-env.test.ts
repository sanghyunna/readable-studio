import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagedRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_RUNTIME_TOKENS = [
  "releases.readable-studio.ai",
  "updateMetadataUrl",
  "setInterval(",
  // No startup source currently needs a bounded timeout exception.
  "setTimeout(",
] as const;
const APPLY_ENV_NAMES = new Set(["READABLE_UPDATE_ROOT", "READABLE_ELECTRON_MAIN_PID"]);

function boundaryViolations(sources: Record<string, string>, updaterModuleExists: boolean): string[] {
  const violations = updaterModuleExists ? ["updater-env.ts"] : [];
  for (const [file, source] of Object.entries(sources)) {
    source.split("\n").forEach((line, index) => {
      const tokens = FORBIDDEN_RUNTIME_TOKENS.filter((token) => line.includes(token));
      const envNames = line.match(/\bREADABLE_(?:UPDATE_[A-Z0-9_]+|ELECTRON_MAIN_PID)\b/g) ?? [];
      for (const token of [...tokens, ...envNames.filter((name) => !APPLY_ENV_NAMES.has(name))]) {
        violations.push(`${file}:${index + 1}: ${token}`);
      }
    });
  }
  return violations;
}

// Owner decision: portable updates apply only after the user chooses quit-and-update, never shell polling.
describe("packaged updater stays user-initiated", () => {
  it("allows only sanctioned apply env and has no retired feed, background timers, or updater-env module", () => {
    const sources = Object.fromEntries(
      ["config.ts", "headless.ts", "index.ts", "launch.ts", "sidecars.ts"]
        .map((file) => [file, readFileSync(join(packagedRoot, "src", file), "utf8")]),
    );
    expect(boundaryViolations(sources, existsSync(join(packagedRoot, "src", "updater-env.ts")))).toEqual([]);
  });

  it.each([...FORBIDDEN_RUNTIME_TOKENS, "READABLE_UPDATE_METADATA_URL", "READABLE_UPDATE_POLL_INTERVAL"])(
    "detects injected forbidden token %s in a scratch startup source",
    (token) => {
      expect(boundaryViolations({ "scratch.ts": `\n${token}` }, false)).toEqual([`scratch.ts:2: ${token}`]);
    },
  );

  it("allows exactly the sanctioned root and Electron pid env names", () => {
    expect(boundaryViolations({ "scratch.ts": "READABLE_UPDATE_ROOT READABLE_ELECTRON_MAIN_PID" }, false)).toEqual([]);
  });

  it("detects an updater environment module even without forbidden source tokens", () => {
    expect(boundaryViolations({}, true)).toEqual(["updater-env.ts"]);
  });
});
