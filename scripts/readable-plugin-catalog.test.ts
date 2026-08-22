import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  PluginCatalogError,
  buildOfficialMarketplace,
  readBundledManifestSources,
  serializeMarketplace,
} from "./readable-plugin-catalog.ts";

let fixtureRoot = "";

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "readable-plugin-catalog-"));
  for (const [tier, id, capabilities] of [
    ["scenarios", "zeta", ["fs:write"]],
    ["atoms", "alpha", ["prompt:inject"]],
  ] as const) {
    const folder = path.join(fixtureRoot, tier, id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "readable-studio.json"), `${JSON.stringify({
      $schema: "urn:readable-studio:schema:plugin-manifest:v1",
      specVersion: "1.0.0",
      name: id,
      version: "1.0.0",
      author: { name: "Readable Studio" },
      readable: { capabilities },
      futureField: { retained: true },
    }, null, 2)}\n`, "utf8");
  }
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("collects every canonical source when tiers are unordered", async () => {
  // Given: two valid manifests in different bundled families.
  // When: the bounded canonical-source collector runs.
  const sources = await readBundledManifestSources(fixtureRoot);

  // Then: both capabilities are retained in deterministic path order.
  assert.deepEqual(sources.map((source) => source.relativeFolder), ["atoms/alpha", "scenarios/zeta"]);
  assert.deepEqual(Reflect.get(sources[0]?.manifest ?? {}, "futureField"), { retained: true });
});

test("generates a deterministic Readable Studio marketplace from canonical manifests", async () => {
  // Given: the same two canonical manifest sources.
  // When: the marketplace is generated twice.
  const first = serializeMarketplace(await buildOfficialMarketplace(fixtureRoot));
  const second = serializeMarketplace(await buildOfficialMarketplace(fixtureRoot));

  // Then: bytes and canonical publisher contracts match exactly.
  assert.equal(first, second);
  const parsed: unknown = JSON.parse(first);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.equal(Reflect.get(parsed, "name"), "readable-studio-official");
  const plugins = Reflect.get(parsed, "plugins");
  assert.ok(Array.isArray(plugins));
  assert.deepEqual(plugins.map((entry) => (
    typeof entry === "object" && entry !== null ? Reflect.get(entry, "name") : undefined
  )), ["readable-studio/alpha", "readable-studio/zeta"]);
});

test("rejects old product metadata instead of normalizing external v1 content", async () => {
  // Given: an otherwise valid external manifest carrying old publisher metadata.
  const folder = path.join(fixtureRoot, "legacy", "legacy-plugin");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "readable-studio.json"), JSON.stringify({
    name: "legacy-plugin",
    version: "1.0.0",
    author: { name: "Readable Studio" },
  }), "utf8");

  // When: the canonical-source collector parses the boundary.
  const action = readBundledManifestSources(fixtureRoot);

  // Then: the old format is rejected with no compatibility conversion.
  await assert.rejects(action, (error: unknown) => error instanceof PluginCatalogError && error.message.includes("UNSUPPORTED_LEGACY_PRODUCT_V1"));
});
