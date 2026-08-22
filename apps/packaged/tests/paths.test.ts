import { join } from "node:path";

import { createRuntimeDescriptor } from "@readable-studio/sidecar-proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PackagedConfig } from "../src/config.js";
import { PackagedPathAccessError } from "../src/errors.js";
import { resolvePackagedNamespacePaths } from "../src/paths.js";

function stubPlatform(value: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  };
}

function fakeConfig(): PackagedConfig {
  return {
    amrProfile: null,
    appVersion: null,
    arch: null,
    artifact: null,
    daemonCliEntry: null,
    daemonSidecarEntry: null,
    descriptor: createRuntimeDescriptor("0.0.0"),
    namespace: "release-stable-win",
    namespaceBaseRoot: join("C:", "Users", "Fred", "AppData", "Roaming", "Readable Studio", "namespaces"),
    nodeCommand: null,
    portable: false,
    platform: null,
    resourceRoot: join("C:", "Program Files", "Readable Studio", "resources", "readable-studio"),
    webOutputMode: "server",
    webSidecarEntry: null,
    webStandaloneRoot: null,
  };
}

describe("resolvePackagedNamespacePaths", () => {
  let restorePlatform: () => void = () => {};

  beforeEach(() => {
    restorePlatform = stubPlatform("win32");
  });

  afterEach(() => {
    restorePlatform();
  });

  it("models namespace data below the namespace root", () => {
    const config = fakeConfig();
    const paths = resolvePackagedNamespacePaths(config, config.namespace);

    expect(paths.namespaceRoot).toBe(join(config.namespaceBaseRoot, config.namespace));
    expect(paths.dataRoot).toBe(join(paths.namespaceRoot, "data"));
  });

  it("rejects namespace overrides that would escape the namespace base root", () => {
    const config: PackagedConfig = {
      amrProfile: null,
      appVersion: "1.2.3",
      arch: null,
      artifact: null,
      daemonCliEntry: null,
      daemonSidecarEntry: null,
      descriptor: createRuntimeDescriptor("1.2.3"),
      namespace: "release",
      namespaceBaseRoot: "/tmp/readable-studio-packaged/namespaces",
      nodeCommand: null,
      portable: false,
      platform: null,
      resourceRoot: "/tmp/readable-studio-packaged/resources",
      webSidecarEntry: null,
      webStandaloneRoot: null,
      webOutputMode: "server",
    };

    expect(() => resolvePackagedNamespacePaths(config, "../release")).toThrow(/namespace/);
  });

  it("defaults daemon dataRoot to the namespace-scoped packaged data directory", () => {
    const config = fakeConfig();

    expect(resolvePackagedNamespacePaths(config, config.namespace).dataRoot).toBe(
      join(config.namespaceBaseRoot, config.namespace, "data"),
    );
  });

  it("uses READABLE_DATA_DIR as a base for the namespace-scoped packaged daemon dataRoot", () => {
    const config = fakeConfig();
    const override = join("C:", "Users", "Fred", "MyProject", "design", ".readable-studio");

    expect(
      resolvePackagedNamespacePaths(config, config.namespace, { READABLE_DATA_DIR: override }).dataRoot,
    ).toBe(join(override, "namespaces", config.namespace, "data"));
  });

  it("rejects portable READABLE_DATA_DIR overrides outside the exe data container", () => {
    const config = fakeConfig();
    const exeDir = join("D:", "Portable", "Readable Studio");
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: join(exeDir, "Readable Studio.exe"),
    });
    try {
      config.portable = true;
      config.namespaceBaseRoot = join(exeDir, "ReadableStudioData", "namespaces");
      expect(
        () => resolvePackagedNamespacePaths(config, config.namespace, {
          READABLE_DATA_DIR: join("C:", "Users", "Fred", "AppData", "Roaming", "Readable Studio"),
        }),
      ).toThrow(/READABLE_DATA_DIR.*ReadableStudioData/);
    } finally {
      Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
    }
  });

  it("accepts portable READABLE_DATA_DIR overrides inside the exe data container", () => {
    const config = fakeConfig();
    const exeDir = join("D:", "Portable", "Readable Studio");
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: join(exeDir, "Readable Studio.exe"),
    });
    try {
      config.portable = true;
      config.namespaceBaseRoot = join(exeDir, "ReadableStudioData", "namespaces");
      const override = join(exeDir, "ReadableStudioData", "daemon-data");
      expect(resolvePackagedNamespacePaths(config, config.namespace, { READABLE_DATA_DIR: override }).dataRoot)
        .toBe(join(override, "namespaces", config.namespace, "data"));
    } finally {
      Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
    }
  });

  it("keeps shared READABLE_DATA_DIR overrides isolated across packaged namespaces", () => {
    const config = fakeConfig();
    const override = join("C:", "Users", "Fred", "MyProject", "design", ".readable-studio");
    const stable = resolvePackagedNamespacePaths(config, "release-stable-win", {
      READABLE_DATA_DIR: override,
    });
    const beta = resolvePackagedNamespacePaths(config, "release-beta-win", {
      READABLE_DATA_DIR: override,
    });

    expect(stable.dataRoot).toBe(join(override, "namespaces", "release-stable-win", "data"));
    expect(beta.dataRoot).toBe(join(override, "namespaces", "release-beta-win", "data"));
    expect(stable.dataRoot).not.toBe(beta.dataRoot);
  });

  it("preserves already-scoped packaged READABLE_DATA_DIR values as the final daemon dataRoot", () => {
    const config = fakeConfig();
    const override = join(
      "C:",
      "Users",
      "Fred",
      "AppData",
      "Roaming",
      "Readable Studio",
      "namespaces",
      config.namespace,
      "data",
    );

    expect(
      resolvePackagedNamespacePaths(config, config.namespace, { READABLE_DATA_DIR: override }).dataRoot,
    ).toBe(override);
  });

  it("rejects already-scoped READABLE_DATA_DIR values that point at a different packaged namespace", () => {
    const config = fakeConfig();
    const override = join(
      "C:",
      "Users",
      "Fred",
      "AppData",
      "Roaming",
      "Readable Studio",
      "namespaces",
      "release-beta-win",
      "data",
    );

    expect(
      () =>
        resolvePackagedNamespacePaths(config, config.namespace, {
          READABLE_DATA_DIR: override,
        }),
    ).toThrow(PackagedPathAccessError);
  });

  it("forwards the READABLE_DATA_DIR-resolved dataRoot into sidecar launch paths", () => {
    const config = fakeConfig();
    const override = join("C:", "Users", "Fred", "MyProject", "design", ".readable-studio");
    const paths = resolvePackagedNamespacePaths(config, config.namespace, {
      READABLE_DATA_DIR: override,
    });

    expect(paths.dataRoot).toBe(join(override, "namespaces", config.namespace, "data"));
    expect(paths.namespaceRoot).toBe(join(config.namespaceBaseRoot, config.namespace));
    expect(paths.runtimeRoot).toBe(join(config.namespaceBaseRoot, config.namespace, "runtime"));
  });

  it("does not read process.env implicitly so headless can keep namespace-root READABLE_DATA_DIR semantics", () => {
    const config = fakeConfig();
    const original = process.env.READABLE_DATA_DIR;
    try {
      process.env.READABLE_DATA_DIR = join("C:", "Users", "Fred", "MyProject", "design", ".readable-studio");
      expect(resolvePackagedNamespacePaths(config).dataRoot).toBe(
        join(config.namespaceBaseRoot, config.namespace, "data"),
      );
    } finally {
      if (original == null) delete process.env.READABLE_DATA_DIR;
      else process.env.READABLE_DATA_DIR = original;
    }
  });

  it("rejects relative READABLE_DATA_DIR values instead of resolving them against cwd", () => {
    const config = fakeConfig();

    expect(
      () => resolvePackagedNamespacePaths(config, config.namespace, { READABLE_DATA_DIR: "project/.readable-studio" }),
    ).toThrow(/READABLE_DATA_DIR.*absolute path/);
  });

  it("surfaces the relative-READABLE_DATA_DIR rejection as PackagedPathAccessError so packaged main() can show a dialog", () => {
    const config = fakeConfig();

    let captured: unknown;
    try {
      resolvePackagedNamespacePaths(config, config.namespace, { READABLE_DATA_DIR: "project/.readable-studio" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PackagedPathAccessError);
    const err = captured as PackagedPathAccessError;
    expect(err.title).toMatch(/READABLE_DATA_DIR/);
    expect(err.message).toContain("project/.readable-studio");
    expect(err.message).toMatch(/absolute path/);
  });

  it("rejects Windows-style READABLE_DATA_DIR values on non-Windows hosts so the absolute-path guard is platform-correct", () => {
    const config = fakeConfig();
    const restore = stubPlatform("linux");
    try {
      expect(
        () =>
          resolvePackagedNamespacePaths(config, config.namespace, {
            READABLE_DATA_DIR: "C:\\Users\\Fred\\Readable Studio",
          }),
      ).toThrow(PackagedPathAccessError);
      expect(
        () =>
          resolvePackagedNamespacePaths(config, config.namespace, {
            READABLE_DATA_DIR: "\\\\server\\share",
          }),
      ).toThrow(PackagedPathAccessError);
    } finally {
      restore();
    }
  });
});
