import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktopPackageRoot = join(repoRoot, "apps", "desktop");
const desktopRuntimePath = join(desktopPackageRoot, "src", "main", "runtime.ts");
const splashHtmlPath = join(desktopPackageRoot, "assets", "splash.html");
const packagedSourcePath = join(repoRoot, "apps", "packaged", "src", "index.ts");

function readDesktopPackageJson(): {
  exports?: Record<string, { default?: string; types?: string }>;
  files?: string[];
} {
  return JSON.parse(readFileSync(join(desktopPackageRoot, "package.json"), "utf8"));
}

describe("desktop package runtime shape", () => {
  it("keeps exported desktop types inside the published dist allowlist", () => {
    const pkg = readDesktopPackageJson();

    // `assets` ships the splash page (splash.html + splash.mp4) that
    // desktop main loads as real files; see resolveSplashHtmlPath in
    // apps/desktop/src/main/runtime.ts.
    expect(pkg.files).toEqual(["assets", "dist"]);
    expect(pkg.exports?.["./main"]?.default).toBe("./dist/main/index.js");
    expect(pkg.exports?.["./main"]?.types).toBe("./dist/main/index.d.ts");
  });

  it("places the sandbox preload next to packaged app entrypoints", () => {
    const packagedSource = readFileSync(packagedSourcePath, "utf8");
    expect(packagedSource).toContain('preloadPath: join(app.getAppPath(), "preload.cjs")');

    for (const relativePath of ["tools/pack/src/win/app.ts"]) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      expect(source).toContain('"apps", "desktop", "dist", "main", "preload.cjs"');
      expect(source).toContain('join(paths.assembledAppRoot, "preload.cjs")');
    }
  });

  it("stages the splash assets beside prebundled packaged app entrypoints", () => {
    // The standalone prebundle excludes the desktop tarball, so desktop main
    // resolves the splash page from `<appRoot>/assets/` (see
    // resolveSplashHtmlPath in apps/desktop/src/main/runtime.ts).
    for (const relativePath of ["tools/pack/src/win/app.ts"]) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      expect(source).toContain('join(config.workspaceRoot, "apps", "desktop", "assets")');
      expect(source).toContain('join(paths.assembledAppRoot, "assets")');
    }
  });

  it("waits for the rendered splash media to finish before revealing the app", () => {
    const finishedMarker = "data-readable-splash-finished";
    const runtimeSource = readFileSync(desktopRuntimePath, "utf8");
    const splashHtml = readFileSync(splashHtmlPath, "utf8");

    expect(splashHtml).toContain(finishedMarker);
    expect(runtimeSource).toContain(finishedMarker);
  });

  it("fills the fixed splash window without letterboxing", () => {
    const splashHtml = readFileSync(splashHtmlPath, "utf8");
    const videoStyle = /video\s*\{(?<css>[^}]*)\}/s.exec(splashHtml)?.groups?.css;

    expect(videoStyle).toContain("height: 100%");
    expect(videoStyle).toContain("object-fit: cover");
    expect(videoStyle).toContain("width: 100%");
    expect(videoStyle).not.toContain("max-height");
    expect(videoStyle).not.toContain("max-width");
  });
});
