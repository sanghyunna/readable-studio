import { mkdir, mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashPackageSourcePath } from "../src/package-source-hash.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(name = "daemon") {
  const root = await mkdtemp(join(tmpdir(), "readable-studio-package-source-hash-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "apps", name);
  const put = async (path: string, value: string) => {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  };
  const putPackage = (path: string, value: string) => put(`apps/${name}/${path}`, value);
  await put("package.json", JSON.stringify({ packageManager: "pnpm@10.33.2" }));
  await put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await putPackage("package.json", JSON.stringify({
    name: `@readable-studio/${name}`, version: "1.0.0", files: ["dist"],
  }));
  await putPackage("tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
  await putPackage("src/index.ts", "export const value = 1;\n");
  await putPackage("tests/index.test.ts", "export const expected = 1;\n");
  await putPackage("docs/development.md", "Development notes.\n");
  return { root, packageRoot, put, putPackage, hash: () => hashPackageSourcePath(packageRoot) };
}

describe("hashPackageSourcePath", () => {
  it("includes package versions in the source hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-package-source-hash-"));
    const packageRoot = join(root, "apps", "packaged");
    try {
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(join(packageRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "@readable-studio/packaged", version: "1.0.0" }, null, 2)}\n`, "utf8");
      const firstHash = await hashPackageSourcePath(packageRoot);

      await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "@readable-studio/packaged", version: "1.0.1" }, null, 2)}\n`, "utf8");
      const secondHash = await hashPackageSourcePath(packageRoot);

      expect(secondHash).not.toBe(firstHash);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps an unchanged tree stable", async () => {
    const f = await fixture();
    expect(await f.hash()).toBe(await f.hash());
  });

  it.each(["tests/index.test.ts", "docs/development.md"])("ignores proven non-input %s", async (path) => {
    const f = await fixture();
    const before = await f.hash();
    await f.putPackage(path, "changed");
    expect(await f.hash()).toBe(before);
  });

  it("includes an added runtime file without editing any existing input", async () => {
    const f = await fixture();
    const before = await f.hash();
    await f.putPackage("src/runtimes/new-loader.ts", "export const added = true;");
    expect(await f.hash()).not.toBe(before);
  });

  it("includes an edited runtime file in a separate trial", async () => {
    const f = await fixture();
    const before = await f.hash();
    await f.putPackage("src/index.ts", "export const value = 2;\n");
    expect(await f.hash()).not.toBe(before);
  });

  it("includes a deleted runtime file", async () => {
    const f = await fixture();
    const before = await f.hash();
    await rm(join(f.packageRoot, "src/index.ts"));
    expect(await f.hash()).not.toBe(before);
  });

  it("includes a renamed runtime file with identical bytes", async () => {
    const f = await fixture();
    const before = await f.hash();
    await rename(join(f.packageRoot, "src/index.ts"), join(f.packageRoot, "src/renamed.ts"));
    expect(await f.hash()).not.toBe(before);
  });

  it.each(["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc", "patches/new.patch"])(
    "includes workspace input %s", async (path) => {
      const f = await fixture();
      const before = await f.hash();
      await f.put(path, path.endsWith(".json") ? '{"packageManager":"pnpm@10.34.0"}' : "changed");
      expect(await f.hash()).not.toBe(before);
    },
  );

  it("includes tsconfig changes", async () => {
    const f = await fixture();
    const before = await f.hash();
    await f.putPackage("tsconfig.json", '{"include":["src/**/*.ts"],"compilerOptions":{"strict":true}}');
    expect(await f.hash()).not.toBe(before);
  });

  it("retains web tests as production build inputs", async () => {
    const f = await fixture("web");
    await f.putPackage("tsconfig.json", '{"include":["src/**/*","tests/**/*"]}');
    const before = await f.hash();
    await f.putPackage("tests/index.test.ts", "export const expected = 2;");
    expect(await f.hash()).not.toBe(before);
  });

  it.each(["src/prompts/system.md", "src/vendor/dist/runtime.js", "bin/new.mjs"])(
    "retains new runtime data beneath positive roots: %s", async (path) => {
      const f = await fixture();
      const before = await f.hash();
      await f.putPackage(path, "runtime");
      expect(await f.hash()).not.toBe(before);
    },
  );

  it.each([
    ["desktop", "assets/new.html"], ["platform", "native/win32/new.h"],
    ["components", "src/new.module.css"], ["web", "public/vendor/new.js"],
    ["web", ".env.production.local"], ["packaged", "esbuild.config.mjs"],
    ["product-identity", "product-identity.json"],
  ])("retains %s input %s", async (name, path) => {
    const f = await fixture(name);
    const before = await f.hash();
    await f.putPackage(path, "runtime");
    expect(await f.hash()).not.toBe(before);
  });

  it.each(["README.md", "LICENSE", ".npmignore"])("retains pack input %s", async (path) => {
    const f = await fixture();
    const before = await f.hash();
    await f.putPackage(path, "pack input");
    expect(await f.hash()).not.toBe(before);
  });

  it("discovers new roots declared by files, bin, exports and tsconfig", async () => {
    const f = await fixture();
    await f.putPackage("package.json", JSON.stringify({
      name: "@readable-studio/daemon", files: ["dist", "resources/**"],
      bin: { readable: "./commands/run.mjs" }, exports: { "./data": "./data/value.txt" },
    }));
    await f.putPackage("tsconfig.json", '{"include":["src/**/*.ts","generated/**/*.ts"],"files":["globals.d.ts"]}');
    for (const path of ["resources/new.md", "commands/run.mjs", "data/value.txt", "generated/new.ts", "globals.d.ts"]) {
      const before = await f.hash();
      await f.putPackage(path, "new input");
      expect(await f.hash(), path).not.toBe(before);
    }
  });

  it("retains tests newly included by a production tsconfig", async () => {
    const f = await fixture();
    await f.putPackage("tsconfig.json", '{"include":["src/**/*.ts","tests/**/*.ts"]}');
    const before = await f.hash();
    await f.putPackage("tests/index.test.ts", "changed");
    expect(await f.hash()).not.toBe(before);
  });

  it("includes inherited compiler configuration and its positive roots", async () => {
    const f = await fixture();
    await f.putPackage("tsconfig.json", '{"extends":"./config/base.json"}');
    await f.putPackage("config/base.json", '{"include":["../extra/**/*.ts"]}');
    const before = await f.hash();
    await f.putPackage("extra/new.ts", "export {};");
    expect(await f.hash()).not.toBe(before);
  });

  it("includes helpers next to newly declared build scripts", async () => {
    const f = await fixture();
    await f.putPackage("package.json", JSON.stringify({
      name: "@readable-studio/daemon", files: ["dist"], scripts: { build: "node ./scripts/build.mjs" },
    }));
    const before = await f.hash();
    await f.putPackage("scripts/new-helper.mjs", "export {};");
    expect(await f.hash()).not.toBe(before);
  });

  it("includes bare relative build-script helpers and tolerates unrelated words", async () => {
    const f = await fixture();
    await f.putPackage("package.json", JSON.stringify({
      name: "@readable-studio/daemon", files: ["dist"],
      scripts: { build: "tsc -p tsconfig.json && node --import tsx scripts/write-build-stamp.ts nonexistent/word" },
    }));
    await f.putPackage("scripts/write-build-stamp.ts", "export const stamp = 1;\n");
    const before = await f.hash();
    await f.putPackage("scripts/write-build-stamp.ts", "export const stamp = 2;\n");
    expect(await f.hash()).not.toBe(before);
  });

  it.each(["dist/index.js", ".next/BUILD_ID", "out/index.html", "node_modules/dependency/index.js"])(
    "ignores generated package root %s", async (path) => {
      const f = await fixture();
      const before = await f.hash();
      await f.putPackage(path, "generated");
      expect(await f.hash()).toBe(before);
    },
  );

  it("does not narrow an unaudited package", async () => {
    const f = await fixture("future-package");
    const before = await f.hash();
    await f.putPackage("tests/index.test.ts", "potential build input");
    expect(await f.hash()).not.toBe(before);
  });

  it("does not exclude packed tests when files has no allowlist", async () => {
    const f = await fixture();
    await f.putPackage("package.json", '{"name":"@readable-studio/daemon"}');
    const before = await f.hash();
    await f.putPackage("tests/index.test.ts", "packed input");
    expect(await f.hash()).not.toBe(before);
  });
});
