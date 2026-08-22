import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { InstalledPluginRecord } from '@readable-studio/contracts';

const MAX_PLUGIN_PREVIEW_BYTES = 5 * 1024 * 1024;

export class PluginHtmlTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`plugin preview HTML is ${size} bytes; maximum is ${MAX_PLUGIN_PREVIEW_BYTES}`);
    this.name = 'PluginHtmlTooLargeError';
  }
}

function assembleExample(templateHtml: string, slidesHtml: string, title: string): string {
  return templateHtml
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)} | Readable Studio Example</title>`)
    .replace('<!-- SLIDES_HERE -->', slidesHtml);
}

function previewCandidates(plugin: InstalledPluginRecord): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  push(plugin.manifest.readable?.preview?.entry);
  for (const asset of plugin.manifest.readable?.context?.assets ?? []) {
    if (typeof asset === 'string' && /\.html?$/i.test(asset)) push(asset);
  }
  for (const example of plugin.manifest.readable?.useCase?.exampleOutputs ?? []) {
    if (typeof example.path === 'string' && /\.html?$/i.test(example.path)) push(example.path);
  }
  for (const fallback of ['preview/index.html', 'index.html', 'examples/index.html', 'assets/index.html', 'assets/preview.html', 'assets/example.html', 'assets/example-slides.html', 'assets/template.html', 'public/index.html', 'dist/index.html']) push(fallback);
  return candidates;
}

function exampleCandidates(plugin: InstalledPluginRecord, name: string): string[] {
  const examples = plugin.manifest.readable?.useCase?.exampleOutputs ?? [];
  const match = examples.find((example) => {
    if (typeof example.path !== 'string') return false;
    const segments = example.path.split(/[\\/]/).filter(Boolean);
    const base = segments.at(-1) ?? '';
    return [base, base.replace(/\.[^.]+$/, ''), segments.at(-2), example.title].includes(name);
  });
  return typeof match?.path === 'string'
    ? [match.path]
    : [`examples/${name}/index.html`, `examples/${name}.html`];
}

async function discover(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ['', 'assets', 'public', 'dist', 'examples', 'preview', 'templates']) {
    try {
      for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
        if (entry.isFile() && /\.html?$/i.test(entry.name)) found.push(dir ? `${dir}/${entry.name}` : entry.name);
      }
    } catch {
      // Optional conventional directory.
    }
  }
  return found;
}

async function safeFile(root: string, relPath: string) {
  const normalized = relPath.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.split('/').some((part) => part === '..')) return null;
  try {
    const literalRoot = path.resolve(root);
    let cursor = literalRoot;
    for (const part of ['', ...normalized.split('/')]) {
      if (part) cursor = path.join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) return null;
    }
    const [rootReal, fileReal] = await Promise.all([realpath(literalRoot), realpath(path.resolve(literalRoot, normalized))]);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) return null;
    const info = await stat(fileReal);
    if (!info.isFile()) return null;
    return { filePath: fileReal, relPath: path.relative(rootReal, fileReal).split(path.sep).join('/'), size: info.size };
  } catch {
    return null;
  }
}

function iframeOnlyTarget(html: string): string | null {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1]?.replace(/<!--[\s\S]*?-->/g, '').trim();
  const src = body && /^<iframe\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>\s*(?:<\/iframe>)?\s*$/i.exec(body)?.[2];
  return src && !src.startsWith('/') && !src.includes('\0') && !/^[a-z][a-z0-9+.-]*:/i.test(src) && /\.html?(?:[?#].*)?$/i.test(src)
    ? src.split(/[?#]/)[0]!
    : null;
}

export interface ResolvedPluginHtml {
  html: string;
  entryPath: string;
  rootPath: string;
}

export async function resolvePluginHtml(plugin: InstalledPluginRecord, exampleName?: string): Promise<ResolvedPluginHtml | null> {
  if (exampleName && (/[\\/\0]/.test(exampleName) || exampleName.includes('..'))) return null;
  const candidates = exampleName
    ? exampleCandidates(plugin, exampleName)
    : [...previewCandidates(plugin), ...await discover(plugin.fsPath)];
  let selected = null;
  for (const candidate of candidates) {
    selected = await safeFile(plugin.fsPath, candidate);
    if (selected) break;
  }
  if (!selected) return null;
  if (selected.size > MAX_PLUGIN_PREVIEW_BYTES) throw new PluginHtmlTooLargeError(selected.size);

  let html = await readFile(selected.filePath, 'utf8');
  const iframeTarget = iframeOnlyTarget(html);
  if (iframeTarget) {
    const target = await safeFile(plugin.fsPath, path.posix.join(path.posix.dirname(selected.relPath), iframeTarget));
    if (target && target.size <= MAX_PLUGIN_PREVIEW_BYTES) {
      selected = target;
      html = await readFile(target.filePath, 'utf8');
    }
  }
  if (/(^|\/)example-slides\.html$/i.test(selected.relPath)) {
    const template = await safeFile(plugin.fsPath, selected.relPath.replace(/example-slides\.html$/i, 'template.html'));
    if (template && template.size <= MAX_PLUGIN_PREVIEW_BYTES) {
      html = assembleExample(await readFile(template.filePath, 'utf8'), html, plugin.title);
      selected = template;
    }
  }
  return { html, entryPath: selected.relPath, rootPath: plugin.fsPath };
}

export async function resolvePluginSourceFile(root: string, reference: string, ownerPath: string) {
  const rel = reference.startsWith('/')
    ? reference.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), reference));
  return safeFile(root, rel);
}
