import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const oldScope = `@${"open"}-${"design"}`;
const oldRootName = `${"open"}-${"design"}`;
const oldBinName = ["o", "d"].join("");
const oldBinTargetPattern = new RegExp(`(?:^|[/\\\\])${oldBinName}(?:\\.[cm]?js)?$`, "u");
const expectedManifestNames = new Map([
  ["package.json", "readable-studio"],
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
const expectedBins = new Map<string, Readonly<Record<string, string>>>([
  ["package.json", { readable: "./apps/daemon/bin/readable.mjs" }],
  ["apps/daemon/package.json", { readable: "./bin/readable.mjs" }],
]);

export type WorkspaceIdentityFinding = {
  readonly path: string;
  readonly rule: "bin-contract" | "compatibility-package" | "manifest-private" | "old-bin" | "old-root-name" | "old-scope" | "package-graph" | "package-name";
  readonly value: string;
};

type PackageManifest = {
  readonly bin?: Readonly<Record<string, unknown>>;
  readonly name?: unknown;
  readonly private?: unknown;
};

function isWorkspaceManifestPath(repositoryPath: string): boolean {
  return repositoryPath === "package.json" || repositoryPath === "e2e/package.json" || /^(?:apps|packages|tools)\/[^/]+\/package\.json$/u.test(repositoryPath);
}

function isMachineSurface(repositoryPath: string): boolean {
  if (/^(?:CHANGELOG\.md|specs\/change\/|v\d+\.\d+\.\d+_(?:implementation|plan)\.md)/u.test(repositoryPath)) return false;
  if (repositoryPath.includes("/vendor/") || repositoryPath.startsWith("vendor/")) return false;
  return /\.(?:astro|bash|cjs|css|cts|js|json|jsonc|md|mjs|nix|ps1|sh|toml|ts|tsx|yaml|yml|zsh)$/u.test(repositoryPath);
}

function hasExactBin(actual: Readonly<Record<string, unknown>> | undefined, expected: Readonly<Record<string, string>>): boolean {
  if (actual === undefined) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right, "en"));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right, "en"));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

export function scanWorkspaceIdentitySources(sources: ReadonlyMap<string, string>): WorkspaceIdentityFinding[] {
  const findings: WorkspaceIdentityFinding[] = [];
  for (const [repositoryPath, source] of [...sources].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (isWorkspaceManifestPath(repositoryPath)) {
      const manifest = JSON.parse(source) as PackageManifest;
      const expectedName = expectedManifestNames.get(repositoryPath);
      if (expectedName === undefined) {
        findings.push({ path: repositoryPath, rule: "package-graph", value: String(manifest.name) });
      } else if (manifest.name !== expectedName) {
        findings.push({ path: repositoryPath, rule: repositoryPath === "package.json" && manifest.name === oldRootName ? "old-root-name" : "package-name", value: String(manifest.name) });
      }
      if (manifest.private !== true) {
        findings.push({ path: repositoryPath, rule: "manifest-private", value: String(manifest.private) });
      }
      if (typeof manifest.name === "string" && manifest.name.includes(oldRootName)) {
        findings.push({ path: repositoryPath, rule: "compatibility-package", value: manifest.name });
      }
      for (const [binName, target] of Object.entries(manifest.bin ?? {})) {
        if (binName === oldBinName || typeof target === "string" && oldBinTargetPattern.test(target)) {
          findings.push({ path: repositoryPath, rule: "old-bin", value: `${binName}:${String(target)}` });
        }
      }
      const expectedBin = expectedBins.get(repositoryPath);
      if (expectedBin !== undefined && !hasExactBin(manifest.bin, expectedBin)) {
        findings.push({ path: repositoryPath, rule: "bin-contract", value: JSON.stringify(manifest.bin ?? null) });
      }
    }
    if (isMachineSurface(repositoryPath) && source.includes(oldScope)) {
      findings.push({ path: repositoryPath, rule: "old-scope", value: oldScope });
    }
  }
  for (const [repositoryPath, expectedName] of expectedManifestNames) {
    if (!sources.has(repositoryPath)) findings.push({ path: repositoryPath, rule: "package-graph", value: `missing:${expectedName}` });
  }
  if (!sources.has("apps/daemon/bin/readable.mjs")) {
    findings.push({ path: "apps/daemon/bin/readable.mjs", rule: "bin-contract", value: "missing" });
  }
  const oldBinPath = `apps/daemon/bin/${oldBinName}.mjs`;
  if (sources.has(oldBinPath)) {
    findings.push({ path: oldBinPath, rule: "old-bin", value: `${oldBinName}.mjs` });
  }
  return findings;
}

async function trackedSources(root: string): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const repositoryPaths = stdout.toString("utf8").split("\0").filter(Boolean);
  const sources = new Map<string, string>();
  await Promise.all(repositoryPaths.map(async (repositoryPath) => {
    const contents = await readFile(path.join(root, repositoryPath));
    if (!contents.includes(0)) sources.set(repositoryPath.replaceAll("\\", "/"), contents.toString("utf8"));
  }));
  return sources;
}

export async function scanWorkspaceIdentity(root = path.resolve(import.meta.dirname, "..")): Promise<WorkspaceIdentityFinding[]> {
  return scanWorkspaceIdentitySources(await trackedSources(root));
}

export async function checkReadableWorkspaceIdentity(): Promise<boolean> {
  const findings = await scanWorkspaceIdentity();
  if (findings.length === 0) {
    console.log("Readable workspace identity passed: 0 findings.");
    return true;
  }
  console.error(JSON.stringify({ findings, schemaVersion: 1 }, null, 2));
  return false;
}
