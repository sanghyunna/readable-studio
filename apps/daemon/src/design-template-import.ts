// User deck-template ZIP import. A ZIP holds one or more HTML pages, a
// required PROMPT.md (free markdown with optional YAML front matter:
// name, description, cover, pages[{file,use}]), optional assets and an
// optional thumbnail.png|webp. The import lands as an ordinary user design
// template (`<data>/design-templates/user-<slug>/`) with a generated
// SKILL.md, so the existing listing, resolver and prompt composer pick it up
// without a separate registry.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesignTemplateImportManifest,
  DesignTemplateImportPage,
  DesignTemplateThumbnailState,
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
const USER_TEMPLATE_PAGE_INSTRUCTION =
  'Choose the page layout that fits each slide; these pages show structure and style only; their example text is not factual input.';

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
  const triggers = Array.from(
    new Set([manifest.name.toLowerCase(), ...slugifyTemplateName(manifest.name).split('-').filter((w) => w.length > 2), 'deck', 'slides']),
  ).filter(Boolean);
  const descLines = (description || 'User-imported deck template.').split(/\r?\n/).map((l) => `  ${l}`);
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
    '  mode: deck',
    '  hubType: deck',
    '  preview:',
    '    type: html',
    `    entry: ${yamlScalar(`pages/${manifest.cover}`)}`,
    '  userImported: true',
    '---',
    '',
    `# ${manifest.name}`,
    '',
    'This is a user-imported deck template. Its example pages live under `pages/` in this template folder (shared files keep their original relative layout there).',
    '',
    '## Pages',
    '',
    ...pageLines,
    '',
    USER_TEMPLATE_PAGE_INSTRUCTION,
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

export async function importDesignTemplateZip(
  input: ImportDesignTemplateZipInput,
): Promise<ImportDesignTemplateZipResult> {
  const files = readTemplateZip(input.zip);

  const disallowed = files.find((f) => !ALLOWED_TEMPLATE_EXTENSIONS.has(path.extname(f.path).toLowerCase()));
  if (disallowed) throw bad(`file type not allowed in template zip: ${disallowed.path}`);

  const promptFile = files.find((f) => f.path.toLowerCase() === 'prompt.md');
  if (!promptFile) throw bad('template zip must contain PROMPT.md at its root');
  const thumbnailFile = files.find((f) => /^thumbnail\.(png|webp)$/i.test(f.path));
  const pageFiles = files.filter((f) => f !== promptFile && f !== thumbnailFile);
  const htmlPaths = pageFiles.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path);
  if (htmlPaths.length === 0) throw bad('template zip must contain at least one .html page');

  const promptRaw = promptFile.body.toString('utf8');
  const { data: fm, body: promptBody } = parseFrontmatter(promptRaw);
  const zipBaseName = path.basename(input.originalFileName || 'template.zip').replace(/\.zip$/i, '');
  const name = asString(fm.name) ?? (zipBaseName || 'Imported template');
  const description = asString(fm.description) ?? `User-imported deck template (${htmlPaths.length} page${htmlPaths.length === 1 ? '' : 's'}).`;

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

  const sha256 = createHash('sha256').update(input.zip).digest('hex');
  const slug = slugifyTemplateName(name) || slugifyTemplateName(zipBaseName) || `template-${sha256.slice(0, 8)}`;
  await mkdir(input.root, { recursive: true });
  const id = await uniqueTemplateId(input.root, `user-${slug}`);

  const thumbnail: DesignTemplateThumbnailState = thumbnailFile
    ? { status: 'ready', source: 'zip', updatedAt: nowIso() }
    : { status: 'pending', source: null, updatedAt: nowIso() };
  const manifest: DesignTemplateImportManifest = {
    schemaVersion: 1,
    id,
    name,
    originalFileName: input.originalFileName,
    importedAt: nowIso(),
    sha256,
    pages,
    cover,
    thumbnail,
  };

  // Stage under a dot-dir (ignored by the listing until it has a SKILL.md
  // and skipped by name) and rename into place so a failed import never
  // leaves a half-written template visible.
  const staging = path.join(input.root, `.import-${randomBytes(6).toString('hex')}`);
  const dir = path.join(input.root, id);
  try {
    for (const f of pageFiles) {
      const target = safeJoin(path.join(staging, 'pages'), f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.body);
    }
    await writeFile(path.join(staging, 'PROMPT.md'), promptFile.body);
    if (thumbnailFile) {
      await mkdir(path.join(staging, 'thumbnails'), { recursive: true });
      await writeFile(
        path.join(staging, 'thumbnails', `cover${path.extname(thumbnailFile.path).toLowerCase()}`),
        thumbnailFile.body,
      );
    }
    await writeFile(path.join(staging, IMPORT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(staging, 'SKILL.md'), renderUserTemplateSkillMd(manifest, description, promptBody));
    await rename(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  if (thumbnail.status === 'pending') {
    requestTemplateThumbnails({ templateDir: dir, id }).catch((err) => {
      console.warn(`[design-template-import] thumbnail request failed for ${id}`, err);
    });
  }
  return { id, dir, manifest };
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
