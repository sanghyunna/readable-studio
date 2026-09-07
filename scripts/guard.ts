import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkCrossAppImports } from "./check-cross-app-imports.ts";
import { checkReadableWorkspaceIdentity } from "./readable-workspace-identity.ts";
import { checkBundledCopyLanguage } from "./check-bundled-copy-language.ts";
import { checkDesignSystemManifests } from "./check-design-system-manifests.ts";
import { checkDesignSystemPackageQuality } from "./check-design-system-package-quality.ts";
import { checkDesignSystemComponentFixtureReport } from "./check-components-fixtures.ts";
import { checkDesignSystemFlagParity } from "./check-design-system-flag-parity.ts";
import { checkComponentsManifestExtraction } from "./check-components-manifest-extraction.ts";
import { checkNoCheckboxUi } from "./check-no-checkbox-ui.ts";
import {
  checkDesignSystemA1RequiredTokens,
  checkDesignSystemA2DefaultsParity,
  checkDesignSystemA2RequiredTokens,
  checkDesignSystemBSlotRequiredTokens,
  checkDesignSystemTokenFixtureSync,
  checkDesignSystemUnknownTokens,
} from "./check-tokens-fixture-sync.ts";
import {
  collectCssEncodedHexColorMatches,
  collectCssEmptyVarFunctionMatches,
  collectCssHardcodedColorMatches,
  cssWideAndSpecialColorKeywords,
  realNamedColors,
} from "./style-policy.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const allowedE2eScripts = new Set([
  "e2e/scripts/playwright.ts",
  "e2e/scripts/release-smoke.ts",
  "e2e/scripts/portable-qa.ts",
  "e2e/scripts/portable-qa-fail-closed.ts",
  "e2e/scripts/portable-qa-runtime.ts",
  "e2e/scripts/portable-qa-support.ts",
  "e2e/scripts/portable-qa-workflows.ts",
]);

type GuardCheck = {
  name: string;
  run: () => Promise<boolean>;
};

function toRepositoryPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

const residualExtensions = new Set([".js", ".mjs", ".cjs"]);

const residualSkippedDirectories = new Set([
  ".agents",
  ".astro",
  ".claude",
  ".claude-sessions",
  ".codex",
  ".cursor",
  ".git",
  ".readable-studio",
  ".readable-studio-e2e",
  ".opencode",
  ".task",
  ".tmp",
  ".vite",
  "dist",
  "node_modules",
  "out",
]);

const residualAllowedExactPaths = new Set([
  // esbuild config entrypoints are executed directly by Node before package
  // dist output exists.
  "packages/agui-adapter/esbuild.config.mjs",
  "packages/contracts/esbuild.config.mjs",
  "packages/diagnostics/esbuild.config.mjs",
  "packages/download/esbuild.config.mjs",
  "packages/host/esbuild.config.mjs",
  "packages/metatool/esbuild.config.mjs",
  "packages/platform/esbuild.config.mjs",
  "packages/plugin-runtime/esbuild.config.mjs",
  "packages/registry-protocol/esbuild.config.mjs",
  "packages/sidecar/esbuild.config.mjs",
  "packages/sidecar-proto/esbuild.config.mjs",
  // Maintainer utility scripts executed directly by Node and not loaded by the
  // app runtime.
  "scripts/postinstall.mjs",
  // Checked-in bin shim so pnpm can link `readable` before daemon dist output exists.
  "apps/daemon/bin/readable.mjs",
  "apps/packaged/esbuild.config.mjs",
  // Browser service workers must be served as JavaScript files.
  "apps/web/public/readable-studio-notifications-sw.js",
  // PostCSS loads Tailwind through a web-local .mjs compatibility config entry.
  "apps/web/postcss.config.mjs",
  // Offline plugin-preview renderer. Kept .mjs and run directly by Node so its
  // runtime deps (puppeteer-core + a headless Chrome + ffmpeg) are provided by
  // the invoking environment and never pulled into the daemon/web TS build or bundle.
  "scripts/bake-plugin-previews.mjs",
  // AMR (vela) verifier: ad-hoc dev runner that imports the daemon's compiled
  // `dist/acp.js` and drives a real `vela agent run` against a live model.
  // Kept as .mjs so it can be invoked directly via Node without any transform.
  "apps/daemon/scripts/verify-amr-real-vela.mjs",
  // Fake `vela agent run --runtime opencode` ACP stdio stub used by the AMR
  // integration tests. The Vitest test spawns it via `child_process.spawn`,
  // which needs a directly-executable file (shebang + .mjs).
  "apps/daemon/tests/fixtures/fake-vela.mjs",
  "tools/dev/bin/tools-dev.mjs",
  "tools/dev/esbuild.config.mjs",
  "tools/pack/bin/tools-pack.mjs",
  "tools/pack/esbuild.config.mjs",
  // electron-builder hook path; CJS compatibility entry used by tools-pack desktop builds.
  "tools/pack/resources/web-standalone-after-pack.cjs",
]);

const residualAllowedPathPrefixes = [
  "apps/daemon/dist/",
  "apps/web/.next/",
  "apps/web/out/",
  "generated/",
  "e2e/playwright-report/",
  "e2e/reports/html/",
  "e2e/reports/playwright-html-report/",
  "e2e/reports/test-results/",
  "e2e/ui/.readable-studio-data/",
  "e2e/ui/reports/playwright-html-report/",
  "e2e/ui/reports/test-results/",
  "e2e/ui/test-results/",
  // Vendored upstream Last30Days runtime helper used by the engine (design template).
  "design-templates/last30days/scripts/lib/vendor/",
  // Vendored upstream html-ppt runtime assets (lewislulu/html-ppt-skill, design template).
  "design-templates/html-ppt/assets/",
  // Replay-based mock CLIs that impersonate the agent CLIs Readable Studio spawns
  // (opencode/claude/codex/gemini/cursor-agent + ACP family). Need to
  // be directly executable via Node so `child_process.spawn` from test
  // harnesses and PATH-overlay shells work without any transform step.
  // `mocks/scripts/` holds the maintainer-facing helpers (manifest math,
  // fetch from R2) which are also pure-node single-file modules — same
  // precedent as `apps/daemon/tests/fixtures/fake-vela.mjs` (an ACP
  // stdio stub, allowlisted individually above). See `mocks/README.md`.
  "mocks/lib/",
  "mocks/mock-agent.mjs",
  "mocks/scripts/",
  "test-results/",
  "vendor/",
];

const residualAllowedPathPatterns: RegExp[] = [
  // Vendored upstream Zara template runtimes — one design template per template,
  // name prefix `html-ppt-zhangzara-` (zarazhangrui/beautiful-html-templates).
  // Only the vendored deck-stage runtime asset is allowlisted; any other
  // JavaScript under these design-template directories must still be converted
  // to TypeScript or explicitly listed in `residualAllowedExactPaths`.
  /^design-templates\/html-ppt-zhangzara-[^/]+\/assets\/deck-stage\.js$/,
  // Bundled example/skill plugins copy the upstream skill's `assets/`
  // and `references/` directories verbatim so the daemon's preview
  // surface can render the baked HTML without staging detours. Those
  // assets are vendored runtime, never project-owned code, and must
  // not be retypecasted to TypeScript.
  /^plugins\/_official\/examples\/[^/]+\/(assets|references)\/.+$/,
];

function isResidualAllowedPath(repositoryPath: string): boolean {
  if (residualAllowedExactPaths.has(repositoryPath)) return true;
  if (residualAllowedPathPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) return true;
  return residualAllowedPathPatterns.some((pattern) => pattern.test(repositoryPath));
}

function isResidualSkippedDirectoryName(directoryName: string): boolean {
  return (
    residualSkippedDirectories.has(directoryName) || directoryName === ".next" || directoryName.startsWith(".next-")
  );
}

async function collectResidualJavaScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const residualFiles: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const repositoryPath = toRepositoryPath(fullPath);

    if (entry.isDirectory()) {
      if (isResidualSkippedDirectoryName(entry.name) || isResidualAllowedPath(`${repositoryPath}/`)) {
        continue;
      }

      residualFiles.push(...(await collectResidualJavaScript(fullPath)));
      continue;
    }

    if (!entry.isFile() || !residualExtensions.has(path.extname(entry.name))) {
      continue;
    }

    if (isResidualAllowedPath(repositoryPath)) {
      continue;
    }

    residualFiles.push(repositoryPath);
  }

  return residualFiles;
}

async function checkResidualJavaScript(): Promise<boolean> {
  const residualFiles = await collectResidualJavaScript(repoRoot);

  if (residualFiles.length > 0) {
    console.error("Residual project-owned JavaScript files found:");
    for (const filePath of residualFiles) {
      console.error(`- ${filePath}`);
    }
    console.error("Convert these files to TypeScript or add a documented generated/vendor/output allowlist entry.");
    return false;
  }

  console.log("Residual JavaScript check passed: project-owned code is TypeScript-only.");
  return true;
}

const sourcePackageManifestRootPaths = ["package.json", "e2e/package.json"];
const sourcePackageManifestScopedDirectories = ["apps", "packages", "tools"];
const packageDependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const packageManagerOverridePaths = ["pnpm.overrides", "overrides", "resolutions"];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const exactNpmAliasPattern = /^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type DependencySpecViolation = {
  filePath: string;
  fieldPath: string;
  name: string;
  spec: unknown;
  reason: string;
};

type DependencySpecStats = {
  exact: number;
  manifests: number;
  total: number;
  workspace: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedDependencySpec(spec: string): boolean {
  return spec === "workspace:*" || exactVersionPattern.test(spec) || exactNpmAliasPattern.test(spec);
}

function dependencySpecReason(spec: string): string {
  if (spec.startsWith("workspace:") && spec !== "workspace:*") {
    return "workspace dependencies must use exactly workspace:*";
  }

  return "dependency specs must be exact versions like 1.2.3 or workspace:*";
}

function dependencySpecFieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function collectScopedPackageManifestPaths(scopeDirectory: string): Promise<string[]> {
  const scopeRoot = path.join(repoRoot, scopeDirectory);
  const entries = await readdir(scopeRoot, { withFileTypes: true });
  const manifestPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const packageDirectory = path.join(scopeRoot, entry.name);
    const packageEntries = await readdir(packageDirectory, { withFileTypes: true });
    if (packageEntries.some((packageEntry) => packageEntry.isFile() && packageEntry.name === "package.json")) {
      manifestPaths.push(`${scopeDirectory}/${entry.name}/package.json`);
    }
  }

  return manifestPaths;
}

async function collectSourcePackageManifestPaths(): Promise<string[]> {
  const scopedManifestPaths = (
    await Promise.all(sourcePackageManifestScopedDirectories.map((scope) => collectScopedPackageManifestPaths(scope)))
  ).flat();

  return [...sourcePackageManifestRootPaths, ...scopedManifestPaths].sort();
}

function getPackageJsonField(packageJson: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = packageJson;
  for (const part of fieldPath.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function checkDependencySpecRecord(
  record: Record<string, unknown>,
  filePath: string,
  fieldPath: string,
  violations: DependencySpecViolation[],
  stats: DependencySpecStats,
): void {
  for (const [name, spec] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    if (isRecord(spec)) {
      checkDependencySpecRecord(spec, filePath, `${fieldPath}.${name}`, violations, stats);
      continue;
    }

    stats.total += 1;
    if (typeof spec !== "string") {
      violations.push({
        filePath,
        fieldPath,
        name,
        spec,
        reason: "dependency specs must be strings",
      });
      continue;
    }

    if (spec === "workspace:*") {
      stats.workspace += 1;
      continue;
    }

    if (isAllowedDependencySpec(spec)) {
      stats.exact += 1;
      continue;
    }

    violations.push({
      filePath,
      fieldPath,
      name,
      spec,
      reason: dependencySpecReason(spec),
    });
  }
}

async function checkPackageDependencySpecs(): Promise<boolean> {
  const manifestPaths = await collectSourcePackageManifestPaths();
  const violations: DependencySpecViolation[] = [];
  const stats: DependencySpecStats = {
    exact: 0,
    manifests: manifestPaths.length,
    total: 0,
    workspace: 0,
  };

  for (const manifestPath of manifestPaths) {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8")) as Record<string, unknown>;

    for (const section of packageDependencySections) {
      const value = packageJson[section];
      if (value === undefined) continue;
      if (!isRecord(value)) {
        violations.push({
          filePath: manifestPath,
          fieldPath: section,
          name: section,
          spec: value,
          reason: "dependency sections must be objects",
        });
        continue;
      }

      checkDependencySpecRecord(value, manifestPath, section, violations, stats);
    }

    for (const overridePath of packageManagerOverridePaths) {
      const value = getPackageJsonField(packageJson, overridePath);
      if (value === undefined) continue;
      if (!isRecord(value)) {
        violations.push({
          filePath: manifestPath,
          fieldPath: overridePath,
          name: overridePath,
          spec: value,
          reason: "package-manager override sections must be objects",
        });
        continue;
      }

      checkDependencySpecRecord(value, manifestPath, overridePath, violations, stats);
    }
  }

  if (violations.length > 0) {
    console.error("Package dependency spec violations found:");
    for (const violation of violations) {
      console.error(
        `- ${violation.filePath} ${violation.fieldPath}.${violation.name}=${dependencySpecFieldValue(violation.spec)} -> ${violation.reason}`,
      );
    }
    return false;
  }

  console.log(
    `Package dependency spec check passed: ${stats.manifests} package.json files, ${stats.exact} exact specs, ${stats.workspace} workspace:* specs.`,
  );
  return true;
}

const testLayoutScopedDirectories = ["apps", "packages", "tools"];
const testLayoutSkippedDirectories = new Set([".next", ".readable-studio-data", "dist", "node_modules", "out", "reports", "test-results"]);

function isTestFile(fileName: string): boolean {
  return /\.test\.tsx?$/.test(fileName);
}

function expectedTestPath(repositoryPath: string): string {
  const [scope, project, ...relativeParts] = repositoryPath.split("/");
  if (!testLayoutScopedDirectories.includes(scope ?? "") || project == null || relativeParts.length === 0) {
    return repositoryPath;
  }

  const normalizedRelativeParts = relativeParts[0] === "src" ? relativeParts.slice(1) : relativeParts;
  return [scope, project, "tests", ...normalizedRelativeParts].join("/");
}

function isAllowedScopedTestPath(repositoryPath: string): boolean {
  const [scope, project, directory] = repositoryPath.split("/");
  return testLayoutScopedDirectories.includes(scope ?? "") && project != null && directory === "tests";
}

async function collectTestLayoutViolations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const violations: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (testLayoutSkippedDirectories.has(entry.name)) {
        continue;
      }

      violations.push(...(await collectTestLayoutViolations(fullPath)));
      continue;
    }

    if (!entry.isFile() || !isTestFile(entry.name)) {
      continue;
    }

    const repositoryPath = toRepositoryPath(fullPath);
    if (!isAllowedScopedTestPath(repositoryPath)) {
      violations.push(repositoryPath);
    }
  }

  return violations;
}

async function checkTestLayout(): Promise<boolean> {
  const violations = (
    await Promise.all(
      testLayoutScopedDirectories.map((directory) => collectTestLayoutViolations(path.join(repoRoot, directory))),
    )
  ).flat();

  if (violations.length > 0) {
    console.error("Test files under apps/, packages/, and tools/ must live in tests/ sibling to src/:");
    for (const violation of violations) {
      console.error(`- ${violation} -> ${expectedTestPath(violation)}`);
    }
    return false;
  }

  console.log("Test layout check passed: apps/packages/tools tests live in sibling tests directories.");
  return true;
}

const e2ePackageJsonPath = path.join(repoRoot, "e2e", "package.json");
const e2eSkippedDirectories = new Set([".readable-studio-data", "node_modules", "reports", "test-results"]);
const e2eAllowedScripts = [
  "test",
  "test:p0",
  "test:p0p1",
  "test:p1",
  "test:p2",
  "test:ui",
  "test:ui:critical",
  "test:ui:extended",
  "test:ui:p0",
  "test:ui:p0p1",
  "test:ui:p1",
  "test:ui:p2",
  "typecheck",
];

async function collectRepositoryFiles(directory: string, skippedDirectoryNames = new Set<string>()): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) continue;
      files.push(...(await collectRepositoryFiles(fullPath, skippedDirectoryNames)));
      continue;
    }
    if (entry.isFile()) files.push(toRepositoryPath(fullPath));
  }

  return files;
}

const productNeutralitySkippedDirectories = new Set([
  ".git",
  ".readable-studio",
  ".tmp",
  "dist",
  "node_modules",
  "out",
  "test-results",
]);
// Public contracts, help/prompt strings, docs, and shipped content should
// describe the integration role, not name a private deployment. The default
// check blocks named "orchestrator such as ..." examples; private forks can
// add stricter local terms through READABLE_PRODUCT_NEUTRALITY_FORBIDDEN_TERMS.
const productNeutralityCheckedPathPrefixes = [
  "apps/daemon/src/",
  "apps/web/app/",
  "apps/web/src/",
  "craft/",
  "design-systems/",
  "design-templates/",
  "docs/",
  "packages/contracts/src/",
  "skills/",
];
const productNeutralityTextExtensions = new Set([".md", ".mdx", ".ts", ".tsx"]);
const productNeutralityDocFilePattern =
  /(?:^|\/)(?:AGENTS|CLAUDE|CONTRIBUTING(?:\.[^.]+)?|QUICKSTART|README(?:\.[^.]+)?)\.md$/;
const namedOrchestratorExamplePattern =
  /\borchestrator\s+(?:such as|like|for example,?)\s+[`"']?[A-Z][A-Za-z0-9_-]+/gi;

type ProductNeutralityViolation = {
  filePath: string;
  lineNumber: number;
  reason: string;
};

type DaemonWindowsFootgunViolation = {
  filePath: string;
  lineNumber: number;
  match: string;
  reason: string;
};

const daemonWindowsFootgunCheckedPathPrefixes = ["apps/daemon/src/", "apps/daemon/tests/"];
const daemonWindowsFootgunTextExtensions = new Set([".ts"]);
const daemonWindowsFootgunTestFilePattern = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.ts$/;
const daemonWindowsFilesystemApis = [
  "mkdtemp",
  "path\\.join",
  "path\\.resolve",
  "writeFile",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "readFile",
  "readFileSync",
  "existsSync",
  "readdir",
  "lstat",
  "stat",
  "symlink",
  "symlinkSync",
  "realpath",
  "realpathSync",
  "copyFile",
  "rename",
  "open",
] as const;

const daemonWindowsFilesystemCallPattern = new RegExp(
  String.raw`\b(?:${daemonWindowsFilesystemApis.join("|")})\s*\([^\n)]*(?:/var/tmp/|/tmp/)[^\n)]*\)`,
  "g",
);
const daemonWindowsFilesystemFixtureAllowlistPattern = /^\s*cwd:\s*path\.(?:resolve|join)\(\s*['"`](?:\/var\/tmp\/|\/tmp\/)/;

export function isProductNeutralityCheckedPath(repositoryPath: string): boolean {
  return (
    productNeutralityCheckedPathPrefixes.some((prefix) => repositoryPath.startsWith(prefix)) ||
    productNeutralityDocFilePattern.test(repositoryPath)
  );
}

function isProductNeutralityTextFile(repositoryPath: string): boolean {
  return productNeutralityTextExtensions.has(path.extname(repositoryPath));
}

function productNeutralityForbiddenTerms(): string[] {
  return String(process.env.READABLE_PRODUCT_NEUTRALITY_FORBIDDEN_TERMS ?? "")
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function isDaemonWindowsFootgunTestPath(repositoryPath: string): boolean {
  return (
    repositoryPath.startsWith("apps/daemon/tests/") &&
    daemonWindowsFootgunTextExtensions.has(path.extname(repositoryPath)) &&
    daemonWindowsFootgunTestFilePattern.test(repositoryPath)
  );
}

function isDaemonWindowsFootgunSourcePath(repositoryPath: string): boolean {
  return daemonWindowsFootgunTextExtensions.has(path.extname(repositoryPath)) && repositoryPath.startsWith("apps/daemon/src/");
}

function collectDaemonWindowsFilesystemViolations(repositoryPath: string, source: string): DaemonWindowsFootgunViolation[] {
  const violations: DaemonWindowsFootgunViolation[] = [];

  if (!isDaemonWindowsFootgunTestPath(repositoryPath)) {
    return violations;
  }

  const sourceLines = source.split(/\r?\n/);

  for (const [lineIndex, line] of sourceLines.entries()) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
      continue;
    }

    if (daemonWindowsFilesystemFixtureAllowlistPattern.test(trimmedLine)) {
      continue;
    }

    for (const match of line.matchAll(daemonWindowsFilesystemCallPattern)) {
      violations.push({
        filePath: repositoryPath,
        lineNumber: lineIndex + 1,
        match: match[0],
        reason: "literal /tmp and /var/tmp paths must not be used in daemon filesystem calls on Windows",
      });
    }
  }

  return violations;
}

function collectDaemonWindowsAwaitExitViolations(repositoryPath: string, source: string): DaemonWindowsFootgunViolation[] {
  const violations: DaemonWindowsFootgunViolation[] = [];

  if (!isDaemonWindowsFootgunSourcePath(repositoryPath)) {
    return violations;
  }

  const sourceLines = source.split(/\r?\n/);
  let pendingAwaitLineNumber: number | null = null;
  let inBlockComment = false;

  for (const [lineIndex, line] of sourceLines.entries()) {
    const trimmedLine = line.trim();

    if (inBlockComment) {
      if (trimmedLine.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    if (trimmedLine.length === 0 || trimmedLine.startsWith("//")) {
      continue;
    }

    if (trimmedLine.startsWith("/*")) {
      inBlockComment = !trimmedLine.includes("*/");
      continue;
    }

    if (pendingAwaitLineNumber !== null) {
      if (trimmedLine.includes("process.exit(0)")) {
        violations.push({
          filePath: repositoryPath,
          lineNumber: lineIndex + 1,
          match: "process.exit(0)",
          reason: "process.exit(0) must not run immediately after await in daemon source on Windows",
        });
      }

      pendingAwaitLineNumber = null;
      continue;
    }

    if (trimmedLine.includes("await") && trimmedLine.includes(";")) {
      pendingAwaitLineNumber = lineIndex + 1;
    }
  }

  return violations;
}

export function collectDaemonWindowsFootgunViolations(repositoryPath: string, source: string): DaemonWindowsFootgunViolation[] {
  if (!daemonWindowsFootgunTextExtensions.has(path.extname(repositoryPath))) {
    return [];
  }

  return [
    ...collectDaemonWindowsFilesystemViolations(repositoryPath, source),
    ...collectDaemonWindowsAwaitExitViolations(repositoryPath, source),
  ];
}

export function collectProductNeutralityViolationsFromSource(
  repositoryPath: string,
  source: string,
  forbiddenTerms = productNeutralityForbiddenTerms(),
): ProductNeutralityViolation[] {
  if (!isProductNeutralityCheckedPath(repositoryPath) || !isProductNeutralityTextFile(repositoryPath)) {
    return [];
  }

  const lowerSource = source.toLowerCase();
  const violations: ProductNeutralityViolation[] = [];

  for (const match of source.matchAll(namedOrchestratorExamplePattern)) {
    violations.push({
      filePath: repositoryPath,
      lineNumber: lineNumberForIndex(source, match.index ?? 0),
      reason: "use generic \"external orchestrator\" phrasing instead of named orchestrator examples",
    });
  }

  for (const term of forbiddenTerms) {
    const lowerTerm = term.toLowerCase();
    let index = lowerSource.indexOf(lowerTerm);

    while (index !== -1) {
      violations.push({
        filePath: repositoryPath,
        lineNumber: lineNumberForIndex(source, index),
        reason: "use generic \"external orchestrator\" phrasing instead of private deployment names",
      });
      index = lowerSource.indexOf(lowerTerm, index + lowerTerm.length);
    }
  }

  return violations;
}

async function checkProductNeutrality(): Promise<boolean> {
  const violations: ProductNeutralityViolation[] = [];

  for (const repositoryPath of await collectRepositoryFiles(repoRoot, productNeutralitySkippedDirectories)) {
    if (!isProductNeutralityCheckedPath(repositoryPath) || !isProductNeutralityTextFile(repositoryPath)) {
      continue;
    }
    const source = await readFile(path.join(repoRoot, repositoryPath), "utf8");
    violations.push(...collectProductNeutralityViolationsFromSource(repositoryPath, source));
  }

  if (violations.length > 0) {
    console.error("Product-neutrality violations found:");
    for (const violation of violations) {
      console.error(`${violation.filePath}:${violation.lineNumber} -> ${violation.reason}`);
    }
    return false;
  }

  console.log("Product-neutrality check passed: public docs, contracts, and prompts use generic orchestrator naming.");
  return true;
}

async function checkDaemonWindowsFootguns(): Promise<boolean> {
  const violations: DaemonWindowsFootgunViolation[] = [];

  for (const repositoryPath of await collectRepositoryFiles(path.join(repoRoot, "apps/daemon"), residualSkippedDirectories)) {
    if (!daemonWindowsFootgunCheckedPathPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
      continue;
    }

    const source = await readFile(path.join(repoRoot, repositoryPath), "utf8");
    violations.push(...collectDaemonWindowsFootgunViolations(repositoryPath, source));
  }

  if (violations.length > 0) {
    console.error("Daemon Windows footgun violations found:");
    for (const violation of violations) {
      console.error(`${violation.filePath}:${violation.lineNumber} \`${violation.match}\` -> ${violation.reason}`);
    }
    console.error("Use platform-neutral temp paths in daemon tests and avoid exiting immediately after await in daemon source.");
    return false;
  }

  console.log("Daemon Windows footgun check passed: daemon tests and source avoid literal /tmp filesystem calls and immediate post-await exits.");
  return true;
}

async function checkE2eLayout(): Promise<boolean> {
  const violations: string[] = [];
  const packageJson = JSON.parse(await readFile(e2ePackageJsonPath, "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  const scriptNames = Object.keys(packageJson.scripts ?? {}).sort();
  if (scriptNames.join("\0") !== e2eAllowedScripts.join("\0")) {
    violations.push(
      `e2e/package.json scripts must be exactly ${e2eAllowedScripts.join(", ")} (found: ${scriptNames.join(", ")})`,
    );
  }

  const e2eRoot = path.join(repoRoot, "e2e");
  for (const repositoryPath of await collectRepositoryFiles(e2eRoot, e2eSkippedDirectories)) {
    if (
      repositoryPath === "e2e/package.json" ||
      repositoryPath === "e2e/tsconfig.json" ||
      repositoryPath === "e2e/vitest.config.ts" ||
      repositoryPath === "e2e/playwright.config.ts" ||
      repositoryPath === "e2e/playwright.visual.config.ts" ||
      repositoryPath === "e2e/AGENTS.md"
    ) {
      continue;
    }

    if (repositoryPath.startsWith("e2e/specs/")) {
      if (!/\.spec\.ts$/.test(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e specs must be *.spec.ts`);
      }
      continue;
    }

    if (repositoryPath.startsWith("e2e/tests/")) {
      if (!/\.test\.ts$/.test(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e tests must be *.test.ts`);
      }
      continue;
    }

    if (repositoryPath.startsWith("e2e/ui/")) {
      const relativePath = repositoryPath.slice("e2e/ui/".length);
      if (relativePath.includes("/") || !/\.test\.ts$/.test(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e UI files must be flat Playwright *.test.ts files under ui/`);
      }
      continue;
    }

    if (repositoryPath.startsWith("e2e/resources/")) {
      const relativePath = repositoryPath.slice("e2e/resources/".length);
      if (relativePath.includes("/") || !/\.ts$/.test(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e resources must be flat TypeScript files under resources/`);
      }
      continue;
    }

    if (repositoryPath.startsWith("e2e/lib/")) {
      if (!/\.ts$/.test(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e lib files must be TypeScript`);
      }
      continue;
    }

    if (repositoryPath.startsWith("e2e/scripts/")) {
      if (!allowedE2eScripts.has(repositoryPath)) {
        violations.push(`${repositoryPath} -> e2e scripts must be an approved package-owned entrypoint`);
      }
      continue;
    }

    violations.push(`${repositoryPath} -> e2e source files must live in specs/, tests/, ui/, resources/, lib/, or approved scripts`);
  }

  if (violations.length > 0) {
    console.error("E2E package layout violations found:");
    for (const violation of violations) console.error(`- ${violation}`);
    return false;
  }

  console.log("E2E layout check passed: Vitest, Playwright UI, resources, lib, and scripts stay in their lanes.");
  return true;
}

const webTestSkippedDirectories = new Set([".readable-studio-data", "reports", "test-results"]);

async function checkWebTestLayout(): Promise<boolean> {
  const violations: string[] = [];
  const webTestsRoot = path.join(repoRoot, "apps", "web", "tests");

  for (const repositoryPath of await collectRepositoryFiles(webTestsRoot, webTestSkippedDirectories)) {
    if (repositoryPath.startsWith("apps/web/tests/vitest/") || repositoryPath.startsWith("apps/web/tests/playwright/")) {
      violations.push(`${repositoryPath} -> web tests should stay lightweight under apps/web/tests/ without vitest/playwright nesting`);
      continue;
    }

    if (/\.(spec|test)\.tsx?$/.test(repositoryPath) && !/\.test\.tsx?$/.test(repositoryPath)) {
      violations.push(`${repositoryPath} -> web Vitest test files must be *.test.ts or *.test.tsx`);
    }
  }

  if (violations.length > 0) {
    console.error("Web test layout violations found:");
    for (const violation of violations) console.error(`- ${violation}`);
    return false;
  }

  console.log("Web test layout check passed: web tests stay lightweight and Vitest-only.");
  return true;
}

const toolsRootAllowlist = new Map<string, "directory" | "file">([
  // Keep top-level tools intentionally small. `tools/launcher` was an incoming
  // Windows shim experiment from PR #683 and is not an active repo boundary.
  ["AGENTS.md", "file"],
  ["dev", "directory"],
  ["pack", "directory"],
]);

async function checkToolsLayout(): Promise<boolean> {
  const toolsRoot = path.join(repoRoot, "tools");
  const entries = await readdir(toolsRoot, { withFileTypes: true });
  const seen = new Set<string>();
  const violations: string[] = [];

  for (const entry of entries) {
    const expected = toolsRootAllowlist.get(entry.name);
    const repositoryPath = `tools/${entry.name}${entry.isDirectory() ? "/" : ""}`;

    if (expected == null) {
      violations.push(`${repositoryPath} -> tools/ top-level entries are allowlisted; expected only AGENTS.md, dev/, and pack/`);
      continue;
    }

    seen.add(entry.name);
    if (expected === "directory" && !entry.isDirectory()) {
      violations.push(`${repositoryPath} -> expected tools/${entry.name}/ to be a directory`);
    }
    if (expected === "file" && !entry.isFile()) {
      violations.push(`${repositoryPath} -> expected tools/${entry.name} to be a file`);
    }
  }

  for (const [entryName, expected] of toolsRootAllowlist) {
    if (!seen.has(entryName)) {
      violations.push(`tools/${entryName}${expected === "directory" ? "/" : ""} -> required tools boundary is missing`);
    }
  }

  if (violations.length > 0) {
    console.error("Tools layout violations found:");
    for (const violation of violations) console.error(`- ${violation}`);
    return false;
  }

  console.log("Tools layout check passed: tools/ top-level entries match the active boundary allowlist.");
  return true;
}

const stylePolicySkippedDirectories = new Set([
  ".next",
  ".readable-studio-data",
  "dist",
  "node_modules",
  "out",
  "reports",
  "test-results",
]);

const stylePolicySourcePrefixes = ["apps/web/app/", "apps/web/src/", "packages/components/src/"];
const stylePolicyHardcodedColorEnforcedPrefixes = ["scripts/guard-style-policy-fixtures/"];
const designSystemMetadataPathPattern = /^design-systems\/[^/]+\/(?:manifest\.json|USAGE\.md|design-tokens\.json|source\/(?:evidence\.md|tokens\.source\.json|token-contract\.report\.json)|preview\/typography\.html)$/u;
const staleDesignSystemIdentityPattern = /@open[-]design|Open[ ]Design|open[-]design|readable[-]design-(?:system-project|tokens)/gu;
const stylePolicyHardcodedColorEnforcedExactPaths = new Set([
  "apps/web/src/components/AgentIcon.tsx",
  "apps/web/src/components/FileViewer.tsx",
  "apps/web/src/components/ManualEditPanel.tsx",
  "apps/web/src/components/MemoryModelInline.tsx",
  "apps/web/src/components/MemorySection.tsx",
  "apps/web/src/components/MemoryToast.tsx",
  "apps/web/src/components/NewProjectPanel.tsx",
  "apps/web/src/components/PaletteTweaks.tsx",
  "apps/web/src/components/pet/PetSettings.tsx",
  "apps/web/src/components/SettingsDialog.tsx",
  "apps/web/src/components/SketchEditor.tsx",
  "apps/web/src/components/SketchPreview.tsx",
  "apps/web/src/components/sketch-colors.ts",
  "apps/web/src/components/workspace/TerminalViewer.tsx",
  "apps/web/src/state/appearance.ts",
  "apps/web/src/state/themes.ts",
]);
const stylePolicyCheckedDirectoryPrefixes = [
  ...new Set([...stylePolicySourcePrefixes, ...stylePolicyHardcodedColorEnforcedPrefixes, "design-systems/"]),
];
const stylePolicyExtensions = new Set([".css", ".html", ".json", ".md", ".ts", ".tsx"]);
const tailwindDefaultColorNames = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "white",
  "black",
].join("|");
const tailwindDefaultPaletteClassPrefixes = [
  "bg",
  "text",
  "border(?:-(?:x|y|s|e|t|r|b|l))?",
  "divide",
  "placeholder",
  "marker",
  "from",
  "via",
  "to",
  "ring(?:-offset)?",
  "outline",
  "decoration",
  "(?:inset-|text-|drop-)?shadow",
  "accent",
  "caret",
  "fill",
  "stroke",
].join("|");
const defaultTailwindPaletteClassPattern = new RegExp(
  `\\b(?:${tailwindDefaultPaletteClassPrefixes})-(?:${tailwindDefaultColorNames})(?:-\\d{2,3})?\\b`,
  "g",
);

const hardcodedColorPattern = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|(?<quote>['"])\\s*(?<named>${realNamedColors.join("|")}|transparent|currentColor|currentcolor|inherit|initial|unset|revert)\\s*\\k<quote>`,
  "g",
);

type StylePolicyAllowlistEntry = {
  pathPattern: RegExp;
  valuePattern: RegExp;
  reason: string;
};

const hardcodedColorAllowlist: StylePolicyAllowlistEntry[] = [
  {
    pathPattern: /^apps\/web\/src\/index\.css$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))$/,
    reason: "global token definitions, shadows, overlays, and retained migration inventory live in the CSS source of truth",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/(?:AgentIcon|PaletteTweaks|PetSettings)\.tsx$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))$/,
    reason: "brand accents, user accent choices, and legacy token fallbacks are classified as Phase 1 migration inventory",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/SettingsDialog\.tsx$/,
    valuePattern: /^#(?:9aa0a6|ff6b6b|f88|11141a|e6e6e6|fbbf24)\b$/i,
    reason: "Settings dialog inline legacy CSS-var fallbacks are retained until that panel is fully tokenized",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/pet\/PetSettings\.tsx$/,
    valuePattern: /^#[0-9a-fA-F]{3,8}\b$/,
    reason: "pet accent swatches are selectable user customization values, not app chrome tokens",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/(?:SketchEditor|SketchPreview|NewProjectPanel)\.tsx$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|['\"](?:none|currentColor|currentcolor|transparent)['\"])$/,
    reason: "sketch/canvas data and SVG illustrations keep narrow hardcoded color exceptions until their migration slice",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/(?:FileViewer|ManualEditPanel)\.tsx$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))$/,
    reason: "user-authored file, inspect, and editable style colors are handled by the file/viewer migration slice",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/(?:MemorySection|MemoryModelInline|MemoryToast)\.tsx$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))$/,
    reason: "memory UI legacy color fallbacks are classified as Phase 1 migration inventory",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/workspace\/TerminalViewer\.tsx$/,
    valuePattern: /^(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))$/,
    reason: "xterm fallback colors mirror CSS terminal tokens for the no-CSS-var fallback path",
  },
  {
    pathPattern: /^apps\/web\/src\/components\/sketch-colors\.ts$/,
    valuePattern: /^#[0-9a-fA-F]{3,8}\b$/,
    reason: "sketch tool defaults are user-authored canvas ink defaults, not app chrome tokens",
  },
  {
    pathPattern: /^apps\/web\/src\/state\/appearance\.ts$/,
    valuePattern: /^#[0-9a-fA-F]{3,8}\b$/,
    reason: "appearance swatches are selectable user accent values and are normalized before use",
  },
  {
    pathPattern: /^apps\/web\/src\/state\/themes\.ts$/,
    valuePattern: /^#[0-9a-fA-F]{3,8}\b$/,
    reason: "theme picker swatches mirror the named theme token files for previews",
  },
  {
    pathPattern: /^apps\/web\/tests\//,
    valuePattern: /.*/,
    reason: "tests and fixtures may assert rejected colors explicitly",
  },
];

type StylePolicyViolation = {
  filePath: string;
  lineNumber: number;
  match: string;
  reason: string;
};

function lineNumberForIndex(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isStylePolicySource(repositoryPath: string): boolean {
  return stylePolicySourcePrefixes.some((prefix) => repositoryPath.startsWith(prefix));
}

function isHardcodedColorEnforcedPath(repositoryPath: string): boolean {
  if (stylePolicyHardcodedColorEnforcedExactPaths.has(repositoryPath)) return true;
  if (stylePolicyHardcodedColorEnforcedPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
    return true;
  }

  if (!repositoryPath.endsWith(".css")) return false;
  if (repositoryPath === "apps/web/src/styles/tokens.css") return false;
  if (repositoryPath.startsWith("apps/web/src/styles/themes/")) return false;

  return repositoryPath.startsWith("apps/web/src/") || repositoryPath.startsWith("packages/components/src/");
}

function isHardcodedColorAllowlisted(repositoryPath: string, match: string): boolean {
  const normalizedMatch = match.trim();
  const unquotedMatch = normalizedMatch.replace(/^['"]|['"]$/g, "");
  if (cssWideAndSpecialColorKeywords.has(unquotedMatch.toLowerCase())) return true;

  return hardcodedColorAllowlist.some(
    (entry) => entry.pathPattern.test(repositoryPath) && entry.valuePattern.test(normalizedMatch),
  );
}

function addStylePolicyViolation(
  violations: StylePolicyViolation[],
  repositoryPath: string,
  source: string,
  index: number,
  match: string,
  reason: string,
): void {
  violations.push({
    filePath: repositoryPath,
    lineNumber: lineNumberForIndex(source, index),
    match,
    reason,
  });
}

function isInsideTsComment(source: string, index: number): boolean {
  const blockStart = source.lastIndexOf("/*", index);
  if (blockStart > source.lastIndexOf("*/", index)) return true;

  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineComment = source.indexOf("//", lineStart);
  return lineComment !== -1 && lineComment < index;
}

function isLikelyTsInlineStyleNamedColor(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - 80), index);
  return /(?:^|[,{]\s*)(?:accentColor|backgroundColor|borderColor|caretColor|color|fill|outlineColor|stroke|textDecorationColor)\s*:\s*$/m.test(
    before,
  );
}

export function collectStylePolicyViolationsFromSource(repositoryPath: string, source: string): StylePolicyViolation[] {
  const violations: StylePolicyViolation[] = [];

  if (designSystemMetadataPathPattern.test(repositoryPath)) {
    for (const match of source.matchAll(staleDesignSystemIdentityPattern)) {
      addStylePolicyViolation(
        violations,
        repositoryPath,
        source,
        match.index ?? 0,
        match[0],
        "design-system product attribution must use Readable Studio metadata",
      );
    }
  }

  if (isStylePolicySource(repositoryPath)) {
    for (const match of source.matchAll(defaultTailwindPaletteClassPattern)) {
      violations.push({
        filePath: repositoryPath,
        lineNumber: lineNumberForIndex(source, match.index ?? 0),
        match: match[0],
        reason: "default Tailwind palette classes must use Readable Studio token utilities instead",
      });
    }
  }

  if (isStylePolicySource(repositoryPath) || isHardcodedColorEnforcedPath(repositoryPath)) {
    if (repositoryPath.endsWith(".css") && isHardcodedColorEnforcedPath(repositoryPath)) {
      for (const match of collectCssEmptyVarFunctionMatches(source)) {
        addStylePolicyViolation(
          violations,
          repositoryPath,
          source,
          match.index,
          match.value,
          "empty CSS var() calls are invalid and usually mean a token replacement lost its variable name",
        );
      }

      for (const match of collectCssEncodedHexColorMatches(source)) {
        addStylePolicyViolation(
          violations,
          repositoryPath,
          source,
          match.index,
          match.value,
          "encoded hardcoded UI colors must use native controls, currentColor, or tokenized CSS instead",
        );
      }

      for (const match of collectCssHardcodedColorMatches(source)) {
        const value = match.value;
        if (value === undefined || isHardcodedColorAllowlisted(repositoryPath, value)) continue;

        addStylePolicyViolation(
          violations,
          repositoryPath,
          source,
          match.index,
          value,
          "unregistered hardcoded UI colors must use Readable Studio tokens or an explicit allowlist entry",
        );
      }
    } else {
      for (const match of source.matchAll(hardcodedColorPattern)) {
        const value = match[0];
        const index = match.index ?? 0;
        if (!repositoryPath.endsWith(".css") && isInsideTsComment(source, index)) continue;
        if (!repositoryPath.endsWith(".css") && /^['"]/.test(value) && !isLikelyTsInlineStyleNamedColor(source, index)) {
          continue;
        }
        if (isHardcodedColorAllowlisted(repositoryPath, value)) continue;
        if (!isHardcodedColorEnforcedPath(repositoryPath)) continue;

        addStylePolicyViolation(
          violations,
          repositoryPath,
          source,
          index,
          value,
          "unregistered hardcoded UI colors must use Readable Studio tokens or an explicit allowlist entry",
        );
      }
    }
  }

  return violations;
}

function cssRuleBody(source: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

function themeRuleBody(source: string, themeId: string): string | undefined {
  return cssRuleBody(source, `[data-theme="${themeId}"]`) ?? cssRuleBody(source, `[data-theme='${themeId}']`);
}

function cssCustomPropertyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*(--[-_a-zA-Z0-9]+)\s*:/gm)) {
    names.add(match[1]!);
  }
  return names;
}

function cssCustomPropertyValue(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`^\\s*${escaped}\\s*:\\s*([^;]+);`, "m"))?.[1]?.trim();
}

function hexColorToRgb(value: string): [number, number, number] | undefined {
  const match = value.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return undefined;
  const hex = match[1]!;
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((value) =>
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number | undefined {
  const first = hexColorToRgb(a);
  const second = hexColorToRgb(b);
  if (!first || !second) return undefined;
  const firstLum = relativeLuminance(first);
  const secondLum = relativeLuminance(second);
  return (Math.max(firstLum, secondLum) + 0.05) / (Math.min(firstLum, secondLum) + 0.05);
}

function validateAccentContrast(repositoryPath: string, body: string, violations: string[]): void {
  const accent = cssCustomPropertyValue(body, "--accent");
  const contrast = cssCustomPropertyValue(body, "--accent-contrast");
  if (!accent || !contrast) {
    violations.push(`${repositoryPath} must define --accent and --accent-contrast`);
    return;
  }
  const ratio = contrastRatio(accent, contrast);
  if (ratio === undefined) {
    violations.push(`${repositoryPath} --accent and --accent-contrast must be literal six-digit hex colors`);
    return;
  }
  if (ratio < 4.5) {
    violations.push(`${repositoryPath} --accent / --accent-contrast ratio ${ratio.toFixed(2)} is below 4.5`);
  }
}

const requiredHubMaterialTokens = new Set([
  "--hub-canvas",
  "--hub-accent",
  "--hub-accent-ink",
  "--hub-accent-fill",
  "--hub-accent-line",
  "--hub-accent-tint",
  "--hub-accent-fg",
  "--hub-pearl-top",
  "--hub-pearl-mid",
  "--hub-pearl-bottom",
  "--hub-pearl-border",
  "--hub-pearl-highlight",
  "--hub-pearl-elevation",
  "--hub-wash",
  "--hub-wash-warm",
  "--hub-wash-cool",
  // Shared ambient wash blooms consumed by both the Hub and the workspace.
  "--hub-wash-bloom-accent",
  "--hub-wash-bloom-warm",
  "--hub-wash-bloom-cool",
  "--hub-canvas-base",
  "--hub-canvas-blue",
  "--hub-canvas-pink",
  "--hub-canvas-cyan",
  "--hub-canvas-green",
  "--hub-canvas-background",
  "--hub-glass-fill",
  "--hub-glass-fill-strong",
  "--hub-glass-blur",
  "--hub-glass-shadow",
  "--hub-glass-shadow-lg",
  "--hub-composer-fill",
  "--hub-composer-body",
  "--hub-composer-top",
  "--hub-composer-bottom",
  "--hub-control-surface",
  "--hub-control-surface-hover",
  "--hub-control-blur",
  "--hub-control-border",
  "--hub-control-highlight",
  "--hub-control-shadow",
  "--hub-control-shadow-hover",
  // Engraved (음각) control tier. The raised pill tier composited to 1.032:1
  // against its own pane when stacked in the inspector; recessing instead buys
  // 1.174:1 light / 1.449:1 dark for card-vs-pane and 1.326:1 / 1.570:1 for
  // selected-vs-unselected segments, with no new chrome.
  "--hub-control-engraved",
  "--hub-control-engraved-hover",
  "--hub-control-engraved-shadow",
  "--hub-control-engraved-shadow-hover",
  "--hub-segment-selected",
  "--hub-send-disabled",
  "--hub-ready-shadow",
  "--hub-ready-highlight",
]);

const semanticThemeSourcePattern = /var\(--(?:bg(?:-app|-panel|-elevated|-fill(?:-secondary|-tertiary)?)?|border(?:-strong|-soft)?|text(?:-strong|-muted|-soft|-faint)?|accent(?:-strong|-soft|-tint|-hover|-contrast)?|blue(?:-bg|-border)?|purple(?:-bg|-border)?|green(?:-bg|-border)?|shadow-(?:color|sm|md|lg))\)/;

const composedHubRecipeSources = new Map<string, readonly string[]>([
  [
    "--hub-canvas-background",
    [
      "--hub-canvas-blue",
      "--hub-canvas-pink",
      "--hub-canvas-cyan",
      "--hub-canvas-green",
      "--hub-canvas-base",
    ],
  ],
  ["--hub-wash-bloom-accent", ["--hub-wash"]],
  ["--hub-wash-bloom-warm", ["--hub-wash-warm"]],
  ["--hub-wash-bloom-cool", ["--hub-wash-cool"]],
]);

type WebThemeRecipeSources = {
  readonly explicitThemeIds: readonly string[];
  readonly indexSource: string;
  readonly recipeSource: string;
  readonly requiredTokens: ReadonlySet<string>;
};

export function collectWebThemeRecipeViolationsFromSource(input: WebThemeRecipeSources): string[] {
  const violations: string[] = [];
  const imports = [...input.indexSource.matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)].map((match) => match[1]);
  if (imports.at(-1) !== "./recipes.css") {
    violations.push("apps/web/src/styles/themes/index.css must import ./recipes.css after all source themes");
  }

  for (const themeId of input.explicitThemeIds) {
    if (!input.recipeSource.includes(`[data-theme='${themeId}']`)) {
      violations.push(`apps/web/src/styles/themes/recipes.css missing [data-theme='${themeId}']`);
    }
  }

  const recipeTokens = cssCustomPropertyNames(input.recipeSource);
  for (const token of input.requiredTokens) {
    if (!recipeTokens.has(token)) {
      violations.push(`apps/web/src/styles/themes/recipes.css missing ${token}`);
    }
  }
  for (const token of recipeTokens) {
    if (token.startsWith("--hub-") && !input.requiredTokens.has(token)) {
      violations.push(`apps/web/src/styles/themes/recipes.css unexpected ${token}`);
    }
  }

  if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(input.recipeSource)) {
    violations.push("apps/web/src/styles/themes/recipes.css must not contain literal colors");
  }

  for (const token of input.requiredTokens) {
    const value = cssCustomPropertyValue(input.recipeSource, token);
    if (value === undefined || value === "transparent" || token === "--hub-glass-blur" || token === "--hub-control-blur") continue;
    const composedSources = composedHubRecipeSources.get(token);
    if (composedSources?.every((source) => value.includes(`var(${source})`))) continue;
    if (!semanticThemeSourcePattern.test(value)) {
      violations.push(`apps/web/src/styles/themes/recipes.css ${token} must reference a semantic source token`);
    }
  }

  for (const scheme of ["light", "dark"]) {
    const systemRulePattern = new RegExp(
      `@media\\s*\\(prefers-color-scheme:\\s*${scheme}\\)[\\s\\S]*?html:not\\(\\[data-theme\\]\\)`,
    );
    if (!systemRulePattern.test(input.recipeSource)) {
      violations.push(`apps/web/src/styles/themes/recipes.css missing system ${scheme} selector`);
    }
  }

  return violations;
}

export function collectWebThemeTokenParityViolationsFromSource(
  repositoryPath: string,
  themeId: string,
  expected: Set<string>,
  source: string,
): string[] {
  const violations: string[] = [];
  const body = themeRuleBody(source, themeId);
  if (body === undefined) {
    violations.push(`${repositoryPath} must define [data-theme="${themeId}"]`);
    return violations;
  }

  const names = cssCustomPropertyNames(body);
  const missing = [...expected].filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !expected.has(name));
  if (missing.length > 0) violations.push(`${repositoryPath} missing ${missing.join(", ")}`);
  if (extra.length > 0) violations.push(`${repositoryPath} extra ${extra.join(", ")}`);
  validateAccentContrast(repositoryPath, body, violations);
  return violations;
}

async function checkWebThemeTokenParity(): Promise<boolean> {
  const tokensPath = path.join(repoRoot, "apps/web/src/styles/tokens.css");
  const themesDir = path.join(repoRoot, "apps/web/src/styles/themes");
  const tokensSource = await readFile(tokensPath, "utf8");
  const rootBody = cssRuleBody(tokensSource, ":root");
  const darkBody = cssRuleBody(tokensSource, '[data-theme="dark"]');
  if (rootBody === undefined) {
    console.error("Web theme token parity failed: tokens.css is missing :root.");
    return false;
  }
  if (darkBody === undefined) {
    console.error("Web theme token parity failed: tokens.css is missing [data-theme=\"dark\"].");
    return false;
  }

  const expected = cssCustomPropertyNames(darkBody);
  const entries = await readdir(themesDir, { withFileTypes: true });
  const namedThemeEntries = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".css") && entry.name !== "index.css" && entry.name !== "recipes.css",
  );
  const violations: string[] = [];
  validateAccentContrast("apps/web/src/styles/tokens.css :root", rootBody, violations);
  validateAccentContrast("apps/web/src/styles/tokens.css [data-theme=\"dark\"]", darkBody, violations);
  for (const entry of namedThemeEntries) {
    const repositoryPath = `apps/web/src/styles/themes/${entry.name}`;
    const themeId = path.basename(entry.name, ".css");
    violations.push(
      ...collectWebThemeTokenParityViolationsFromSource(
        repositoryPath,
        themeId,
        expected,
        await readFile(path.join(themesDir, entry.name), "utf8"),
      ),
    );
  }

  violations.push(
    ...collectWebThemeRecipeViolationsFromSource({
      explicitThemeIds: ["light", "dark", ...namedThemeEntries.map((entry) => path.basename(entry.name, ".css"))],
      indexSource: await readFile(path.join(themesDir, "index.css"), "utf8"),
      recipeSource: await readFile(path.join(themesDir, "recipes.css"), "utf8"),
      requiredTokens: requiredHubMaterialTokens,
    }),
  );

  if (violations.length > 0) {
    console.error("Web theme token parity or recipe violations found:");
    for (const violation of violations) console.error(`- ${violation}`);
    return false;
  }

  console.log(`Web theme token parity and recipes passed: ${namedThemeEntries.length} named themes match the 92-token source contract and ${requiredHubMaterialTokens.size} Hub material tokens derive from semantic sources.`);
  return true;
}

async function collectStylePolicyViolations(directory: string): Promise<StylePolicyViolation[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const violations: StylePolicyViolation[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (stylePolicySkippedDirectories.has(entry.name)) continue;
      violations.push(...(await collectStylePolicyViolations(fullPath)));
      continue;
    }

    if (!entry.isFile() || !stylePolicyExtensions.has(path.extname(entry.name))) continue;

    const repositoryPath = toRepositoryPath(fullPath);
    if (
      !isStylePolicySource(repositoryPath)
      && !isHardcodedColorEnforcedPath(repositoryPath)
      && !designSystemMetadataPathPattern.test(repositoryPath)
    ) continue;

    violations.push(...collectStylePolicyViolationsFromSource(repositoryPath, await readFile(fullPath, "utf8")));
  }

  return violations;
}

async function repositoryDirectoryExists(repositoryPath: string): Promise<boolean> {
  const parentPath = path.join(repoRoot, path.dirname(repositoryPath));
  const directoryName = path.basename(repositoryPath);
  const entries = await readdir(parentPath, { withFileTypes: true });

  return entries.some((entry) => entry.name === directoryName && entry.isDirectory());
}

async function collectStylePolicyViolationsFromCheckedPaths(): Promise<StylePolicyViolation[]> {
  const violations: StylePolicyViolation[] = [];

  for (const repositoryPrefix of stylePolicyCheckedDirectoryPrefixes) {
    const repositoryDirectory = repositoryPrefix.replace(/\/$/, "");
    if (!(await repositoryDirectoryExists(repositoryDirectory))) continue;

    violations.push(...(await collectStylePolicyViolations(path.join(repoRoot, repositoryDirectory))));
  }

  return violations;
}

async function checkStylePolicy(): Promise<boolean> {
  const violations = await collectStylePolicyViolationsFromCheckedPaths();

  if (violations.length > 0) {
    console.error("Style policy violations found:");
    for (const violation of violations) {
      console.error(`- ${violation.filePath}:${violation.lineNumber} \`${violation.match}\` -> ${violation.reason}`);
    }
    console.error("Use Readable Studio token utilities/CSS variables or add a narrow allowlist entry with a reason.");
    return false;
  }

  console.log("Style policy check passed: Tailwind palette classes and enforced hardcoded UI colors stay token-first.");
  return true;
}

const checks: GuardCheck[] = [
  { name: "readable workspace identity", run: checkReadableWorkspaceIdentity },
  { name: "residual JavaScript", run: checkResidualJavaScript },
  { name: "bundled copy language", run: checkBundledCopyLanguage },
  { name: "package dependency specs", run: checkPackageDependencySpecs },
  { name: "product neutrality", run: checkProductNeutrality },
  { name: "daemon Windows footguns", run: checkDaemonWindowsFootguns },
  { name: "cross-app imports", run: checkCrossAppImports },
  { name: "test layout", run: checkTestLayout },
  { name: "e2e layout", run: checkE2eLayout },
  { name: "web test layout", run: checkWebTestLayout },
  { name: "tools layout", run: checkToolsLayout },
  { name: "web theme token parity", run: checkWebThemeTokenParity },
  { name: "style policy", run: checkStylePolicy },
  { name: "no checkbox product UI", run: checkNoCheckboxUi },
  { name: "design system manifests", run: checkDesignSystemManifests },
  { name: "design system package quality", run: checkDesignSystemPackageQuality },
  { name: "design system component fixture report", run: checkDesignSystemComponentFixtureReport },
  { name: "design system token-fixture sync", run: checkDesignSystemTokenFixtureSync },
  { name: "design system A1 required tokens", run: checkDesignSystemA1RequiredTokens },
  { name: "design system A2 required tokens", run: checkDesignSystemA2RequiredTokens },
  { name: "design system B-slot required tokens", run: checkDesignSystemBSlotRequiredTokens },
  { name: "design system unknown token allowlist", run: checkDesignSystemUnknownTokens },
  { name: "design system A2 defaults parity", run: checkDesignSystemA2DefaultsParity },
  { name: "design system flag parity", run: checkDesignSystemFlagParity },
  { name: "design system component manifest extraction", run: checkComponentsManifestExtraction },
];

async function runChecks(): Promise<boolean> {
  const results: boolean[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run());
    } catch (error) {
      console.error(`Guard check failed unexpectedly: ${check.name}`);
      console.error(error);
      results.push(false);
    }
  }

  return results.every(Boolean);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain && !(await runChecks())) {
  process.exitCode = 1;
}
