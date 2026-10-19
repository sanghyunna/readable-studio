// User deck-template ZIP import. A ZIP holds one or more HTML pages, a
// required PROMPT.md (free markdown with optional YAML front matter:
// name, description, cover, pages[{file,use}]), optional assets and an
// optional thumbnail.png|webp. The import lands as an ordinary user design
// template (`<data>/design-templates/user-<slug>/`) with a generated
// SKILL.md, so the existing listing, resolver and prompt composer pick it up
// without a separate registry.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesignTemplateImportManifest,
  DesignTemplateImportPage,
  DesignTemplateThumbnailState,
  DesignTemplateType,
} from '@readable-studio/contracts';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  readCentralDirectory,
  readEntryBody,
  sanitizeZipPath,
} from './claude-design-import.js';
import { parseFrontmatter } from './frontmatter.js';
import { requestTemplateThumbnails } from './design-template-thumbnails.js';

export const ALLOWED_TEMPLATE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.json', '.txt',
]);

const IMPORT_MANIFEST = 'import.json';
const PAGE_INSTRUCTION_TAIL = 'these pages show structure and style only; their example text is not factual input.';

// SKILL.md shape per Hub type. `report` is not a SkillMode (skills.ts would
// infer one from the body, possibly `deck`), so reports pin `prototype` like
// the built-in report templates; hubType carries the Hub category.
const TEMPLATE_TYPE_PROFILES: Record<DesignTemplateType, {
  mode: 'deck' | 'prototype';
  hubType: DesignTemplateType;
  noun: string;
  triggers: string[];
  instruction: string;
}> = {
  deck: {
    mode: 'deck', hubType: 'deck', noun: 'deck', triggers: ['deck', 'slides'],
    instruction: `Choose the page layout that fits each slide; ${PAGE_INSTRUCTION_TAIL}`,
  },
  report: {
    mode: 'prototype', hubType: 'report', noun: 'report', triggers: ['report', 'document'],
    instruction: `Choose the page layout that fits each section of the report; ${PAGE_INSTRUCTION_TAIL}`,
  },
  website: {
    mode: 'prototype', hubType: 'website', noun: 'website', triggers: ['website', 'web page'],
    instruction: `Choose the page layout that fits each page of the website; ${PAGE_INSTRUCTION_TAIL}`,
  },
};

export function isDesignTemplateType(value: unknown): value is DesignTemplateType {
  return value === 'deck' || value === 'report' || value === 'website';
}

// Pre-wizard manifests carry no type: they are decks.
export function templateTypeOf(manifest: Pick<DesignTemplateImportManifest, 'type'>): DesignTemplateType {
  return isDesignTemplateType(manifest.type) ? manifest.type : 'deck';
}

export class DesignTemplateImportError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'DesignTemplateImportError';
  }
}

const bad = (message: string) => new DesignTemplateImportError(400, 'BAD_REQUEST', message);

type ZipFile = { path: string; body: Buffer };

function isIgnoredZipPath(name: string): boolean {
  const segments = name.split('/').filter(Boolean);
  return segments.some((s) => s === '__MACOSX' || s.startsWith('.'));
}

function readTemplateZip(zip: Buffer): ZipFile[] {
  let entries;
  try {
    entries = readCentralDirectory(zip);
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  const files: ZipFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    let relPath: string;
    try {
      relPath = sanitizeZipPath(entry.name);
    } catch (err) {
      throw bad(`unsafe zip path: ${entry.name} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (isIgnoredZipPath(relPath)) continue;
    if (files.length >= MAX_FILES) throw bad('zip contains too many files');
    if (entry.uncompressedSize > MAX_FILE_BYTES) throw bad(`zip file too large: ${relPath}`);
    let body: Buffer;
    try {
      body = readEntryBody(zip, entry);
    } catch (err) {
      throw bad(err instanceof Error ? err.message : String(err));
    }
    if (body.length > MAX_FILE_BYTES) throw bad(`zip file too large: ${relPath}`);
    if (entry.uncompressedSize > 0 && body.length !== entry.uncompressedSize) {
      throw bad(`zip entry size mismatch: ${relPath}`);
    }
    totalBytes += body.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw bad('zip is too large');
    files.push({ path: relPath, body });
  }
  if (files.length === 0) throw bad('zip contains no files');
  return stripSingleTopFolder(files);
}

// A ZIP that wraps everything in one top-level folder is treated as if the
// folder's contents were at the root.
function stripSingleTopFolder(files: ZipFile[]): ZipFile[] {
  const first = files[0]!.path.split('/')[0]!;
  const wrapped = files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first);
  if (!wrapped) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

export function slugifyTemplateName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

function yamlScalar(value: string): string {
  return `"${value.replace(/["\r\n]+/g, ' ').trim()}"`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function renderUserTemplateSkillMd(
  manifest: DesignTemplateImportManifest,
  description: string,
  promptBody: string,
): string {
  const profile = TEMPLATE_TYPE_PROFILES[templateTypeOf(manifest)];
  const triggers = Array.from(
    new Set([manifest.name.toLowerCase(), ...slugifyTemplateName(manifest.name).split('-').filter((w) => w.length > 2), ...profile.triggers]),
  ).filter(Boolean);
  const descLines = (description || `User-imported ${profile.noun} template.`).split(/\r?\n/).map((l) => `  ${l}`);
  const pageLines = manifest.pages.map((p) => `- \`pages/${p.file}\`${p.file === manifest.cover ? ' (cover)' : ''}${p.use ? ` \u2014 ${p.use}` : ''}`);
  return [
    '---',
    `name: ${manifest.id}`,
    `en_name: ${yamlScalar(manifest.name)}`,
    `zh_name: ${yamlScalar(manifest.name)}`,
    'description: |',
    ...descLines,
    'triggers:',
    ...triggers.map((t) => `  - ${yamlScalar(t)}`),
    'readable:',
    `  mode: ${profile.mode}`,
    `  hubType: ${profile.hubType}`,
    '  preview:',
    '    type: html',
    `    entry: ${yamlScalar(`pages/${manifest.cover}`)}`,
    '  userImported: true',
    '---',
    '',
    `# ${manifest.name}`,
    '',
    `This is a user-imported ${profile.noun} template. Its example pages live under \`pages/\` in this template folder (shared files keep their original relative layout there).`,
    '',
    '## Pages',
    '',
    ...pageLines,
    '',
    profile.instruction,
    '',
    '## Template instructions (PROMPT.md)',
    '',
    promptBody,
    '',
  ].join('\n');
}

function nowIso() {
  return new Date().toISOString();
}

async function uniqueTemplateId(root: string, base: string): Promise<string> {
  if (!existsSync(path.join(root, base))) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existsSync(path.join(root, candidate))) return candidate;
  }
  throw new DesignTemplateImportError(409, 'CONFLICT', `too many templates named ${base}`);
}

// A validated, parsed template ZIP held in memory. Shared by the one-shot
// import and the upload-wizard sessions so there is a single ZIP parser.
export interface PreparedDesignTemplate {
  originalFileName: string;
  sha256: string;
  /** Pages + assets written under pages/ (PROMPT.md and thumbnail excluded). */
  pageFiles: ZipFile[];
  prompt: ZipFile;
  thumbnail?: ZipFile;
  pages: DesignTemplateImportPage[];
  suggestedName: string;
  suggestedCover: string;
}

export function prepareDesignTemplateZip(zip: Buffer, originalFileName: string): PreparedDesignTemplate {
  const files = readTemplateZip(zip);

  const disallowed = files.find((f) => !ALLOWED_TEMPLATE_EXTENSIONS.has(path.extname(f.path).toLowerCase()));
  if (disallowed) throw bad(`file type not allowed in template zip: ${disallowed.path}`);

  const promptFile = files.find((f) => f.path.toLowerCase() === 'prompt.md');
  if (!promptFile) throw bad('template zip must contain PROMPT.md at its root');
  const thumbnailFile = files.find((f) => /^thumbnail\.(png|webp)$/i.test(f.path));
  const pageFiles = files.filter((f) => f !== promptFile && f !== thumbnailFile);
  const htmlPaths = pageFiles.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path);
  if (htmlPaths.length === 0) throw bad('template zip must contain at least one .html page');

  const { data: fm } = parseFrontmatter(promptFile.body.toString('utf8'));
  const name = asString(fm.name) ?? (zipBaseName(originalFileName) || 'Imported template');

  const fmPages = new Map<string, string | undefined>();
  if (Array.isArray(fm.pages)) {
    for (const item of fm.pages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const file = asString((item as Record<string, unknown>).file);
      if (file) fmPages.set(file.replace(/^\.?\//, ''), asString((item as Record<string, unknown>).use));
    }
  }
  const pages: DesignTemplateImportPage[] = htmlPaths.map((file) => {
    const use = fmPages.get(file);
    return use ? { file, use } : { file };
  });
  const coverCandidate = asString(fm.cover)?.replace(/^\.?\//, '');
  const cover = coverCandidate && htmlPaths.includes(coverCandidate) ? coverCandidate : htmlPaths[0]!;

  return {
    originalFileName,
    sha256: createHash('sha256').update(zip).digest('hex'),
    pageFiles,
    prompt: promptFile,
    ...(thumbnailFile ? { thumbnail: thumbnailFile } : {}),
    pages,
    suggestedName: name,
    suggestedCover: cover,
  };
}

function zipBaseName(originalFileName: string): string {
  return path.basename(originalFileName || 'template.zip').replace(/\.zip$/i, '');
}

// Writes pages/** and PROMPT.md of a prepared ZIP into a hidden staging dir.
export async function writePreparedTemplateFiles(dir: string, prepared: PreparedDesignTemplate): Promise<void> {
  for (const f of prepared.pageFiles) {
    const target = safeJoin(path.join(dir, 'pages'), f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.body);
  }
  await writeFile(path.join(dir, 'PROMPT.md'), prepared.prompt.body);
}

export interface FinalizeDesignTemplateInput {
  root: string;
  /** Hidden dir already holding pages/**, PROMPT.md and optional thumbnails/cover.*. */
  stagingDir: string;
  type: DesignTemplateType;
  name: string;
  cover: string;
  pages: DesignTemplateImportPage[];
  originalFileName: string;
  sha256: string;
  thumbnail: DesignTemplateThumbnailState;
}

// Writes import.json + SKILL.md into the staging dir and renames it into
// place as `<root>/user-<slug>`, so the listing only ever sees a complete
// template. On failure the two generated files are removed again and the
// staging dir is left for the caller to retry or discard.
export async function finalizeDesignTemplateDir(
  input: FinalizeDesignTemplateInput,
): Promise<ImportDesignTemplateZipResult> {
  const { data: fm, body: promptBody } = parseFrontmatter(await readFile(path.join(input.stagingDir, 'PROMPT.md'), 'utf8'));
  const count = input.pages.length;
  const description = asString(fm.description)
    ?? `User-imported ${TEMPLATE_TYPE_PROFILES[input.type].noun} template (${count} page${count === 1 ? '' : 's'}).`;
  const slug = slugifyTemplateName(input.name)
    || slugifyTemplateName(zipBaseName(input.originalFileName))
    || `template-${input.sha256.slice(0, 8)}`;
  await mkdir(input.root, { recursive: true });
  const id = await uniqueTemplateId(input.root, `user-${slug}`);
  const manifest: DesignTemplateImportManifest = {
    schemaVersion: 1,
    id,
    name: input.name,
    originalFileName: input.originalFileName,
    importedAt: nowIso(),
    sha256: input.sha256,
    pages: input.pages,
    cover: input.cover,
    thumbnail: input.thumbnail,
    type: input.type,
  };
  const dir = path.join(input.root, id);
  try {
    await writeFile(path.join(input.stagingDir, IMPORT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(input.stagingDir, 'SKILL.md'), renderUserTemplateSkillMd(manifest, description, promptBody));
    await rename(input.stagingDir, dir);
  } catch (err) {
    await rm(path.join(input.stagingDir, IMPORT_MANIFEST), { force: true });
    await rm(path.join(input.stagingDir, 'SKILL.md'), { force: true });
    throw err;
  }
  if (manifest.thumbnail.status === 'pending') {
    requestTemplateThumbnails({ templateDir: dir, id }).catch((err) => {
      console.warn(`[design-template-import] thumbnail request failed for ${id}`, err);
    });
  }
  return { id, dir, manifest };
}

export interface ImportDesignTemplateZipInput {
  root: string;
  zip: Buffer;
  originalFileName: string;
}

export interface ImportDesignTemplateZipResult {
  id: string;
  dir: string;
  manifest: DesignTemplateImportManifest;
}

// One-shot import (POST /api/design-templates/import, CLI import without
// options): suggested name and cover, deck type.
export async function importDesignTemplateZip(
  input: ImportDesignTemplateZipInput,
): Promise<ImportDesignTemplateZipResult> {
  const prepared = prepareDesignTemplateZip(input.zip, input.originalFileName);
  await mkdir(input.root, { recursive: true });
  // Stage under a dot-dir (skipped by the listing, which only reads
  // <root>/<dir>/SKILL.md) and rename into place so a failed import never
  // leaves a half-written template visible.
  const staging = path.join(input.root, `.import-${randomBytes(6).toString('hex')}`);
  try {
    await writePreparedTemplateFiles(staging, prepared);
    if (prepared.thumbnail) {
      await mkdir(path.join(staging, 'thumbnails'), { recursive: true });
      await writeFile(
        path.join(staging, 'thumbnails', `cover${path.extname(prepared.thumbnail.path).toLowerCase()}`),
        prepared.thumbnail.body,
      );
    }
    return await finalizeDesignTemplateDir({
      root: input.root,
      stagingDir: staging,
      type: 'deck',
      name: prepared.suggestedName,
      cover: prepared.suggestedCover,
      pages: prepared.pages,
      originalFileName: input.originalFileName,
      sha256: prepared.sha256,
      thumbnail: prepared.thumbnail
        ? { status: 'ready', source: 'zip', updatedAt: nowIso() }
        : { status: 'pending', source: null, updatedAt: nowIso() },
    });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

// Shared page-path guard for the persistent template pages route and the
// upload-session pages route. Rejects traversal, dot segments, absolute and
// drive-qualified paths before any filesystem access.
export function assertSafeTemplatePagePath(splat: unknown): string {
  const relative = (Array.isArray(splat) ? splat.join('/') : String(splat ?? '')).replace(/\\/g, '/');
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'))
    || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0')) {
    throw new DesignTemplateImportError(403, 'FORBIDDEN', 'unsafe template page path');
  }
  return relative;
}

// Resolves a safe relative path inside pagesDir through realpath so a
// symlink cannot escape it. 404 when missing or not a regular file.
export async function resolveTemplatePageFile(
  pagesDir: string,
  relative: string,
): Promise<{ root: string; within: string; file: string }> {
  try {
    const root = await realpath(pagesDir);
    const file = await realpath(path.resolve(root, relative));
    const within = path.relative(root, file);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      throw new DesignTemplateImportError(403, 'FORBIDDEN', 'unsafe template page path');
    }
    if (!(await stat(file)).isFile()) throw new DesignTemplateImportError(404, 'NOT_FOUND', 'page not found');
    return { root, within, file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new DesignTemplateImportError(404, 'NOT_FOUND', 'page not found');
    }
    throw err;
  }
}

function safeJoin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  if (!target.startsWith(resolvedRoot + path.sep)) throw bad(`path escapes template dir: ${relPath}`);
  return target;
}

function userTemplateDir(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new DesignTemplateImportError(404, 'NOT_FOUND', 'design template not found');
  }
  return path.join(root, id);
}

export async function readUserTemplateManifest(dir: string): Promise<DesignTemplateImportManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, IMPORT_MANIFEST), 'utf8'));
    return parsed && parsed.schemaVersion === 1 && typeof parsed.id === 'string' ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

// A project created from a user-imported design template (skillId ===
// templateRef.id, see .omo apply-contract) keeps that template's SKILL.md;
// the default scenario plugin must neither be pinned nor replace it.
export function selectsUserImportedTemplate(root: string, skillId: unknown, metadata: unknown): boolean {
  return typeof skillId === 'string'
    && /^user-[a-z0-9-]+$/.test(skillId)
    && (metadata as { templateRef?: { id?: unknown } } | null | undefined)?.templateRef?.id === skillId
    && existsSync(path.join(root, skillId, IMPORT_MANIFEST));
}

// Resolves a user-imported template or throws 404 (unknown id) / 403 (the
// id exists but is not a user-imported template, e.g. a built-in).
export async function requireUserImportedTemplate(
  root: string,
  id: string,
  existsElsewhere: boolean,
): Promise<{ dir: string; manifest: DesignTemplateImportManifest }> {
  const dir = userTemplateDir(root, id);
  const manifest = existsSync(dir) ? await readUserTemplateManifest(dir) : null;
  if (manifest) return { dir, manifest };
  if (existsElsewhere || existsSync(dir)) {
    throw new DesignTemplateImportError(403, 'FORBIDDEN', 'only user-imported design templates can be changed');
  }
  throw new DesignTemplateImportError(404, 'NOT_FOUND', 'design template not found');
}

export async function renameUserDesignTemplate(
  dir: string,
  manifest: DesignTemplateImportManifest,
  nextName: unknown,
): Promise<DesignTemplateImportManifest> {
  const name = asString(nextName);
  if (!name) throw bad('name is required');
  if (name.length > 120) throw bad('name is too long');
  const updated: DesignTemplateImportManifest = { ...manifest, name };
  const { data: skillFm } = parseFrontmatter(await readFile(path.join(dir, 'SKILL.md'), 'utf8'));
  const { body: promptBody } = parseFrontmatter(await readFile(path.join(dir, 'PROMPT.md'), 'utf8'));
  const description = asString(skillFm.description) ?? '';
  await writeFile(path.join(dir, IMPORT_MANIFEST), `${JSON.stringify(updated, null, 2)}\n`);
  await writeFile(path.join(dir, 'SKILL.md'), renderUserTemplateSkillMd(updated, description, promptBody));
  return updated;
}

export async function deleteUserDesignTemplate(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function markUserTemplateThumbnailsPending(
  dir: string,
  manifest: DesignTemplateImportManifest,
): Promise<DesignTemplateImportManifest> {
  const updated: DesignTemplateImportManifest = {
    ...manifest,
    thumbnail: { status: 'pending', source: null, updatedAt: nowIso() },
  };
  await writeFile(path.join(dir, IMPORT_MANIFEST), `${JSON.stringify(updated, null, 2)}\n`);
  await requestTemplateThumbnails({ templateDir: dir, id: manifest.id });
  return updated;
}

// Cover thumbnail on disk (thumbnails/cover.webp preferred, then .png).
export async function findUserTemplateCoverThumbnail(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(path.join(dir, 'thumbnails'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  for (const candidate of ['cover.webp', 'cover.png']) {
    if (names.includes(candidate)) return path.join(dir, 'thumbnails', candidate);
  }
  return null;
}
