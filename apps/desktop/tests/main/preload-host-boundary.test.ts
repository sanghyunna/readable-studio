import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("desktop preload host boundary", () => {
  it("exposes the canonical Readable Studio host global and diagnostics bridge", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/main/preload.cts"), "utf8");
    const exposedGlobals = Array.from(source.matchAll(/contextBridge\.exposeInMainWorld\(([^,\n]+)/g))
      .map((match) => match[1]?.trim());
    const runtimeRequires = Array.from(source.matchAll(/require\((['"][^'"]+['"])\)/g))
      .map((match) => match[1]);

    expect(exposedGlobals).toEqual(["READABLE_STUDIO_HOST_GLOBAL", "'readableStudioDesktop'"]);
    expect(runtimeRequires).toEqual(["'electron'"]);
    expect(source).toContain("READABLE_STUDIO_HOST_GLOBAL");
    expect(source).toContain("exportDiagnostics");
    expect(source).toContain("satisfies ReadableStudioHostBridge");
    expect(source).toContain("browser");
    expect(source).toContain("browser:clear-data");
    expect(source).not.toContain("updater");
    // OS locale forwarded from main via webPreferences.additionalArguments
    // is mirrored onto __readableStudio__.client.osLocale. Pin the literal prefix
    // here so it can't drift away from `applyOsLocaleSwitch`/runtime's
    // additionalArguments without the test going red.
    expect(source).toContain("'--readable-studio-os-locale='");
    expect(source).toContain("osLocale");
    expect(source).not.toContain("readable-studio:update:");
    expect(source).toContain("readable-studio:app-config-changed");
    expect(source).toContain("readable-studio:app-config-changed");
    expect(source).toContain("window.dispatchEvent(new CustomEvent(APP_CONFIG_CHANGED_EVENT))");
    expect(source).not.toContain("@readable-studio/contracts");
    expect(source).not.toContain("READABLE_DESKTOP_APPROVAL_TOKEN");
    expect(source).not.toContain("decisionToken");
    expect(source).not.toContain("rollback-approvals");
    expect(source).not.toContain("exposeInMainWorld('electronAPI'");
    expect(source).not.toContain('exposeInMainWorld("__odDesktop"');
    expect(source).not.toContain("exposeInMainWorld('__odDesktop'");
  });

  it("mirrors the host import contract by accepting a null entryFile", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/main/preload.cts"), "utf8");

    expect(source).toContain("response.entryFile === null");
    expect(source).toContain("entryFile === undefined");
  });
});
