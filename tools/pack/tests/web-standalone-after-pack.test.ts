import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { compileFunction } from "node:vm";
import path, { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { profileWebStandaloneAfterPack } from "../src/profile-after-pack.js";

const require = createRequire(import.meta.url);
const runWebStandaloneAfterPack = require("../resources/web-standalone-after-pack.cjs") as (context: unknown) => Promise<void>;

const CONFIG_ENV = "READABLE_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writePackage(packageRoot: string, packageName: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "index.js"), "module.exports = {};\n", "utf8");
}

async function writePnpmLinkedPackage(standaloneRoot: string, packageName: string): Promise<string> {
  const packageDirectoryName = `${packageName}@0.0.0`.split("/").join("+");
  const packageRoot = join(standaloneRoot, "node_modules", ".pnpm", packageDirectoryName, "node_modules", packageName);
  const hoistPath = join(standaloneRoot, "node_modules", ".pnpm", "node_modules", packageName);
  await writePackage(packageRoot, packageName);
  await mkdir(path.dirname(hoistPath), { recursive: true });
  await symlink(packageRoot, hoistPath);
  return packageRoot;
}

async function writeRootWebPackage(resourcesRoot: string): Promise<void> {
  const webPackageRoot = join(resourcesRoot, "app", "node_modules", "@readable-studio", "web");
  await mkdir(join(webPackageRoot, "dist", "sidecar"), { recursive: true });
  await writeFile(join(webPackageRoot, "package.json"), "{\"name\":\"@readable-studio/web\"}\n", "utf8");
  await writeFile(join(webPackageRoot, "dist", "sidecar", "index.js"), "module.exports = {};\n", "utf8");
}

async function writeStandaloneFixture(
  workspaceRoot: string,
  options: { includeHoistedNext: boolean; includeWebNext: boolean; useAbsolutePnpmSymlinks?: boolean },
): Promise<string> {
  const standaloneRoot = join(workspaceRoot, "apps", "web", ".next", "standalone");
  const sourceWebRoot = join(standaloneRoot, "apps", "web");
  const hoistRoot = join(standaloneRoot, "node_modules", ".pnpm", "node_modules");

  if (options.useAbsolutePnpmSymlinks) {
    const nextPackageRoot = options.includeHoistedNext ? await writePnpmLinkedPackage(standaloneRoot, "next") : null;
    await writePnpmLinkedPackage(standaloneRoot, "react");
    await writePnpmLinkedPackage(standaloneRoot, "react-dom");
    await writePnpmLinkedPackage(standaloneRoot, "styled-jsx");
    if (options.includeWebNext && nextPackageRoot != null) {
      await mkdir(join(sourceWebRoot, "node_modules"), { recursive: true });
      await symlink(nextPackageRoot, join(sourceWebRoot, "node_modules", "next"));
    }
  } else {
    if (options.includeHoistedNext) {
      await writePackage(join(hoistRoot, "next"), "next");
    }
    await writePackage(join(hoistRoot, "react"), "react");
    await writePackage(join(hoistRoot, "react-dom"), "react-dom");
    await writePackage(join(hoistRoot, "styled-jsx"), "styled-jsx");
    if (options.includeWebNext) {
      await writePackage(join(sourceWebRoot, "node_modules", "next"), "next");
    }
  }

  await mkdir(join(sourceWebRoot, ".next", "static"), { recursive: true });
  await writeFile(join(sourceWebRoot, "server.js"), "module.exports = {};\n", "utf8");
  await writeFile(join(sourceWebRoot, ".next", "BUILD_ID"), "fixture\n", "utf8");

  await mkdir(join(workspaceRoot, "apps", "web", ".next", "static"), { recursive: true });
  await writeFile(join(workspaceRoot, "apps", "web", ".next", "static", "client.js"), "client();\n", "utf8");

  return standaloneRoot;
}

async function runFixture(options: {
  profile?: boolean;
  includeHoistedNext?: boolean;
  includeWebNext: boolean;
  omitRootWebPackage?: boolean;
  requireRootWebPackageAudit?: boolean;
  useAbsolutePnpmSymlinks?: boolean;
  thumbnailPublicRoot?: string;
}): Promise<{
  appOutDir: string;
  auditReportPath: string;
  destinationRoot: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "readable-studio-web-standalone-hook-"));
  const workspaceRoot = join(root, "workspace");
  const standaloneSourceRoot = await writeStandaloneFixture(workspaceRoot, {
    includeHoistedNext: options.includeHoistedNext ?? true,
    includeWebNext: options.includeWebNext,
    useAbsolutePnpmSymlinks: options.useAbsolutePnpmSymlinks,
  });
  if (options.thumbnailPublicRoot) {
    await cp(options.thumbnailPublicRoot, join(workspaceRoot, "apps", "web", "public", "template-thumbnails"), { recursive: true });
  }
  const appOutDir = join(root, "builder", "win-unpacked");
  const resourcesRoot = join(appOutDir, "resources");
  const auditReportPath = join(root, "audit.json");
  const configPath = join(root, "config.json");
  const oldConfigEnv = process.env[CONFIG_ENV];

  await mkdir(resourcesRoot, { recursive: true });
  if (options.omitRootWebPackage !== true) {
    await writeRootWebPackage(resourcesRoot);
  }
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        auditReportPath,
        pruneCopiedSharp: false,
        pruneRootNext: false,
        pruneRootSharp: false,
        ...(options.requireRootWebPackageAudit == null
          ? {}
          : { requireRootWebPackageAudit: options.requireRootWebPackageAudit }),
        resourceName: "readable-studio-web-standalone",
        standaloneSourceRoot,
        version: 1,
        webPublicSourceRoot: join(workspaceRoot, "apps", "web", "public"),
        webStaticSourceRoot: join(workspaceRoot, "apps", "web", ".next", "static"),
        workspaceRoot,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.env[CONFIG_ENV] = configPath;
  try {
    const hook = options.profile ? profileWebStandaloneAfterPack : runWebStandaloneAfterPack;
    await hook({
      appOutDir,
      electronPlatformName: "win32",
      packager: { appInfo: { productFilename: "Readable Studio" } },
    });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  } finally {
    if (oldConfigEnv == null) {
      delete process.env[CONFIG_ENV];
    } else {
      process.env[CONFIG_ENV] = oldConfigEnv;
    }
  }

  return {
    appOutDir,
    auditReportPath,
    destinationRoot: join(resourcesRoot, "readable-studio-web-standalone"),
    root,
  };
}

describe("web standalone afterPack hook", () => {
  it("overlaps leaf work within the CPU budget and drains a failed batch", async () => {
    const source = await readFile(join(import.meta.dirname, "../resources/web-standalone-after-pack.cjs"), "utf8");
    const loaded: { exports: unknown } = { exports: {} };
    compileFunction(`${source}\nmodule.exports = visitPaths;`, ["require", "module", "exports"])(require, loaded, loaded.exports);
    const visitPaths = loaded.exports as (root: string, visit: (current: string) => Promise<string[] | void>) => Promise<void>;
    const width = Math.min(20, availableParallelism());
    let active = 0;
    let peak = 0;
    let completed = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error("leaf failed");
    await expect(visitPaths("root", async (current) => {
      if (current === "root") return Array.from({ length: width + 1 }, (_, i) => String(i));
      active += 1;
      peak = Math.max(peak, active);
      if (active === width) release!();
      // All workers enter before any finishes; no sleep or timing assumption.
      await barrier;
      active -= 1;
      completed += 1;
      if (current === "0") throw failure;
    })).rejects.toBe(failure);
    expect(peak).toBe(width);
    expect(active).toBe(0);
    expect(completed).toBe(width);
  });

  it("packages every declared Hub thumbnail and its coverage manifest", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const sourceRoot = join(repoRoot, "apps/web/public/template-thumbnails");
    const fixture = await runFixture({ includeWebNext: true, thumbnailPublicRoot: sourceRoot });
    try {
      const packaged = join(fixture.destinationRoot, "apps/web/public/template-thumbnails");
      const manifest = JSON.parse(await readFile(join(packaged, "manifest.json"), "utf8")) as { entries: { id: string }[] };
      const ids = new Set(manifest.entries.map(entry => entry.id));
      const files = execFileSync("fd", ["^readable-studio\\.json$", "plugins/_official/examples"], { cwd: repoRoot, encoding: "utf8" }).trim().split(/\r?\n/);
      let count = 0;
      for (const file of files) {
        const plugin = JSON.parse(await readFile(join(repoRoot, file), "utf8"));
        if (!plugin.readable.thumbnail) continue;
        count += 1;
        expect(ids.has(plugin.name), plugin.name).toBe(true);
        const name = path.basename(plugin.readable.thumbnail.src);
        expect(await readFile(join(packaged, name))).toEqual(await readFile(join(sourceRoot, name)));
      }
      expect(count).toBeGreaterThan(0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }, 30_000);
  it("preserves the actual hook audit when profiling its copies and audits", async () => {
    // Given the original hook's output on an independent tiny filesystem fixture
    const baseline = await runFixture({ includeWebNext: true });
    const normalize = async (fixture: { root: string; auditReportPath: string }) => {
      const text = await readFile(fixture.auditReportPath, "utf8");
      const report: Record<string, unknown> = JSON.parse(text.replaceAll(JSON.stringify(fixture.root).slice(1, -1), "<fixture>"));
      delete report.generatedAt;
      return report;
    };
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // When the profiling hook processes the same fixture contents
      const profiled = await runFixture({ includeWebNext: true, profile: true });
      try {
        // Then real closure/content audits match, and nested stage timings are recorded
        expect(await normalize(profiled)).toEqual(await normalize(baseline));
        const records = output.mock.calls.map(([line]) => JSON.parse(String(line).replace("[tools-pack profile] ", "")));
        expect(records).toContainEqual(expect.objectContaining({ phase: "after-pack:copyRequired", status: "done" }));
        expect(records).toContainEqual(expect.objectContaining({ phase: "after-pack:auditCopiedStandalone", status: "done" }));
      } finally {
        await rm(profiled.root, { recursive: true, force: true });
      }
    } finally {
      vi.unstubAllEnvs();
      output.mockRestore();
      await rm(baseline.root, { recursive: true, force: true });
    }
  });

  it("deduplicates win32 copied standalone Next and moves the retained bytes to the shorter ancestor", async () => {
    const fixture = await runFixture({ includeWebNext: true });

    try {
      expect(await pathExists(join(fixture.destinationRoot, "node_modules", "next"))).toBe(true);
      expect(await pathExists(join(fixture.destinationRoot, "node_modules", ".pnpm", "node_modules", "next"))).toBe(false);
      expect(await pathExists(join(fixture.destinationRoot, "apps", "web", "node_modules", "next", "package.json"))).toBe(false);

      const report = JSON.parse(await readFile(fixture.auditReportPath, "utf8")) as {
        copiedAudit: { resolvedModules: Record<string, string>; brokenSymlinks: string[] };
        copiedNextDedupe: { removedPaths: Array<{ reason: string }>; retainedPath: string };
        copiedNextDedupeAudit: { resolvedNextPackagePath: string; remainingPaths: string[] };
      };
      const resolvedNextPath = report.copiedNextDedupeAudit.resolvedNextPackagePath.split(path.sep).join("/");

      expect(report.copiedNextDedupe.removedPaths.map((entry) => entry.reason)).toEqual([
        "copied standalone root next public-hoist duplicate",
        "copied standalone pnpm-hoisted next duplicate superseded by app-local next",
      ]);
      expect(report.copiedNextDedupe.retainedPath.split(path.sep).join("/")).toMatch(
        /readable-studio-web-standalone\/node_modules\/next$/,
      );
      expect(report.copiedNextDedupeAudit.remainingPaths).toEqual([]);
      expect(resolvedNextPath).toMatch(
        /readable-studio-web-standalone\/node_modules\/next\/package\.json$/,
      );
      expect(report.copiedAudit.brokenSymlinks).toEqual([]);
      expect(report.copiedAudit.resolvedModules["next/package.json"].split(path.sep).join("/")).toMatch(
        /readable-studio-web-standalone\/node_modules\/next\/package\.json$/,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects any packaged entry above the Explorer extraction budget", async () => {
    const source = await readFile(join(import.meta.dirname, "../resources/web-standalone-after-pack.cjs"), "utf8");
    const loaded: { exports: unknown } = { exports: {} };
    compileFunction(`${source}\nmodule.exports = auditPortablePaths;`, ["require", "module", "exports"])(require, loaded, loaded.exports);
    const audit = loaded.exports as (root: string) => Promise<{ budget: number; maxLength: number }>;
    const root = await mkdtemp(join(tmpdir(), "pack-path-budget-"));
    try {
      const legal = "x".repeat(174);
      await writeFile(join(root, legal), "same bytes");
      expect(await audit(root)).toMatchObject({ budget: 178, maxLength: 178 });
      await writeFile(join(root, `${legal}x`), "same bytes");
      await expect(audit(root)).rejects.toThrow(/portable path budget 178 exceeded/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("shortens dereferenced peer stores without changing bytes or module lookup", async () => {
    const source = await readFile(join(import.meta.dirname, "../resources/web-standalone-after-pack.cjs"), "utf8");
    const loaded: { exports: unknown } = { exports: {} };
    compileFunction(`${source}\nmodule.exports = shortenCopiedVirtualStore;`, ["require", "module", "exports"])(require, loaded, loaded.exports);
    const shorten = loaded.exports as (root: string) => Promise<Array<{ from: string; to: string }>>;
    const root = await mkdtemp(join(tmpdir(), "pack-peer-store-"));
    try {
      const store = join(root, "node_modules", ".pnpm", `next@16.2.6_${"peer".repeat(15)}`);
      await writePackage(join(store, "node_modules", "next"), "next");
      await writePackage(join(store, "node_modules", "react"), "react");
      const before = await readFile(join(store, "node_modules", "next", "package.json"));
      const renamed = await shorten(root);
      expect(renamed).toHaveLength(1);
      expect(path.basename(renamed[0]!.to)).toHaveLength(7);
      const entry = join(renamed[0]!.to, "node_modules", "next", "index.js");
      expect(await readFile(join(path.dirname(entry), "package.json"))).toEqual(before);
      expect(createRequire(entry).resolve("react/package.json")).toBe(join(renamed[0]!.to, "node_modules", "react", "package.json"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails the win32 Next dedupe when no copied Next package exists", async () => {
    await expect(runFixture({ includeHoistedNext: false, includeWebNext: false })).rejects.toThrow(
      /copied standalone app-local Next package missing/,
    );
  });

  it("allows win32 prebundle mode to omit the root web package audit", async () => {
    const fixture = await runFixture({
      includeWebNext: true,
      omitRootWebPackage: true,
      requireRootWebPackageAudit: false,
    });

    try {
      const report = JSON.parse(await readFile(fixture.auditReportPath, "utf8")) as {
        rootWebPackageAudit: unknown;
      };

      expect(report.rootWebPackageAudit).toBeNull();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

});
