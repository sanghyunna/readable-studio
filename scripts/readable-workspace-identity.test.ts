import assert from "node:assert/strict";
import test from "node:test";

import { scanWorkspaceIdentity, scanWorkspaceIdentitySources } from "./readable-workspace-identity.ts";

const retiredBinName = ["o", "d"].join("");
const retiredRootName = ["open", "design"].join("-");

const workspacePackages = new Map([
  ["apps/daemon/package.json", "@readable-studio/daemon"],
  ["apps/desktop/package.json", "@readable-studio/desktop"],
  ["apps/packaged/package.json", "@readable-studio/packaged"],
  ["apps/web/package.json", "@readable-studio/web"],
  ["e2e/package.json", "@readable-studio/e2e"],
  ["packages/agui-adapter/package.json", "@readable-studio/agui-adapter"],
  ["packages/components/package.json", "@readable-studio/components"],
  ["packages/contracts/package.json", "@readable-studio/contracts"],
  ["packages/diagnostics/package.json", "@readable-studio/diagnostics"],
  ["packages/download/package.json", "@readable-studio/download"],
  ["packages/host/package.json", "@readable-studio/host"],
  ["packages/metatool/package.json", "@readable-studio/metatool"],
  ["packages/platform/package.json", "@readable-studio/platform"],
  ["packages/plugin-runtime/package.json", "@readable-studio/plugin-runtime"],
  ["packages/product-identity/package.json", "@readable-studio/product-identity"],
  ["packages/registry-protocol/package.json", "@readable-studio/registry-protocol"],
  ["packages/sidecar-proto/package.json", "@readable-studio/sidecar-proto"],
  ["packages/sidecar/package.json", "@readable-studio/sidecar"],
  ["tools/dev/package.json", "@readable-studio/tools-dev"],
  ["tools/pack/package.json", "@readable-studio/tools-pack"],
]);

function readableWorkspaceSources(): Map<string, string> {
  const sources = new Map<string, string>([
    ["package.json", JSON.stringify({ name: "readable-studio", private: true, bin: { readable: "./apps/daemon/bin/readable.mjs" } })],
    ["apps/daemon/bin/readable.mjs", "await import('../dist/cli.js');"],
  ]);
  for (const [repositoryPath, name] of workspacePackages) {
    const bin = repositoryPath === "apps/daemon/package.json" ? { readable: "./bin/readable.mjs" } : undefined;
    sources.set(repositoryPath, JSON.stringify({ name, private: true, ...(bin ? { bin } : {}) }));
  }
  return sources;
}

function findingRules(sources: ReadonlyMap<string, string>): string[] {
  return scanWorkspaceIdentitySources(sources).map(({ rule }) => rule);
}

test("accepts exactly the private readable workspace graph and executable", () => {
  assert.deepEqual(scanWorkspaceIdentitySources(readableWorkspaceSources()), []);
});

test("rejects a missing root readable bin", () => {
  const sources = readableWorkspaceSources();
  sources.set("package.json", JSON.stringify({ name: "readable-studio", private: true }));
  assert.ok(findingRules(sources).includes("bin-contract"));
});

test("rejects a missing daemon readable bin", () => {
  const sources = readableWorkspaceSources();
  sources.set("apps/daemon/package.json", JSON.stringify({ name: "@readable-studio/daemon", private: true }));
  assert.ok(findingRules(sources).includes("bin-contract"));
});

test("rejects an extra legacy executable alias", () => {
  const sources = readableWorkspaceSources();
  sources.set("apps/daemon/package.json", JSON.stringify({
    name: "@readable-studio/daemon",
    private: true,
    bin: { readable: "./bin/readable.mjs", [retiredBinName]: `./bin/${retiredBinName}.mjs` },
  }));
  assert.ok(findingRules(sources).includes("old-bin"));
});

test("rejects false or missing private workspace manifests", () => {
  for (const privateValue of [false, undefined]) {
    const sources = readableWorkspaceSources();
    sources.set("packages/contracts/package.json", JSON.stringify({
      name: "@readable-studio/contracts",
      ...(privateValue === undefined ? {} : { private: privateValue }),
    }));
    assert.ok(findingRules(sources).includes("manifest-private"));
  }
});

test("rejects compatibility packages", () => {
  const sources = readableWorkspaceSources();
  sources.set(`packages/${retiredRootName}-compat/package.json`, JSON.stringify({
    name: `@readable-studio/${retiredRootName}-compat`,
    private: true,
  }));
  assert.ok(findingRules(sources).includes("compatibility-package"));
});

test("rejects old package filters in active shell scripts", () => {
  const sources = readableWorkspaceSources();
  const oldScope = `@${"open"}-${"design"}`;
  sources.set("scripts/build.sh", `pnpm --filter ${oldScope}/daemon build\n`);
  assert.ok(findingRules(sources).includes("old-scope"));
});

test("rejects old package scope and executable identities", () => {
  const sources = readableWorkspaceSources();
  const oldScope = `@${"open"}-${"design"}`;
  sources.set("apps/daemon/src/cli.ts", `import { x } from '${oldScope}/contracts';`);
  const retiredBinPath = `apps/daemon/bin/${retiredBinName}.mjs`;
  sources.set(retiredBinPath, "");
  assert.deepEqual(
    scanWorkspaceIdentitySources(sources).filter(({ rule }) => rule === "old-bin" || rule === "old-scope")
      .map(({ path, rule }) => [path, rule]),
    [["apps/daemon/src/cli.ts", "old-scope"], [retiredBinPath, "old-bin"]],
  );
});

test("repository has only the readable workspace identity", async () => {
  assert.deepEqual(await scanWorkspaceIdentity(), []);
});
