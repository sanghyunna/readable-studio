import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  READABLE_STUDIO_HOST_GLOBAL,
  READABLE_STUDIO_HOST_VERSION,
  clearHostBrowserData,
  detectReadableStudioHostClientType,
  getReadableStudioHost,
  isReadableStudioHostAvailable,
  isReadableStudioHostBridge,
  normalizeReadableStudioHostProjectImportResult,
  openHostExternalUrl,
  pickAndImportHostProject,
  printHostPdf,
  openHostProjectPath,
  setHostPetVisible,
} from "../src/index.js";
import { createMockReadableStudioHost, installMockReadableStudioHost } from "../src/testing.js";

const hostRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return filesUnder(path);
    return /\.(ts|tsx|cts|mts)$/.test(path) ? [path] : [];
  });
}

describe("Readable Studio host contract", () => {
  it("stays independent from daemon/web contracts", () => {
    const pkg = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    }).not.toHaveProperty("@readable-studio/contracts");

    const offenders = filesUnder(join(hostRoot, "src")).filter((path) =>
      readFileSync(path, "utf8").includes("@readable-studio/contracts"),
    );
    expect(offenders).toEqual([]);
  });

  it("recognizes the canonical bridge shape", () => {
    const host = createMockReadableStudioHost();
    expect(isReadableStudioHostBridge(host)).toBe(true);
    expect(READABLE_STUDIO_HOST_VERSION).toBe(3);
    expect(host.version).toBe(READABLE_STUDIO_HOST_VERSION);
  });

  it("rejects legacy or incomplete bridge shapes", () => {
    expect(isReadableStudioHostBridge({ version: READABLE_STUDIO_HOST_VERSION })).toBe(false);
    expect(isReadableStudioHostBridge({ ...createMockReadableStudioHost(), version: 1 })).toBe(false);
    expect(isReadableStudioHostBridge({
      ...createMockReadableStudioHost(),
      browser: {},
    })).toBe(false);
    expect(isReadableStudioHostBridge({
      ...createMockReadableStudioHost(),
      capture: {},
    })).toBe(false);
    expect(isReadableStudioHostBridge({
      ...createMockReadableStudioHost(),
      shell: { openExternal: async () => ({ ok: true }) },
    })).toBe(false);
    expect(isReadableStudioHostBridge({
      ...createMockReadableStudioHost(),
      project: {},
    })).toBe(false);
  });

  it("reads the bridge through the package-owned global accessor", () => {
    const scope: Record<string, unknown> = {};
    scope[READABLE_STUDIO_HOST_GLOBAL] = createMockReadableStudioHost();
    expect(getReadableStudioHost(scope)?.client.type).toBe("desktop");
    expect(isReadableStudioHostAvailable(scope)).toBe(true);
    expect(detectReadableStudioHostClientType(scope)).toBe("desktop");
  });

  it("rejects old and mixed global bridge shapes", () => {
    const retiredGlobal = ["__", "od", "__"].join("");
    const oldOnly = { [retiredGlobal]: createMockReadableStudioHost() };
    expect(getReadableStudioHost(oldOnly)).toBeNull();

    const mixed = {
      [retiredGlobal]: createMockReadableStudioHost(),
      [READABLE_STUDIO_HOST_GLOBAL]: { ...createMockReadableStudioHost(), version: 2 },
    };
    expect(getReadableStudioHost(mixed)).toBeNull();
  });

  it("falls back to web when no host is installed", () => {
    expect(getReadableStudioHost({})).toBeNull();
    expect(isReadableStudioHostAvailable({})).toBe(false);
    expect(detectReadableStudioHostClientType({})).toBe("web");
  });

  it("wraps host action throws into structured failures", async () => {
    const scope: Record<string, unknown> = {};
    scope[READABLE_STUDIO_HOST_GLOBAL] = createMockReadableStudioHost({
      shell: {
        openPath: vi.fn(async () => {
          throw new Error("failed");
        }),
      },
    });

    await expect(openHostProjectPath("project-1", scope)).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("normalizes privileged project-import results into host-owned identifiers", () => {
    const result = normalizeReadableStudioHostProjectImportResult({
      ok: true,
      response: {
        project: {
          id: "project-1",
          name: "Imported project",
          resolvedDir: "/private/path/that-must-not-cross",
        },
        conversationId: "conversation-1",
        entryFile: "index.html",
      },
    });

    expect(result).toEqual({
      ok: true,
      projectId: "project-1",
      conversationId: "conversation-1",
      entryFile: "index.html",
    });
    expect(JSON.stringify(result)).not.toContain("resolvedDir");
  });

  it("accepts imported folders with no detected entry file", () => {
    const result = normalizeReadableStudioHostProjectImportResult({
      ok: true,
      response: {
        project: {
          id: "project-1",
          name: "Imported source repo",
          resolvedDir: "/private/path/that-must-not-cross",
        },
        conversationId: "conversation-1",
        entryFile: null,
      },
    });

    expect(result).toEqual({
      ok: true,
      projectId: "project-1",
      conversationId: "conversation-1",
      entryFile: null,
    });
    expect(JSON.stringify(result)).not.toContain("resolvedDir");
  });

  it("preserves canceled and structured failure project-import results", () => {
    expect(normalizeReadableStudioHostProjectImportResult({ canceled: true, ok: false })).toEqual({
      canceled: true,
      ok: false,
    });
    expect(normalizeReadableStudioHostProjectImportResult({
      ok: false,
      reason: "daemon returned HTTP 500",
      details: { code: "boom" },
    })).toEqual({
      ok: false,
      reason: "daemon returned HTTP 500",
      details: { code: "boom" },
    });
  });

  it("rejects malformed successful project-import results before they reach web callers", () => {
    expect(normalizeReadableStudioHostProjectImportResult({
      ok: true,
      response: {
        project: { id: "project-1" },
        conversationId: "conversation-1",
      },
    })).toEqual({
      ok: false,
      reason: "daemon import response did not include host project identifiers",
      details: {
        project: { id: "project-1" },
        conversationId: "conversation-1",
      },
    });
  });

  it("routes all host actions through package-owned helpers", async () => {
    const openExternal = vi.fn(async () => ({ ok: true as const }));
    const openPath = vi.fn(async () => ({ ok: true as const }));
    const clearData = vi.fn(async () => ({ ok: true as const }));
    const pickAndImport = vi.fn(async () => ({
      ok: true as const,
      projectId: "project-2",
      conversationId: "conversation-2",
      entryFile: "app.html",
    }));
    const print = vi.fn(async () => ({ ok: true as const }));
    const setVisible = vi.fn();
    const scope: Record<string, unknown> = {};
    scope[READABLE_STUDIO_HOST_GLOBAL] = createMockReadableStudioHost({
      browser: { clearData },
      shell: { openExternal, openPath },
      project: { pickAndImport },
      pdf: { print },
      pet: { setVisible },
    });

    await expect(openHostExternalUrl("https://example.com", scope)).resolves.toEqual({ ok: true });
    await expect(openHostProjectPath("project-2", scope)).resolves.toEqual({ ok: true });
    await expect(clearHostBrowserData({ cookies: true }, scope)).resolves.toEqual({ ok: true });
    await expect(pickAndImportHostProject({ skillId: "skill-1" }, scope)).resolves.toMatchObject({
      ok: true,
      projectId: "project-2",
    });
    await expect(printHostPdf("<html></html>", "nonce", { deck: true }, scope)).resolves.toEqual({ ok: true });
    expect(setHostPetVisible(true, scope)).toEqual({ ok: true });

    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    expect(openPath).toHaveBeenCalledWith("project-2");
    expect(clearData).toHaveBeenCalledWith({ cookies: true });
    expect(pickAndImport).toHaveBeenCalledWith({ skillId: "skill-1" });
    expect(print).toHaveBeenCalledWith("<html></html>", "nonce", { deck: true });
    expect(setVisible).toHaveBeenCalledWith(true);
  });

  it("does not expose updater capability on the host bridge", () => {
    expect(createMockReadableStudioHost()).not.toHaveProperty("updater");
  });

  it("installs and restores test hosts without exposing callers to the global key", () => {
    const scope: Record<string, unknown> = {};
    const restore = installMockReadableStudioHost({ scope });
    expect(getReadableStudioHost(scope)).not.toBeNull();
    restore();
    expect(getReadableStudioHost(scope)).toBeNull();
  });
});
