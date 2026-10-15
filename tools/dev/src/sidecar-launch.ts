import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Sidecars run as `node --import <tsx loader> <entry>` in a single process.
// Going through `tsx/cli` added a second node process spawned by tsx without
// windowsHide; because tools-dev starts sidecars detached (no console), that
// grandchild got a fresh console - a visible conhost / Windows Terminal tab.
export function resolveTsxLoaderPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("tsx");
}

// Resolves from both src/ and the bundled dist/ (each one level under tools/dev).
export function resolveHiddenConsoleLauncherPath(): string {
  return fileURLToPath(new URL("../src/hidden-console-launcher.ts", import.meta.url));
}

// On Windows the detached sidecar would have no console, so any console child it
// spawns without windowsHide gets a visible one; the launcher hop gives the sidecar
// a hidden console its descendants inherit (see hidden-console-launcher.ts).
export function createSidecarLaunchArgs(request: {
  entryPath: string;
  hiddenConsoleLauncherPath?: string | null;
  stampArgs: readonly string[];
  tsxLoaderPath: string;
}): string[] {
  const sidecarArgs = ["--import", pathToFileURL(request.tsxLoaderPath).href, request.entryPath, ...request.stampArgs];
  return request.hiddenConsoleLauncherPath ? [request.hiddenConsoleLauncherPath, ...sidecarArgs] : sidecarArgs;
}
