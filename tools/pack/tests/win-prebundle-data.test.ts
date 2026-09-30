import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { expect, test } from "vitest";

import { assertWinDaemonRuntimeAssets, WIN_DAEMON_RUNTIME_ASSETS, WIN_PREBUNDLE_POLICIES, WIN_PREBUNDLE_RUNTIME_DEPENDENCIES } from "../src/win-prebundle.js";

const execFileAsync = promisify(execFile);
const htmlEditRoot = fileURLToPath(new URL("../../../packages/html-edit/", import.meta.url));
const htmlRequire = createRequire(join(htmlEditRoot, "package.json"));
const cssTreeRoot = dirname(htmlRequire.resolve("css-tree/package.json"));
const cssRequire = createRequire(join(cssTreeRoot, "package.json"));
const dataFiles = ["css-tree/data/patch.json", "mdn-data/css/at-rules.json", "mdn-data/css/properties.json", "mdn-data/css/syntaxes.json"];

async function stagePackage(appRoot: string, name: string, source: string): Promise<void> {
  await cp(source, join(appRoot, "node_modules", name), { recursive: true });
}

async function stageShellAssets(daemonRoot: string): Promise<void> {
  await mkdir(join(daemonRoot, "chunks"), { recursive: true });
  for (const asset of WIN_DAEMON_RUNTIME_ASSETS) await writeFile(join(daemonRoot, "chunks", asset), "export {};\n");
}

test("the daemon prebundle loads css-tree's package-relative JSON from a relocated packaged layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "win-prebundle-data-"));
  const appRoot = join(root, "resources", "app");
  const daemonRoot = join(appRoot, "prebundled", "daemon");
  try {
    await stageShellAssets(daemonRoot);
    await stagePackage(appRoot, "css-tree", cssTreeRoot);
    for (const name of ["mdn-data", "source-map-js"]) {
      await stagePackage(appRoot, name, dirname(cssRequire.resolve(`${name}/package.json`)));
    }
    const outfile = join(daemonRoot, "chunks", "probe.mjs");
    await build({
      stdin: { contents: 'import { parse, generate, lexer } from "css-tree"; if (generate(parse("a{width:10px}")) !== "a{width:10px}" || lexer.matchProperty("width", "10px").error) throw new Error("CSS data unavailable"); console.log("CSS_TREE_DATA_OK");', resolveDir: htmlEditRoot },
      bundle: true, platform: "node", format: "esm", outfile,
      external: [...WIN_PREBUNDLE_POLICIES.daemonSidecar.externals],
    });
    const { stdout } = await execFileAsync(process.execPath, [outfile], { cwd: root, windowsHide: true, timeout: 10_000 });
    expect(stdout.trim()).toBe("CSS_TREE_DATA_OK");
    expect(WIN_PREBUNDLE_RUNTIME_DEPENDENCIES).toHaveProperty("css-tree", "3.2.1");
    await expect(assertWinDaemonRuntimeAssets(daemonRoot)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

for (const missing of dataFiles) {
  test(`the packaged runtime marker gate rejects missing transitive data: ${missing}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "win-runtime-data-missing-"));
    const daemonRoot = join(root, "prebundled", "daemon");
    try {
      await stageShellAssets(daemonRoot);
      for (const file of dataFiles) {
        if (file === missing) continue;
        const target = join(root, "node_modules", file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "{}");
      }
      await expect(assertWinDaemonRuntimeAssets(daemonRoot)).rejects.toThrow(join(root, "node_modules", missing));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
