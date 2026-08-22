import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { ensureWindowsNativeIsolator } from "../src/native-isolator-build.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("native isolator build", () => {
  it("builds a missing or stale clean-checkout helper and reuses a fresh one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "readable-native-build-"));
    roots.push(root);
    const nativeRoot = path.join(root, "packages/platform/native/win32");
    const output = path.join(root, "packages/platform/dist/native/win32/agent-isolator.exe");
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(path.join(nativeRoot, "build.ps1"), "build");
    await writeFile(path.join(nativeRoot, "agent-isolator.cpp"), "source");

    let builds = 0;
    const runBuild = async () => {
      builds += 1;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "binary");
    };
    const logs: string[] = [];
    assert.equal(await ensureWindowsNativeIsolator({
      log: async (message) => { logs.push(message); },
      platform: "win32",
      runBuild,
      workspaceRoot: root,
    }), true);
    assert.equal(await ensureWindowsNativeIsolator({
      log: async (message) => { logs.push(message); },
      platform: "win32",
      runBuild,
      workspaceRoot: root,
    }), false);
    assert.equal(builds, 1);
    assert.match(logs.join(""), /helper is missing/);

    await utimes(output, new Date(0), new Date(0));
    assert.equal(await ensureWindowsNativeIsolator({
      log: async (message) => { logs.push(message); },
      platform: "win32",
      runBuild,
      workspaceRoot: root,
    }), true);
    assert.equal(builds, 2);
    assert.match(logs.join(""), /native source is newer/);
  });
});
