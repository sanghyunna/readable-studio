import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createBackgroundSpawnOptions } from "@readable-studio/platform";

import {
  createSidecarLaunchArgs,
  resolveHiddenConsoleLauncherPath,
  resolveTsxLoaderPath,
} from "../src/sidecar-launch.js";

describe("tools-dev sidecar launch", () => {
  it("loads tsx in-process instead of hopping through the tsx cli", () => {
    const loader = path.resolve("/x/node_modules/tsx/dist/loader.mjs");
    const entry = path.resolve("/repo/apps/daemon/src/sidecar/index.ts");

    const args = createSidecarLaunchArgs({ entryPath: entry, stampArgs: ["--stamp=a"], tsxLoaderPath: loader });

    assert.deepEqual(args, ["--import", pathToFileURL(loader).href, entry, "--stamp=a"]);
    assert.ok(!args.some((arg) => /tsx[\\/]dist[\\/]cli\.mjs$/u.test(arg)));
  });

  it("prefixes the hidden-console launcher when one is configured", () => {
    const loader = path.resolve("/x/node_modules/tsx/dist/loader.mjs");
    const entry = path.resolve("/repo/apps/web/sidecar/index.ts");
    const launcher = path.resolve("/repo/tools/dev/src/hidden-console-launcher.ts");

    const args = createSidecarLaunchArgs({
      entryPath: entry,
      hiddenConsoleLauncherPath: launcher,
      stampArgs: ["--stamp=a"],
      tsxLoaderPath: loader,
    });

    assert.deepEqual(args, [launcher, "--import", pathToFileURL(loader).href, entry, "--stamp=a"]);
  });

  it("resolves a launcher file that node can run directly", () => {
    const launcher = resolveHiddenConsoleLauncherPath();

    assert.match(launcher, /tools[\\/]dev[\\/]src[\\/]hidden-console-launcher\.ts$/u);
    assert.ok(existsSync(launcher));
  });

  it("launcher runs the sidecar argv with inherited output and its exit code", () => {
    const result = spawnSync(
      process.execPath,
      [resolveHiddenConsoleLauncherPath(), "-e", "process.stdout.write(process.argv[1]); process.exit(3)", "--", "--stamp=a"],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.stdout, "--stamp=a");
    assert.equal(result.status, 3);
  });

  it("resolves the tsx loader module rather than the cli", () => {
    assert.match(resolveTsxLoaderPath(), /tsx[\\/]dist[\\/]loader\.mjs$/u);
  });

  it("hides Windows consoles for detached background sidecars", () => {
    const options = createBackgroundSpawnOptions({ command: process.execPath, logFd: 7 }, { args: [], command: process.execPath }, "win32");

    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", 7, 7]);
  });

  it("does not request windowsHide off Windows", () => {
    const options = createBackgroundSpawnOptions({ command: "node", detached: false }, { args: [], command: "node" }, "linux");

    assert.equal(options.windowsHide, false);
    assert.equal(options.detached, false);
  });
});
