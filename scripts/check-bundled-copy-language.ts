import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const roots = ["skills", "design-templates", "plugins/_official/examples"];
const skippedDirectories = new Set([".git", "node_modules"]);
const pluginExamplesRoot = "plugins/_official/examples";

export type CatalogueCopyPath = {
  derivedRoot: "design-templates" | "skills";
  filePath: "SKILL.md" | "example.html";
  ids: readonly string[];
};

// These shared files have intentionally different English content in their
// active root. Every other shared SKILL.md/example.html pair is compared after
// removing formatting-only markup. The language scan still covers all paths.
export const intentionalCatalogueCopyDivergences: readonly CatalogueCopyPath[] = [
  {
    derivedRoot: "skills",
    filePath: "SKILL.md",
    ids: [
      "article-magazine", "card-twitter", "card-xiaohongshu", "data-report", "doc-kami-parchment", "frame-data-chart-nyt",
      "frame-flowchart-sticky", "frame-glitch-title", "frame-light-leak-cinema", "frame-liquid-bg-hero", "frame-logo-outro",
      "frame-macos-notification", "mockup-device-3d", "poster-hero", "ppt-keynote", "resume-modern", "social-reddit-card",
      "social-spotify-card", "social-x-post-card", "vfx-text-cursor",
    ],
  },
  {
    derivedRoot: "skills",
    filePath: "example.html",
    ids: [
      "article-magazine", "card-twitter", "card-xiaohongshu", "data-report", "deck-guizang-editorial", "deck-open-slide-canvas",
      "deck-swiss-international", "frame-data-chart-nyt", "frame-flowchart-sticky", "frame-liquid-bg-hero",
      "frame-macos-notification", "mockup-device-3d", "poster-hero", "ppt-keynote", "resume-modern", "social-x-post-card",
      "vfx-text-cursor",
    ],
  },
  {
    derivedRoot: "design-templates",
    filePath: "SKILL.md",
    ids: [
      "dashboard", "digital-eguide", "docs-page", "github-dashboard", "guizang-ppt", "hr-onboarding", "html-ppt",
      "html-ppt-taste-editorial", "kanban-board", "meeting-notes", "mobile-app", "pm-spec", "pricing-page", "replit-deck",
      "simple-deck", "social-media-dashboard", "tweaks", "web-prototype",
    ],
  },
  {
    derivedRoot: "design-templates",
    filePath: "example.html",
    ids: ["critique", "html-ppt-zhangzara-sakura-chroma", "kami-landing", "readable-landing"],
  },
];
const intentionalHanPaths = new Set([
  // The upstream Xiaohongshu client preserves its API's Chinese enum literals.
  "design-templates/last30days/scripts/lib/xiaohongshu_api.py",
  "design-templates/wireframe-sketch/example.html",
  "design-templates/sprite-animation/example.html",
  "design-templates/html-ppt-zhangzara-sakura-chroma/example.html",
  // Bundled copies of the reviewed Japanese-language demo previews.
  "plugins/_official/examples/sprite-animation/example.html",
  "plugins/_official/examples/wireframe-sketch/example.html",
  "design-templates/guizang-ppt/LICENSE",
]);
const hanScriptPattern = /\p{Script=Han}/gu;
const retiredSlug = ["open", "design"].join("-");
const retiredDisplay = ["Open", "Design"].join(" ");
const retiredScheme = ["od", "://"].join("");
const retiredHostGlobal = ["__", "od", "__"].join("");
const retiredIdentityPattern = new RegExp(
  `${retiredDisplay}|${retiredSlug}|${retiredScheme}|${retiredHostGlobal}`,
  "gu",
);
const immutableAssetLocatorPattern = /https:\/\/plugin-assets\.readable-studio\.ai\/[A-Za-z0-9_?&=./%+@,:;-]+/gu;
const explicitLocaleKeyPattern = /^(\s*)(?:["']?)(zh-CN|zh-TW)(?:["']?)\s*:/;
const scopedChineseScalarKeyPattern = /^(\s*)(?:["']?)(zh_name|zh_description)(?:["']?)\s*:\s*(?![>|](?:\s|$))/;
const localeTagPattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export type BundledCopyLanguageViolation = {
  filePath: string;
  lineNumber: number;
  character: string;
};

export type CanonicalCatalogueCopyViolation = {
  canonicalPath: string;
  derivedPath: string;
  reason: "missing" | "diverged";
};

function lineNumberForIndex(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function maskRange(source: string, start: number, end: number): string {
  return `${source.slice(0, start)}${" ".repeat(end - start)}${source.slice(end)}`;
}

function maskExplicitYamlLocaleValues(source: string): string {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter?.[1]) return source;

  const lines = frontmatter[1].match(/.*(?:\r?\n|$)/g) ?? [];
  let masked = source;
  let offset = source.match(/^---\r?\n/)![0].length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const localeMatch = line.match(explicitLocaleKeyPattern);
    const match = localeMatch ?? line.match(scopedChineseScalarKeyPattern);
    if (!match) {
      offset += line.length;
      continue;
    }

    const valueStart = offset + match[0].length;
    let valueEnd = offset + line.length;
    if (localeMatch && /[>|]\s*(?:#.*)?\r?\n?$/.test(line)) {
      const indentation = match[1]!.length;
      let nextOffset = valueEnd;
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]!;
        const nextIndentation = nextLine.match(/^\s*/)?.[0]?.length ?? 0;
        if (nextLine.trim() && nextIndentation <= indentation) break;
        index += 1;
        valueEnd = nextOffset + nextLine.length;
        nextOffset = valueEnd;
      }
    }
    masked = maskRange(masked, valueStart, valueEnd);
    offset = valueEnd;
  }

  return masked;
}

function jsonStringEnd(source: string, start: number): number | undefined {
  if (source[start] !== '"') return undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return undefined;
}

function skipJsonWhitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function jsonCompositeEnd(source: string, start: number): number | undefined {
  const opening = source[start];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : undefined;
  if (!closing) return undefined;

  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '"') {
      const end = jsonStringEnd(source, index);
      if (!end) return undefined;
      index = end - 1;
      continue;
    }
    if (source[index] === opening) depth += 1;
    if (source[index] === closing && --depth === 0) return index + 1;
  }
  return undefined;
}

function jsonValueEnd(source: string, start: number): number | undefined {
  if (source[start] === '"') return jsonStringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") return jsonCompositeEnd(source, start);
  const match = source.slice(start).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  return match ? start + match[0].length : undefined;
}

function parsedJsonString(source: string, start: number, end: number): string | undefined {
  try {
    return JSON.parse(source.slice(start, end)) as string;
  } catch {
    return undefined;
  }
}

function directJsonObjectValueStart(source: string, objectStart: number, propertyName: string): number | undefined {
  const objectEnd = jsonCompositeEnd(source, objectStart);
  if (!objectEnd) return undefined;

  let index = skipJsonWhitespace(source, objectStart + 1);
  while (index < objectEnd - 1) {
    const keyEnd = jsonStringEnd(source, index);
    if (!keyEnd) return undefined;
    const key = parsedJsonString(source, index, keyEnd);
    index = skipJsonWhitespace(source, keyEnd);
    if (source[index] !== ":") return undefined;
    const valueStart = skipJsonWhitespace(source, index + 1);
    const valueEnd = jsonValueEnd(source, valueStart);
    if (!valueEnd) return undefined;
    if (key === propertyName) return valueStart;
    index = skipJsonWhitespace(source, valueEnd);
    if (source[index] === ",") {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    return undefined;
  }
  return undefined;
}

function maskManifestLocalizedMap(source: string, mapStart: number, masked = source): string {
  const mapEnd = jsonCompositeEnd(source, mapStart);
  if (!mapEnd) return source;

  let index = skipJsonWhitespace(source, mapStart + 1);
  while (index < mapEnd - 1) {
    const keyEnd = jsonStringEnd(source, index);
    if (!keyEnd) return source;
    const key = parsedJsonString(source, index, keyEnd);
    index = skipJsonWhitespace(source, keyEnd);
    if (source[index] !== ":") return source;
    const valueStart = skipJsonWhitespace(source, index + 1);
    const valueEnd = jsonValueEnd(source, valueStart);
    if (!valueEnd) return source;
    if (key && localeTagPattern.test(key) && source[valueStart] === '"') {
      masked = maskRange(masked, valueStart, valueEnd);
    }
    index = skipJsonWhitespace(source, valueEnd);
    if (source[index] === ",") {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "}") return masked;
    return source;
  }
  return masked;
}

function maskManifestLocalizedProperty(
  source: string,
  masked: string,
  objectStart: number,
  propertyName: string,
): string {
  const mapStart = directJsonObjectValueStart(source, objectStart, propertyName);
  return mapStart !== undefined && source[mapStart] === "{"
    ? maskManifestLocalizedMap(source, mapStart, masked)
    : masked;
}

function maskNamedManifestLocalizedMaps(source: string, manifestStart: number): string {
  let masked = source;
  for (const propertyName of ["title_i18n", "description_i18n"]) {
    masked = maskManifestLocalizedProperty(source, masked, manifestStart, propertyName);
  }
  return masked;
}

function maskManifestUseCaseQuery(source: string, masked: string, manifestStart: number): string {
  const readableStart = directJsonObjectValueStart(source, manifestStart, "readable");
  if (readableStart === undefined || source[readableStart] !== "{") return masked;
  const useCaseStart = directJsonObjectValueStart(source, readableStart, "useCase");
  if (useCaseStart === undefined || source[useCaseStart] !== "{") return masked;
  const queryStart = directJsonObjectValueStart(source, useCaseStart, "query");
  return queryStart !== undefined && source[queryStart] === "{"
    ? maskManifestLocalizedMap(source, queryStart, masked)
    : masked;
}

function maskManifestExampleOutputTitles(source: string, masked: string, manifestStart: number): string {
  const readableStart = directJsonObjectValueStart(source, manifestStart, "readable");
  if (readableStart === undefined || source[readableStart] !== "{") return masked;
  const useCaseStart = directJsonObjectValueStart(source, readableStart, "useCase");
  if (useCaseStart === undefined || source[useCaseStart] !== "{") return masked;
  const outputsStart = directJsonObjectValueStart(source, useCaseStart, "exampleOutputs");
  if (outputsStart === undefined || source[outputsStart] !== "[") return masked;
  const outputsEnd = jsonCompositeEnd(source, outputsStart);
  if (!outputsEnd) return masked;

  let index = skipJsonWhitespace(source, outputsStart + 1);
  while (index < outputsEnd - 1) {
    const valueEnd = jsonValueEnd(source, index);
    if (!valueEnd) return masked;
    if (source[index] === "{") {
      masked = maskManifestLocalizedProperty(source, masked, index, "title_i18n");
    }
    index = skipJsonWhitespace(source, valueEnd);
    if (source[index] === ",") {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "]") return masked;
    return masked;
  }
  return masked;
}

function maskExplicitJsonLocaleValues(source: string): string {
  try {
    const manifest = JSON.parse(source) as unknown;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return source;
  } catch {
    return source;
  }

  let index = skipJsonWhitespace(source, 0);
  if (source[index] !== "{") return source;
  let masked = maskNamedManifestLocalizedMaps(source, index);
  masked = maskManifestUseCaseQuery(source, masked, index);
  return maskManifestExampleOutputTitles(source, masked, index);
}

function sourceWithoutExplicitLocalizedValues(repositoryPath: string, source: string): string {
  if (path.basename(repositoryPath) === "SKILL.md") return maskExplicitYamlLocaleValues(source);
  if (path.basename(repositoryPath) === "readable-studio.json") return maskExplicitJsonLocaleValues(source);
  return source;
}

function sourceWithoutImmutableIdentity(repositoryPath: string, source: string): string {
  const withoutAssetLocators = source.replace(immutableAssetLocatorPattern, "");
  if (!repositoryPath.startsWith(`${pluginExamplesRoot}/`)) return withoutAssetLocators;
  const pluginId = repositoryPath.slice(pluginExamplesRoot.length + 1).split("/", 1)[0];
  return pluginId ? withoutAssetLocators.replaceAll(pluginId, "") : withoutAssetLocators;
}

export function collectBundledCopyLanguageViolationsFromSource(
  repositoryPath: string,
  source: string,
): BundledCopyLanguageViolation[] {
  if (intentionalHanPaths.has(repositoryPath)) return [];

  const checkedSource = sourceWithoutExplicitLocalizedValues(repositoryPath, source);
  const languageViolations = [...checkedSource.matchAll(hanScriptPattern)].map((match) => ({
    filePath: repositoryPath,
    lineNumber: lineNumberForIndex(source, match.index ?? 0),
    character: match[0],
  }));
  const identitySource = sourceWithoutImmutableIdentity(repositoryPath, checkedSource);
  const identityViolations = [...identitySource.matchAll(retiredIdentityPattern)].map((match) => ({
    filePath: repositoryPath,
    lineNumber: lineNumberForIndex(identitySource, match.index ?? 0),
    character: match[0],
  }));
  return [...languageViolations, ...identityViolations];
}

export async function collectBundledCopyLanguageViolations(
  root = repoRoot,
  checkedRoots = roots,
): Promise<BundledCopyLanguageViolation[]> {
  const violations: BundledCopyLanguageViolation[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let source: string;
      try {
        const bytes = await readFile(fullPath);
        if (bytes.includes(0)) continue;
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const repositoryPath = path.relative(root, fullPath).split(path.sep).join("/");
      violations.push(...collectBundledCopyLanguageViolationsFromSource(repositoryPath, source));
    }
  }

  for (const checkedRoot of checkedRoots) {
    try {
      await visit(path.join(root, checkedRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return violations;
}

function normalizeMirroredCopy(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function normalizedUserVisibleCopy(filePath: CatalogueCopyPath["filePath"], source: string): string {
  if (filePath === "SKILL.md") {
    return normalizeMirroredCopy(source)
      .replace(/^---\n[\s\S]*?\n---\n?/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const htmlLanguage = source.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
  return `${htmlLanguage}\n${normalizeMirroredCopy(source)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim()}`;
}

function hasIntentionalCopyDivergence(derivedRoot: CatalogueCopyPath["derivedRoot"], id: string, filePath: CatalogueCopyPath["filePath"]): boolean {
  return intentionalCatalogueCopyDivergences.some(
    (entry) => entry.derivedRoot === derivedRoot && entry.filePath === filePath && entry.ids.includes(id),
  );
}

export async function collectSharedCatalogueCopyPaths(root = repoRoot): Promise<CatalogueCopyPath[]> {
  let pluginEntries;
  try {
    pluginEntries = await readdir(path.join(root, pluginExamplesRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const pluginIds = new Set(pluginEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  const paths: CatalogueCopyPath[] = [];

  for (const derivedRoot of ["design-templates", "skills"] as const) {
    let entries;
    try {
      entries = await readdir(path.join(root, derivedRoot), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !pluginIds.has(entry.name)) continue;
      for (const filePath of ["SKILL.md", "example.html"] as const) {
        try {
          await Promise.all([
            readFile(path.join(root, pluginExamplesRoot, entry.name, filePath)),
            readFile(path.join(root, derivedRoot, entry.name, filePath)),
          ]);
          paths.push({ derivedRoot, filePath, ids: [entry.name] });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return paths;
}

export async function collectCanonicalCatalogueCopyViolations(
  root = repoRoot,
): Promise<CanonicalCatalogueCopyViolation[]> {
  const violations: CanonicalCatalogueCopyViolation[] = [];

  for (const group of await collectSharedCatalogueCopyPaths(root)) {
    for (const id of group.ids) {
      const canonicalPath = `${pluginExamplesRoot}/${id}/${group.filePath}`;
      const derivedPath = `${group.derivedRoot}/${id}/${group.filePath}`;
      try {
        const [canonical, derived] = await Promise.all([
          readFile(path.join(root, canonicalPath), "utf8"),
          readFile(path.join(root, derivedPath), "utf8"),
        ]);
        if (
          !hasIntentionalCopyDivergence(group.derivedRoot, id, group.filePath) &&
          normalizedUserVisibleCopy(group.filePath, canonical) !== normalizedUserVisibleCopy(group.filePath, derived)
        ) {
          violations.push({ canonicalPath, derivedPath, reason: "diverged" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          violations.push({ canonicalPath, derivedPath, reason: "missing" });
          continue;
        }
        throw error;
      }
    }
  }

  return violations;
}

export async function checkBundledCopyLanguage(
  root = repoRoot,
  checkedRoots = roots,
): Promise<boolean> {
  const violations = await collectBundledCopyLanguageViolations(root, checkedRoots);
  const canonicalCopyViolations = await collectCanonicalCatalogueCopyViolations(root);
  if (violations.length === 0 && canonicalCopyViolations.length === 0) {
    console.log("Bundled copy language check passed: runtime defaults contain no unscoped Han script characters and canonical copies match.");
    return true;
  }

  if (violations.length > 0) {
    console.error("Bundled copy language violations found:");
    for (const violation of violations) console.error(`- ${violation.filePath}:${violation.lineNumber} \`${violation.character}\``);
  }
  if (canonicalCopyViolations.length > 0) {
    console.error("Bundled canonical copy violations found:");
    for (const violation of canonicalCopyViolations) {
      console.error(`- ${violation.derivedPath} ${violation.reason} from ${violation.canonicalPath}`);
    }
  }
  return false;
}
