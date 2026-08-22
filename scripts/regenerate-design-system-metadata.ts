import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DESIGN_SYSTEM_PROJECT_SCHEMA_VERSION } from "../design-systems/_schema/manifest.schema.ts";
import { extractComponentsManifest } from "../packages/contracts/src/design-systems/components-manifest.ts";
import { DESIGN_TOKENS_FORMAT } from "../packages/contracts/src/design-systems/derived-token-outputs.ts";
import { PRODUCT_NAME } from "../packages/product-identity/src/index.ts";

type MetadataReplacement = {
  readonly current: string;
  readonly retired: string;
};

type PackageRegeneration = {
  readonly changedFiles: number;
  readonly id: string;
};

class DesignSystemMetadataError extends Error {
  readonly name = "DesignSystemMetadataError";
}

const retiredProductName = ["Open", "Design"].join(" ");
const retiredProductSlug = ["open", "design"].join("-");
const retiredDesignMetadataPrefix = ["readable", "design"].join("-");

const REPLACEMENTS_BY_FILE = {
  "USAGE.md": [
    {
      retired: `Design System 2.0 package guide for ${retiredProductName} agents and reviewers.`,
      current: `Design System 2.0 package guide for ${PRODUCT_NAME} agents and reviewers.`,
    },
  ],
  "design-tokens.json": [
    { retired: `"format": "${retiredDesignMetadataPrefix}-tokens/v1"`, current: `"format": "${DESIGN_TOKENS_FORMAT}"` },
  ],
  "manifest.json": [
    {
      retired: `"schemaVersion": "${retiredDesignMetadataPrefix}-system-project/v1"`,
      current: `"schemaVersion": "${DESIGN_SYSTEM_PROJECT_SCHEMA_VERSION}"`,
    },
    { retired: `Bundled ${retiredProductName} package`, current: `Bundled ${PRODUCT_NAME} package` },
    { retired: `${retiredProductName} curated bundled fixture`, current: `${PRODUCT_NAME} curated bundled fixture` },
  ],
  "preview/typography.html": [
    { retired: `portable across ${retiredProductName} artifacts`, current: `portable across ${PRODUCT_NAME} artifacts` },
  ],
  "source/evidence.md": [
    { retired: `curated ${retiredProductName} bundled fixture`, current: `curated ${PRODUCT_NAME} bundled fixture` },
  ],
  "source/token-contract.report.json": [
    { retired: `"sourceScope": "${retiredProductSlug}-bundled-fixture"`, current: '"sourceScope": "readable-studio-bundled-fixture"' },
  ],
  "source/tokens.source.json": [
    { retired: `"sourceScope": "${retiredProductSlug}-bundled-fixture"`, current: '"sourceScope": "readable-studio-bundled-fixture"' },
  ],
} as const satisfies Readonly<Record<string, readonly MetadataReplacement[]>>;

const repoRoot = path.resolve(import.meta.dirname, "..");

function replaceMetadata(source: string, replacements: readonly MetadataReplacement[], label: string): string {
  let output = source;
  for (const replacement of replacements) {
    const retiredCount = output.split(replacement.retired).length - 1;
    const currentCount = output.split(replacement.current).length - 1;
    if (retiredCount === 1 && currentCount === 0) {
      output = output.replace(replacement.retired, replacement.current);
      continue;
    }
    if (retiredCount === 0 && currentCount === 1) continue;
    throw new DesignSystemMetadataError(
      `${label}: expected exactly one retired or current metadata value; found retired=${retiredCount}, current=${currentCount}`,
    );
  }
  return output;
}

async function regeneratePackage(root: string, id: string): Promise<PackageRegeneration> {
  let changedFiles = 0;
  for (const [relativePath, replacements] of Object.entries(REPLACEMENTS_BY_FILE)) {
    const filePath = path.join(root, id, relativePath);
    const source = await readFile(filePath, "utf8");
    const output = replaceMetadata(source, replacements, `design-systems/${id}/${relativePath}`);
    if (output === source) continue;
    await writeFile(filePath, output, "utf8");
    changedFiles += 1;
  }

  const packageRoot = path.join(root, id);
  const [componentsHtml, tokensCss, cachedComponentsManifest] = await Promise.all([
    readFile(path.join(packageRoot, "components.html"), "utf8"),
    readFile(path.join(packageRoot, "tokens.css"), "utf8"),
    readFile(path.join(packageRoot, "components.manifest.json"), "utf8"),
  ]);
  const componentsManifest = `${JSON.stringify(extractComponentsManifest({ brandId: id, fixtureHtml: componentsHtml, tokensCss }), null, 2)}\n`;
  if (componentsManifest !== cachedComponentsManifest) {
    await writeFile(path.join(packageRoot, "components.manifest.json"), componentsManifest, "utf8");
    changedFiles += 1;
  }
  return { changedFiles, id };
}

export async function regenerateDesignSystemMetadata(root = path.join(repoRoot, "design-systems")): Promise<readonly PackageRegeneration[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const results: PackageRegeneration[] = [];
  for (const id of ids) results.push(await regeneratePackage(root, id));
  return results;
}

async function main(): Promise<void> {
  const results = await regenerateDesignSystemMetadata();
  const changedFiles = results.reduce((total, result) => total + result.changedFiles, 0);
  process.stdout.write(`Design-system metadata regeneration complete: packages=${results.length} filesChanged=${changedFiles}\n`);
}

const entryPoint = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPoint === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
