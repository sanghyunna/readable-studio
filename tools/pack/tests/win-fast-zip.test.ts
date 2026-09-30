import { availableParallelism } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashJson } from "../src/cache.js";
import { resolveToolPackConfig } from "../src/config.js";
import { buildWinPortableZipCacheKeyInput } from "../src/win/builder.js";
import { resolvePortableZipCompression, resolvePortableZipThreads } from "../src/win/zip.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  availableParallelism: vi.fn(() => 64),
}));

const legacyKeyInput = {
  electronBuilderDirKey: "dir",
  packagedConfig: "{}",
  namespace: "perf",
  packagedAppKey: "app",
  packagedVersion: "1.2.1",
  portableZipCompression: 5,
  signing: null,
};

afterEach(() => vi.unstubAllEnvs());

describe("opt-in portable compression", () => {
  it("preserves the existing config when fast build is absent or false", () => {
    // Given the normal CLI options
    const options = { namespace: "perf" };
    // When the disabled option is explicitly passed
    const disabled = resolveToolPackConfig("win", { ...options, fastBuild: false });
    // Then the default config shape is unchanged
    expect(disabled).toEqual(resolveToolPackConfig("win", options));
    expect(disabled).not.toHaveProperty("fastBuild");
  });

  it("enables the fast path only when explicitly requested", () => {
    // Given an explicit CLI flag
    const options = { namespace: "perf", fastBuild: true };
    // When configuration is resolved
    const config = resolveToolPackConfig("win", options);
    // Then downstream build stages see the opt-in
    expect(config.fastBuild).toBe(true);
  });

  it.each([undefined, "", "   "])("retains release compression with override %j", (override) => {
    // Given no compression override in the environment
    vi.stubEnv("READABLE_PORTABLE_ZIP_COMPRESSION", undefined);
    // When no explicit compression choice is supplied
    const compression = resolvePortableZipCompression(override);
    // Then release downloads retain the established size/speed trade-off
    expect(compression).toBe(5);
  });

  it.each(["0", "1", "5", "9"])("preserves explicit compression %s on the fast path", (override) => {
    // Given an explicit user compression choice
    // When the fast path resolves it
    const compression = resolvePortableZipCompression(override);
    // Then the user choice wins over the fast default
    expect(compression).toBe(Number(override));
  });

  it.each([2, 20, 64])("bounds ZIP threads for %i available processors", (processors) => {
    // Given the host's available processor count
    vi.mocked(availableParallelism).mockReturnValue(processors);
    // When the fast path selects compressor parallelism
    const threads = resolvePortableZipThreads(true);
    // Then it uses available cores without exceeding the 20-thread budget
    expect(threads).toBe(processors === 2 ? 2 : 20);
  });

  it("leaves the archiver's thread setting untouched when the flag is off", () => {
    // Given the default build path
    // When thread settings are selected
    const threads = resolvePortableZipThreads();
    // Then no new thread option participates in commands or cache keys
    expect(threads).toBeUndefined();
  });

  it("preserves the existing ZIP cache key when threads are omitted", () => {
    // Given the key captured from the pre-change implementation
    const baseline = "e5a0b1a239cb7807c9373360437334385d3052b1c9ebf56538b0203fcc280352";
    // When the default path builds its key
    const key = hashJson(buildWinPortableZipCacheKeyInput(legacyKeyInput));
    // Then existing caches remain valid, byte-for-byte
    expect(key).toBe(baseline);
  });

  it("isolates explicitly threaded ZIPs even with the same compression", () => {
    // Given identical archive inputs but an explicit thread count
    const threaded = { ...legacyKeyInput, portableZipThreads: Math.min(20, availableParallelism()) };
    // When cache keys are generated
    const key = hashJson(buildWinPortableZipCacheKeyInput(threaded));
    // Then the fast path cannot populate the default ZIP cache
    expect(key).not.toBe(hashJson(buildWinPortableZipCacheKeyInput(legacyKeyInput)));
  });
});
