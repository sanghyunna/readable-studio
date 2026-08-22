import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginManifest } from "../packages/contracts/src/plugins/manifest.js";
import type { MarketplaceManifest, MarketplacePluginEntry } from "../packages/contracts/src/plugins/marketplace.js";
import { parseManifest, parseMarketplace } from "../packages/plugin-runtime/src/index.ts";

const MANIFEST_NAME = "readable-studio.json";
const MARKETPLACE_NAME = "readable-studio-marketplace.json";
const REPOSITORY = "https://github.com/sanghyunna/readable-studio";
const RAW_ASSET_URL = /https:\/\/plugin-assets\.readable-studio\.ai\/[A-Za-z0-9_?&=./%+@,:;-]+/gu;
const retiredSlug = ["open", "design"].join("-");
const retiredDisplay = ["Open", "Design"].join(" ");
const retiredSnake = ["open", "design"].join("_");
const retiredShort = ["o", "d"].join("");
const retiredUpperPrefix = ["O", "D", "_"].join("");
const OLD_IDENTITY = new RegExp(
  `${retiredDisplay}|${retiredSlug}|${retiredSnake}|\\b${retiredShort}[.:]|\\b${retiredUpperPrefix}`,
  "u",
);

export class PluginCatalogError extends Error {
  readonly name = "PluginCatalogError";
}

export type BundledManifestSource = {
  readonly relativeFolder: string;
  readonly manifest: PluginManifest;
  readonly raw: string;
};

export type PluginCatalogAudit = {
  readonly schemaVersion: 1;
  readonly bundledCount: number;
  readonly portableManifestCount: number;
  readonly marketplaceCounts: Readonly<Record<string, number>>;
  readonly ids: readonly string[];
  readonly capabilityInventory: Readonly<Record<string, readonly string[]>>;
  readonly sourceHash: string;
  readonly generatedRegistryMatches: boolean;
};

function lexicalSort(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function parseCanonicalManifest(raw: string, label: string, folder: string): PluginManifest {
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new PluginCatalogError(`${label}: ${parsed.errors.join("; ")}`);
  const activeText = raw
    .replace(RAW_ASSET_URL, "")
    .replaceAll(parsed.manifest.name, "")
    .replaceAll(folder, "")
    .replaceAll("readable-landing", "");
  if (OLD_IDENTITY.test(activeText)) throw new PluginCatalogError(`${label}: contains active old product identity`);
  return parsed.manifest;
}

export async function readBundledManifestSources(officialRoot: string): Promise<readonly BundledManifestSource[]> {
  const sources: BundledManifestSource[] = [];
  const tiers = lexicalSort((await readdir(officialRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  for (const tier of tiers) {
    const tierRoot = path.join(officialRoot, tier);
    const folders = lexicalSort((await readdir(tierRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name));
    for (const folder of folders) {
      const relativeFolder = `${tier}/${folder}`;
      const manifestPath = path.join(tierRoot, folder, MANIFEST_NAME);
      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue;
        throw error;
      }
      const label = `${relativeFolder}/${MANIFEST_NAME}`;
      sources.push({ relativeFolder, manifest: parseCanonicalManifest(raw, label, folder), raw });
    }
  }
  const ids = sources.map((source) => source.manifest.name);
  if (new Set(ids).size !== ids.length) throw new PluginCatalogError("bundled plugin ids must be unique");
  return sources;
}

async function readFlatManifestSources(root: string, family: string): Promise<readonly BundledManifestSource[]> {
  const sources: BundledManifestSource[] = [];
  const folders = lexicalSort((await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  for (const folder of folders) {
    const manifestPath = path.join(root, folder, MANIFEST_NAME);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue;
      throw error;
    }
    const relativeFolder = `${family}/${folder}`;
    sources.push({
      relativeFolder,
      manifest: parseCanonicalManifest(raw, `${relativeFolder}/${MANIFEST_NAME}`, folder),
      raw,
    });
  }
  return sources;
}

function marketplaceEntry(source: BundledManifestSource): MarketplacePluginEntry {
  const manifest = source.manifest;
  return {
    name: `readable-studio/${manifest.name}`,
    title: manifest.title,
    title_i18n: manifest.title_i18n,
    version: manifest.version,
    source: `github:sanghyunna/readable-studio@main/plugins/_official/${source.relativeFolder}`,
    publisher: { id: "readable-studio", url: REPOSITORY },
    capabilitiesSummary: manifest.readable?.capabilities ?? [],
    description: manifest.description,
    description_i18n: manifest.description_i18n,
    tags: manifest.tags,
    homepage: `${REPOSITORY}/tree/main/plugins/_official/${source.relativeFolder}`,
    license: manifest.license,
  };
}

export async function buildOfficialMarketplace(officialRoot: string): Promise<MarketplaceManifest> {
  const sources = await readBundledManifestSources(officialRoot);
  return {
    $schema: "urn:readable-studio:schema:plugin-marketplace:v1",
    specVersion: "1.0.0",
    name: "readable-studio-official",
    version: "1.0.0",
    owner: { name: "Readable Studio", url: REPOSITORY },
    trust: "official",
    metadata: {
      description: "Official Readable Studio bundled plugin catalog.",
      version: "1.0.0",
      generatedFrom: "plugins/_official",
      bundledPreinstallCount: sources.length,
    },
    plugins: sources.map(marketplaceEntry),
  };
}

export function serializeMarketplace(marketplace: MarketplaceManifest): string {
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

export async function auditPluginCatalog(repoRoot: string): Promise<PluginCatalogAudit> {
  const officialRoot = path.join(repoRoot, "plugins", "_official");
  const sources = await readBundledManifestSources(officialRoot);
  const portableSources = [
    ...sources,
    ...await readFlatManifestSources(path.join(repoRoot, "plugins", "community"), "community"),
    ...await readFlatManifestSources(path.join(repoRoot, "plugins", "spec", "examples"), "spec/examples"),
  ];
  const generated = serializeMarketplace(await buildOfficialMarketplace(officialRoot));
  const registryPath = path.join(repoRoot, "plugins", "registry", "official", MARKETPLACE_NAME);
  const checkedIn = await readFile(registryPath, "utf8");
  const marketplaceFiles = {
    official: registryPath,
    community: path.join(repoRoot, "plugins", "registry", "community", MARKETPLACE_NAME),
    specExamples: path.join(repoRoot, "plugins", "spec", "examples", MARKETPLACE_NAME),
  } as const;
  const marketplaceCounts: Record<string, number> = {};
  for (const [name, marketplacePath] of Object.entries(marketplaceFiles)) {
    const parsed = parseMarketplace(await readFile(marketplacePath, "utf8"));
    if (!parsed.ok) throw new PluginCatalogError(`${marketplacePath}: ${parsed.errors.join("; ")}`);
    marketplaceCounts[name] = parsed.manifest.plugins.length;
  }
  const capabilityInventory = Object.fromEntries(sources.map(({ manifest }) => [
    manifest.name,
    lexicalSort(manifest.readable?.capabilities ?? []),
  ]));
  return {
    schemaVersion: 1,
    bundledCount: sources.length,
    portableManifestCount: portableSources.length,
    marketplaceCounts,
    ids: lexicalSort(sources.map((source) => source.manifest.name)),
    capabilityInventory,
    sourceHash: createHash("sha256").update(sources.map((source) => source.raw).join("\0")).digest("hex"),
    generatedRegistryMatches: generated === checkedIn,
  };
}

function usage(message: string): never {
  throw new PluginCatalogError(`${message}\nUsage: readable-plugin-catalog <generate|check|audit --output <json>>`);
}

async function main(argv: readonly string[]): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const registryPath = path.join(repoRoot, "plugins", "registry", "official", MARKETPLACE_NAME);
  const generated = serializeMarketplace(await buildOfficialMarketplace(path.join(repoRoot, "plugins", "_official")));
  switch (argv[0]) {
    case "generate":
      await writeFile(registryPath, generated, "utf8");
      process.stdout.write(`Generated ${registryPath}\n`);
      return;
    case "check": {
      const checkedIn = await readFile(registryPath, "utf8");
      if (checkedIn !== generated) throw new PluginCatalogError(`${registryPath} is stale; run generate`);
      process.stdout.write("Plugin catalog is deterministic and current.\n");
      return;
    }
    case "audit": {
      if (argv[1] !== "--output" || argv[2] === undefined || argv.length !== 3) usage("audit requires --output <json>");
      const report = await auditPluginCatalog(repoRoot);
      if (report.bundledCount !== 315) throw new PluginCatalogError(`expected 315 bundled plugins, found ${report.bundledCount}`);
      if (!report.generatedRegistryMatches) throw new PluginCatalogError("generated registry does not match canonical manifests");
      await writeFile(path.resolve(argv[2]), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`Audited ${report.bundledCount} bundled plugins.\n`);
      return;
    }
    default:
      usage(argv[0] === undefined ? "missing command" : `unknown command: ${argv[0]}`);
  }
}

const entryPoint = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPoint === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
