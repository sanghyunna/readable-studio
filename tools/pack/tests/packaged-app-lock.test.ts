import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { writePackagedAppLock } from "../src/win/app.js";
import lock from "../src/win/packaged-app-lock.json" with { type: "json" };
import piPackage from "../src/pi-package.json" with { type: "json" };
import { WIN_PREBUNDLE_RUNTIME_DEPENDENCIES } from "../src/win-prebundle.js";

describe("packaged app registry lock", () => {
  it.each(["relative", "absolute"])("reads %s tarball specs independently of PATH tar", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pack-lock-tar-"));
    const nativeTar = join(process.env.SystemRoot!, "System32", "tar.exe");
    const packed = { name: "@readable-studio/components", version: "0.8.0", dependencies: { react: "18.3.1" } };
    try {
      await mkdir(join(root, "fixture", "package"), { recursive: true });
      await mkdir(join(root, "app"));
      await writeFile(join(root, "fixture", "package", "package.json"), JSON.stringify(packed));
      await promisify(execFile)(nativeTar, ["-czf", join(root, "components.tgz"), "-C", join(root, "fixture"), "package"], { windowsHide: true });
      const spec = kind === "absolute" ? `file:${join(root, "components.tgz")}` : "file:../components.tgz";
      await writeFile(join(root, "app", "package.json"), JSON.stringify({ version: "1.3.0", dependencies: { [packed.name]: spec } }));
      vi.stubEnv("PATH", `${join(process.env.ProgramFiles!, "Git", "usr", "bin")}${delimiter}${process.env.PATH}`);
      await writePackagedAppLock(join(root, "app"));
      const generated = JSON.parse(await readFile(join(root, "app", "package-lock.json"), "utf8"));
      expect(generated.packages["node_modules/@readable-studio/components"]).toMatchObject({
        version: packed.version, dependencies: packed.dependencies, resolved: spec.replaceAll("\\", "/"),
        integrity: expect.stringMatching(/^sha512-/),
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
  it("pins the HEAD runtime graph including Pi integrity and node ABI", () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages["node_modules/node-abi"].version).toBe("3.98.0");
    const pi = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
    expect(pi.version).toBe(piPackage.version);
    expect(pi.integrity).toBe(piPackage.integrity);
    for (const [name, version] of Object.entries(WIN_PREBUNDLE_RUNTIME_DEPENDENCIES)) {
      expect((lock.packages[""].dependencies as Record<string, string>)[name]).toBe(version);
    }
  });

  it("keeps integrity for every registry package, leaving only generated tarballs mutable", () => {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === "" || path.startsWith("node_modules/@readable-studio/")) continue;
      expect(entry).toHaveProperty("integrity", expect.stringMatching(/^sha512-/));
      expect(entry).toHaveProperty("resolved", expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//));
    }
  });
});
