import { afterEach, describe, expect, it } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";

const savedAmrProfile = process.env.READABLE_AMR_PROFILE;
const savedUpdateMetadataUrl = process.env.READABLE_UPDATE_METADATA_URL;

afterEach(() => {
  if (savedAmrProfile == null) {
    delete process.env.READABLE_AMR_PROFILE;
  } else {
    process.env.READABLE_AMR_PROFILE = savedAmrProfile;
  }
  if (savedUpdateMetadataUrl == null) {
    delete process.env.READABLE_UPDATE_METADATA_URL;
  } else {
    process.env.READABLE_UPDATE_METADATA_URL = savedUpdateMetadataUrl;
  }
});

describe("resolveToolPackConfig updater absence", () => {
  it("does not expose release-feed configuration from a former updater environment key", () => {
    // Given a legacy update metadata environment value
    process.env.READABLE_UPDATE_METADATA_URL = "https://example.invalid/latest.json";

    // When portable packager configuration is resolved
    const config = resolveToolPackConfig("win", { namespace: "no-updater-config" });

    // Then the environment key cannot create feed configuration
    expect(config).not.toHaveProperty("updateMetadataUrl");
  });
});

describe("resolveToolPackConfig AMR profile", () => {
  it("bakes READABLE_AMR_PROFILE into packaged config when set at build time", () => {
    process.env.READABLE_AMR_PROFILE = "test";
    const config = resolveToolPackConfig("win", { namespace: "amr-profile-test" });
    expect(config.amrProfile).toBe("test");
  });

  it("rejects unsupported AMR profiles before packaging", () => {
    process.env.READABLE_AMR_PROFILE = "staging";
    expect(() => resolveToolPackConfig("win")).toThrow(
      /READABLE_AMR_PROFILE must be prod, test, or local/,
    );
  });
});

describe("resolveToolPackConfig portable-only surface", () => {
  it("has no target, compatibility-mode, or dead Vela configuration", () => {
    const config = resolveToolPackConfig("win", { namespace: "portable-only" });
    expect(config).not.toHaveProperty("to");
    expect(config).not.toHaveProperty("portable");
    expect(config).not.toHaveProperty("requireVelaCli");
  });
});

describe("resolveToolPackConfig namespace defaults", () => {
  it("keeps ordinary local builds on the default namespace", () => {
    expect(resolveToolPackConfig("win").namespace).toBe("default");
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0" }).namespace).toBe("default");
  });

  it("defaults prerelease builds to Windows release channel namespaces", () => {
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0-beta.4" }).namespace).toBe("release-beta-win");
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0-preview.4" }).namespace).toBe("release-preview-win");
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0.nightly.4" }).namespace).toBe("release-nightly-win");
  });

  it("keeps an explicit namespace ahead of the prerelease channel default", () => {
    expect(resolveToolPackConfig("win", { appVersion: "0.8.0-beta.4", namespace: "custom-beta" }).namespace).toBe(
      "custom-beta",
    );
  });
});
