import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkBundledCopyLanguage,
  collectBundledCopyLanguageViolations,
  collectCanonicalCatalogueCopyViolations,
  collectSharedCatalogueCopyPaths,
} from "./check-bundled-copy-language.ts";

test("bundled copy guard rejects Chinese SKILL, preview, and nested side-file copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "skills/example"), { recursive: true });
    await mkdir(path.join(root, "design-templates/example/references"), { recursive: true });
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await writeFile(
      path.join(root, "skills/example/SKILL.md"),
      "---\nname: example\nzh_name: \u4e2d\u6587\u9ed8\u8ba4\nzh_alias: \u4e2d\u6587\u672a\u6388\u6743\n---\nChinese \u9ed8\u8ba4\u6587\u6848\n",
    );
    await writeFile(path.join(root, "design-templates/example/example.html"), "<p>\u9884\u89c8\u6587\u6848</p>\n");
    await writeFile(path.join(root, "design-templates/example/references/guide.md"), "\u5d4c\u5957\u6587\u6848\n");
    await writeFile(
      path.join(root, "plugins/_official/examples/example/readable-studio.json"),
      '{"title_i18n":{"zh-CN":"\u4e2d\u6587\u672c\u5730\u5316","ja":"\u65e5\u672c\u8a9e"},"title":"\u9ed8\u8ba4\u6587\u6848"}',
    );

    assert.deepEqual(
      new Set((await collectBundledCopyLanguageViolations(root)).map((violation) => violation.filePath)),
      new Set([
        "skills/example/SKILL.md",
        "design-templates/example/example.html",
        "design-templates/example/references/guide.md",
        "plugins/_official/examples/example/readable-studio.json",
      ]),
    );
    assert.equal(await checkBundledCopyLanguage(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled copy guard permits explicit translations in manifests and reviewed Japanese previews", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "skills/example"), { recursive: true });
    await mkdir(path.join(root, "design-templates/last30days/scripts/lib"), { recursive: true });
    await mkdir(path.join(root, "design-templates/wireframe-sketch"), { recursive: true });
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await mkdir(path.join(root, "plugins/_official/examples/sprite-animation"), { recursive: true });
    await mkdir(path.join(root, "plugins/_official/examples/wireframe-sketch"), { recursive: true });
    await writeFile(
      path.join(root, "skills/example/SKILL.md"),
      "---\r\nname: example\r\nzh_name: \u4e2d\u6587\r\nzh_description: \u4e2d\u6587\r\nod:\r\n  example_prompt_i18n:\r\n    zh-CN: \u4e2d\u6587\r\n    zh-TW: \u4e2d\u6587\r\n---\r\nEnglish default\r\n",
    );
    await writeFile(path.join(root, "design-templates/last30days/scripts/lib/xiaohongshu_api.py"), "API = '\u4e2d\u6587'\n");
    await writeFile(path.join(root, "design-templates/wireframe-sketch/example.html"), "<p>\u65e5\u672c\u8a9e</p>\n");
    await writeFile(path.join(root, "plugins/_official/examples/sprite-animation/example.html"), "<p>\u65e5\u672c\u8a9e</p>\n");
    await writeFile(path.join(root, "plugins/_official/examples/wireframe-sketch/example.html"), "<p>\u65e5\u672c\u8a9e</p>\n");
    await writeFile(
      path.join(root, "plugins/_official/examples/example/readable-studio.json"),
      '{"title_i18n":{"zh-CN":"\u4e2d\u6587","zh-TW":"\u4e2d\u6587","ja":"\u65e5\u672c\u8a9e"},"description_i18n":{"ja-JP":"\u65e5\u672c\u8a9e"},"readable":{"useCase":{"query":{"zh-CN":"\u4e2d\u6587","ja":"\u65e5\u672c\u8a9e"},"exampleOutputs":[{"path":"./example.html","title_i18n":{"ja":"\u65e5\u672c\u8a9e"}}]}}}',
    );

    assert.equal(await checkBundledCopyLanguage(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled copy guard rejects arbitrary Japanese/Han manifest properties", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await writeFile(
      path.join(root, "plugins/_official/examples/example/readable-studio.json"),
      '{"ja":"\u65e5\u672c\u8a9e","label_i18n":{"ja":"\u65e5\u672c\u8a9e"},"readable":{"title_i18n":{"ja":"\u65e5\u672c\u8a9e"},"useCase":{"query":{"ja":"\u65e5\u672c\u8a9e"},"exampleOutputs":[{"label_i18n":{"ja":"\u65e5\u672c\u8a9e"}}]}}}',
    );

    const violations = await collectBundledCopyLanguageViolations(root);
    assert.deepEqual(
      new Set(violations.map((violation) => violation.filePath)),
      new Set(["plugins/_official/examples/example/readable-studio.json"]),
    );
    assert.equal(await checkBundledCopyLanguage(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled copy guard rejects Han defaults beside localized manifest maps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await writeFile(
      path.join(root, "plugins/_official/examples/example/readable-studio.json"),
      '{"title":"\u4e2d\u6587 fallback","description_i18n":{"zh-CN":"\u4e2d\u6587\u63cf\u8ff0","ja":"\u65e5\u672c\u8a9e"}}',
    );

    const violations = await collectBundledCopyLanguageViolations(root);
    assert.deepEqual(
      new Set(violations.map((violation) => violation.filePath)),
      new Set(["plugins/_official/examples/example/readable-studio.json"]),
    );
    assert.equal(await checkBundledCopyLanguage(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled copy guard compares every shared copy's user-visible default content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await mkdir(path.join(root, "design-templates/example"), { recursive: true });
    await writeFile(path.join(root, "plugins/_official/examples/example/example.html"), '<html lang="en"><h1>Canonical preview</h1>\n');
    await writeFile(path.join(root, "design-templates/example/example.html"), '<html lang="zh-CN"><h1>Changed preview</h1>\n');

    assert.deepEqual(await collectCanonicalCatalogueCopyViolations(root), [
      {
        canonicalPath: "plugins/_official/examples/example/example.html",
        derivedPath: "design-templates/example/example.html",
        reason: "diverged",
      },
    ]);
    assert.equal(await checkBundledCopyLanguage(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale generated identity even when canonical and derived copies agree", async () => {
  // Given: an identically stale canonical preview and generated catalogue copy.
  const root = await mkdtemp(path.join(os.tmpdir(), "readable-bundled-copy-"));
  try {
    await mkdir(path.join(root, "plugins/_official/examples/example"), { recursive: true });
    await mkdir(path.join(root, "design-templates/example"), { recursive: true });
    const retiredDisplay = ["Open", "Design"].join(" ");
    const stale = `<html lang="en"><title>${retiredDisplay}</title></html>\n`;
    await writeFile(path.join(root, "plugins/_official/examples/example/example.html"), stale);
    await writeFile(path.join(root, "design-templates/example/example.html"), stale);

    // When: the generated-copy guard audits both copies.
    const accepted = await checkBundledCopyLanguage(root);

    // Then: matching bytes cannot hide retired active identity.
    assert.equal(accepted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale active fixture contracts", async () => {
  // Given: every path explicitly classified as an active fixture contract.
  const raw: unknown = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, "readable-fixture-classification.json"),
    "utf8",
  ));
  assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
  const entries = Reflect.get(raw, "entries");
  assert.ok(Array.isArray(entries));
  const activePaths = entries.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Reflect.get(entry, "category") !== "active contract") return [];
    const filePath = Reflect.get(entry, "path");
    return typeof filePath === "string" ? [filePath] : [];
  });

  // When: active bytes are scanned for retired product contracts.
  const stale: string[] = [];
  const retiredDisplay = ["Open", "Design"].join(" ");
  const retiredSlug = ["open", "design"].join("-");
  const retiredScheme = ["od", "://"].join("");
  const retiredGlobal = ["__", "od", "__"].join("");
  const retired = new RegExp([retiredDisplay, retiredSlug, retiredScheme, retiredGlobal].join("|"), "u");
  for (const filePath of activePaths) {
    if (retired.test(await readFile(path.resolve(import.meta.dirname, "..", filePath), "utf8"))) stale.push(filePath);
  }

  // Then: no active path relies on the retired identity.
  assert.deepEqual(stale, []);
});

test("preserves raw provenance through exact path and hash ownership", async () => {
  // Given: the machine-consumed Task27 fixture classification.
  const raw: unknown = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, "readable-fixture-classification.json"),
    "utf8",
  ));
  assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
  const entries = Reflect.get(raw, "entries");
  assert.ok(Array.isArray(entries));
  const provenanceEntries = entries.filter((entry: unknown) => (
    typeof entry === "object" && entry !== null && Reflect.get(entry, "category") === "immutable raw provenance"
  ));
  assert.equal(provenanceEntries.length, 4);

  // When: every owned raw file is hashed without normalization.
  const observed = await Promise.all(provenanceEntries.map(async (entry: unknown) => {
    assert.ok(typeof entry === "object" && entry !== null);
    const filePath = Reflect.get(entry, "path");
    const expected = Reflect.get(entry, "sha256");
    assert.equal(typeof filePath, "string");
    assert.equal(typeof expected, "string");
    const actual = createHash("sha256").update(await readFile(path.resolve(import.meta.dirname, "..", filePath))).digest("hex");
    return [filePath, actual, expected];
  }));

  // Then: path ownership is exact and every byte remains unchanged.
  assert.deepEqual(observed.map(([filePath]) => filePath), [
    "mocks/golden/314d6833-0377-4ac4-ba11-2b8d7eca5511.events.json",
    "mocks/golden/9a9522ec-575f-432f-aeed-efc491e900aa.events.json",
    "mocks/golden/dcdff3b3-cd39-4dcd-be83-372830a29639.events.json",
    "mocks/manifest.json",
  ]);
  for (const [filePath, actual, expected] of observed) assert.equal(actual, expected, filePath);
});

test("every current shared catalogue file is classified, including intentionally independent copies", async () => {
  const paths = await collectSharedCatalogueCopyPaths();
  assert.equal(paths.length, 239);
  assert.deepEqual(await collectCanonicalCatalogueCopyViolations(), []);
});
