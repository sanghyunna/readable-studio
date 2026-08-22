import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createRuntimeDescriptor } from "@readable-studio/sidecar-proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_DATA_DIR = join("C:", "Users", "Fred", "AppData", "Roaming", "Readable Studio");
const READABLE_USER_DATA_DIR = join("C:", "Users", "Fred", "AppData", "Roaming", "Readable Studio");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return USER_DATA_DIR;
      throw new Error(`unexpected getPath(${name})`);
    },
    getAppPath: () => join("C:", "Program Files", "Readable Studio", "resources", "app"),
  },
}));

import {
  PACKAGED_CONFIG_PATH_ENV,
  readPackagedConfig,
  resolveDefaultPackagedNodeCommandRelativePath,
  resolveEarlyPackagedElectronPaths,
} from "../src/config.js";

describe("resolveDefaultPackagedNodeCommandRelativePath", () => {
  it("uses the bundled node.exe path on Windows", () => {
    expect(resolveDefaultPackagedNodeCommandRelativePath("win32")).toBe("readable-studio/bin/node.exe");
  });

  it("uses the bundled node path on Linux and macOS", () => {
    expect(resolveDefaultPackagedNodeCommandRelativePath("linux")).toBe("readable-studio/bin/node");
    expect(resolveDefaultPackagedNodeCommandRelativePath("darwin")).toBe("readable-studio/bin/node");
  });
});

// Each case writes a minimal packaged config to a temp file and points
// READABLE_PACKAGED_CONFIG_PATH at it, so readPackagedConfig resolves the same raw
// config a shipped artifact would, while `app.getPath("userData")` is mocked
// and `process.execPath` is overridable to assert the exe-adjacent fallback.
describe("readPackagedConfig namespaceBaseRoot resolution", () => {
  let configDir = "";
  let restoreEnv: () => void = () => {};
  let restoreExecPath: () => void = () => {};
  let restoreResourcesPath: () => void = () => {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "readable-packaged-config-"));
    const previousEnv = process.env[PACKAGED_CONFIG_PATH_ENV];
    restoreEnv = () => {
      if (previousEnv == null) delete process.env[PACKAGED_CONFIG_PATH_ENV];
      else process.env[PACKAGED_CONFIG_PATH_ENV] = previousEnv;
    };
    // resolvePackagedWebStandaloneRoot/nodeCommand probe process.resourcesPath;
    // point it at an empty dir so neither resolves to a real bundled path.
    const previousResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", { value: configDir, configurable: true });
    restoreResourcesPath = () => {
      Object.defineProperty(process, "resourcesPath", { value: previousResourcesPath, configurable: true });
    };
  });

  afterEach(() => {
    restoreEnv();
    restoreExecPath();
    restoreResourcesPath();
    rmSync(configDir, { force: true, recursive: true });
  });

  function writeConfig(raw: Record<string, unknown>): void {
    const configPath = join(configDir, "readable-studio-config.json");
    const appVersion = typeof raw.appVersion === "string" ? raw.appVersion : "1.2.3";
    const portableTarget = raw.portable === true
      ? { arch: "x64", artifact: "portable-zip", platform: "win32" }
      : {};
    writeFileSync(
      configPath,
      `${JSON.stringify({ appVersion, descriptor: createRuntimeDescriptor(appVersion), ...portableTarget, ...raw }, null, 2)}\n`,
      "utf8",
    );
    process.env[PACKAGED_CONFIG_PATH_ENV] = configPath;
  }

  function stubExecPath(execPath: string): void {
    const previous = process.execPath;
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
    restoreExecPath = () => {
      Object.defineProperty(process, "execPath", { value: previous, configurable: true });
    };
  }

  it("rejects a missing or foreign product identity at the packaged config boundary", async () => {
    const configPath = join(configDir, "readable-studio-config.json");
    process.env[PACKAGED_CONFIG_PATH_ENV] = configPath;
    writeFileSync(configPath, `${JSON.stringify({ appVersion: "1.2.3", namespace: "rg" }, null, 2)}\n`, "utf8");

    await expect(readPackagedConfig()).rejects.toThrow(/runtime descriptor must be an object/);

    writeFileSync(
      configPath,
      `${JSON.stringify({
        appVersion: "1.2.3",
        descriptor: { ...createRuntimeDescriptor("1.2.3"), productId: "foreign-product" },
        namespace: "rg",
      }, null, 2)}\n`,
      "utf8",
    );
    await expect(readPackagedConfig()).rejects.toThrow(/productId must be "readable-studio"/);
  });

  it("rejects a descriptor whose app version differs from packaged config", async () => {
    writeConfig({ appVersion: "2.0.0", descriptor: createRuntimeDescriptor("1.2.3"), namespace: "rg" });

    await expect(readPackagedConfig()).rejects.toThrow(/appVersion does not match packaged config/);
  });

  it("rejects malformed JSON with the embedded config path in the diagnostic", async () => {
    const configPath = join(configDir, "readable-studio-config.json");
    writeFileSync(configPath, "{ definitely-not-json", "utf8");
    process.env[PACKAGED_CONFIG_PATH_ENV] = configPath;

    await expect(readPackagedConfig()).rejects.toThrow(
      new RegExp(`packaged config at .*${configPath.split(/[\\/]/).at(-1)} is not valid JSON`),
    );
  });

  it("rejects a malformed embedded namespace root with a field-specific diagnostic", async () => {
    writeConfig({ namespace: "rg", namespaceBaseRoot: { path: "D:/data" }, portable: true });

    await expect(readPackagedConfig()).rejects.toThrow(/namespaceBaseRoot must be a non-empty path string/);
  });

  it("rejects incomplete portable target metadata", async () => {
    writeConfig({ arch: "arm64", namespace: "rg", portable: true });

    await expect(readPackagedConfig()).rejects.toThrow(/portable config arch must be "x64"/);
  });

  it("fails closed synchronously when portable metadata is not a JSON boolean", () => {
    writeConfig({ namespace: "rg", portable: "true" });

    expect(() => resolveEarlyPackagedElectronPaths()).toThrow(/portable must be a boolean/);
  });

  it("fails closed synchronously when portable target metadata is malformed", () => {
    writeConfig({ arch: "arm64", namespace: "rg", portable: true });

    expect(() => resolveEarlyPackagedElectronPaths()).toThrow(/portable config arch must be "x64"/);
  });

  it("fails closed synchronously when portable namespaceBaseRoot escapes the exe data container", () => {
    const exeDir = join("D:", "Portable", "Readable Studio");
    stubExecPath(join(exeDir, "Readable Studio.exe"));
    writeConfig({
      namespace: "rg",
      namespaceBaseRoot: join("C:", "Users", "Fred", "AppData", "Roaming", "Readable Studio", "namespaces"),
      portable: true,
    });

    expect(() => resolveEarlyPackagedElectronPaths()).toThrow(/namespaceBaseRoot.*ReadableStudioData/);
  });

  it("resolves Chromium paths synchronously before Electron can spawn children", () => {
    const exeDir = join("D:", "Portable", "Readable Studio");
    stubExecPath(join(exeDir, "Readable Studio.exe"));
    writeConfig({ namespace: "rg", portable: true });

    expect(resolveEarlyPackagedElectronPaths()).toEqual({
      cacheRoot: join(exeDir, "ReadableStudioData", "namespaces", "rg", "cache"),
      desktopLogsRoot: join(exeDir, "ReadableStudioData", "namespaces", "rg", "logs", "desktop"),
      electronSessionDataRoot: join(exeDir, "ReadableStudioData", "namespaces", "rg", "user-data", "session"),
      electronUserDataRoot: join(exeDir, "ReadableStudioData", "namespaces", "rg", "user-data"),
    });
  });

  it("falls back to an exe-adjacent ReadableStudioData root when portable and no explicit root", async () => {
    const exeDir = join("D:", "Portable", "Readable Studio");
    stubExecPath(join(exeDir, "Readable Studio.exe"));
    writeConfig({ namespace: "rg", portable: true });

    const config = await readPackagedConfig();

    expect(config.portable).toBe(true);
    expect(config.arch).toBe("x64");
    expect(config.artifact).toBe("portable-zip");
    expect(config.platform).toBe("win32");
    expect(config.namespaceBaseRoot).toBe(join(exeDir, "ReadableStudioData", "namespaces"));
    // The portable root must never touch the mocked userData directory.
    expect(config.namespaceBaseRoot.startsWith(USER_DATA_DIR)).toBe(false);
  });

  it("derives the portable root from dirname(process.execPath)", async () => {
    const exeDir = join("E:", "tools", "readable-extract");
    stubExecPath(join(exeDir, "Readable Studio.exe"));
    writeConfig({ namespace: "rg", portable: true });

    const config = await readPackagedConfig();

    expect(dirname(dirname(config.namespaceBaseRoot))).toBe(exeDir);
  });

  it("falls back to the Readable Studio userData root when not portable", async () => {
    stubExecPath(join("D:", "Portable", "Readable Studio", "Readable Studio.exe"));
    writeConfig({ namespace: "rg" });

    const config = await readPackagedConfig();

    expect(config.portable).toBe(false);
    expect(config.namespaceBaseRoot).toBe(join(READABLE_USER_DATA_DIR, "namespaces"));
  });

  it("treats portable: false the same as a non-portable build", async () => {
    stubExecPath(join("D:", "Portable", "Readable Studio", "Readable Studio.exe"));
    writeConfig({ namespace: "rg", portable: false });

    const config = await readPackagedConfig();

    expect(config.portable).toBe(false);
    expect(config.namespaceBaseRoot).toBe(join(READABLE_USER_DATA_DIR, "namespaces"));
  });

  it("accepts an explicit portable namespaceBaseRoot only inside the exe data container", async () => {
    const exeDir = join("D:", "Portable", "Readable Studio");
    const explicitRoot = join(exeDir, "ReadableStudioData", "custom", "namespaces");
    stubExecPath(join(exeDir, "Readable Studio.exe"));
    writeConfig({ namespace: "rg", namespaceBaseRoot: explicitRoot, portable: true });

    const config = await readPackagedConfig();

    expect(config.portable).toBe(true);
    expect(config.namespaceBaseRoot).toBe(explicitRoot);
  });

  it("rejects an explicit portable namespaceBaseRoot outside the exe data container", async () => {
    const explicitRoot = join("F:", "readable-data", "namespaces");
    stubExecPath(join("D:", "Portable", "Readable Studio", "Readable Studio.exe"));
    writeConfig({ namespace: "rg", namespaceBaseRoot: explicitRoot, portable: true });

    await expect(readPackagedConfig()).rejects.toThrow(/namespaceBaseRoot.*ReadableStudioData/);
  });

  it("lets an explicit namespaceBaseRoot win for non-portable builds (unchanged behavior)", async () => {
    const explicitRoot = join("F:", "readable-data", "namespaces");
    stubExecPath(join("D:", "Portable", "Readable Studio", "Readable Studio.exe"));
    writeConfig({ namespace: "rg", namespaceBaseRoot: explicitRoot });

    const config = await readPackagedConfig();

    expect(config.portable).toBe(false);
    expect(config.namespaceBaseRoot).toBe(explicitRoot);
  });

  it("resolves the default bundled node command when it exists under resources", async () => {
    const relativeNode = resolveDefaultPackagedNodeCommandRelativePath(process.platform);
    const nodePath = join(configDir, relativeNode);
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, "fake node\n", "utf8");
    writeConfig({ namespace: "rg" });

    const config = await readPackagedConfig();

    expect(config.nodeCommand).toBe(nodePath);
  });
});
