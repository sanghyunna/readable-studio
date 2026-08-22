import path from 'node:path';

import { load } from 'cheerio';
import { build, type Loader, type Plugin } from 'esbuild';

import { embedUsedSystemFonts } from './font-embed-runtime.js';
import { injectStandaloneDeckKeyDedupe } from './standalone-deck-nav.js';

export const MAX_STANDALONE_HTML_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_STANDALONE_REFERENCES = 500;
export const MAX_STANDALONE_HTML_BYTES = 100 * 1024 * 1024;
export const MAX_STANDALONE_READ_CONCURRENCY = 8;

export interface StandaloneSourceFile {
  path: string;
  mime: string;
  size: number;
  read(): Promise<Buffer>;
}

export interface StandaloneSource {
  html: string;
  entryPath: string;
  resolve(reference: string, ownerPath: string): Promise<StandaloneSourceFile | null>;
}

export interface StandaloneBundleReport {
  html: string;
  outputBytes: number;
  externalReferences: string[];
  missingLocalReferences: string[];
  skippedSystemFonts: string[];
}

export class StandaloneHtmlLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneHtmlLimitError';
  }
}

export class StandaloneHtmlBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneHtmlBundleError';
  }
}

export class StandaloneHtmlResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneHtmlResolutionError';
  }
}

type ReferenceKind = 'ignored' | 'external' | 'local';

function classifyReference(reference: string): ReferenceKind {
  const value = reference.trim();
  if (!value || value.startsWith('#') || /^data:/i.test(value)) return 'ignored';
  if (value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return 'external';
  return 'local';
}

function referencePath(reference: string): string {
  const splitAt = reference.search(/[?#]/);
  const pathname = splitAt < 0 ? reference : reference.slice(0, splitAt);
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function referenceFragment(reference: string): string {
  const index = reference.indexOf('#');
  return index < 0 ? '' : reference.slice(index);
}

function localReferenceKey(reference: string, ownerPath: string): string {
  const raw = referencePath(reference).replace(/\\/g, '/');
  return raw.startsWith('/')
    ? path.posix.normalize(raw.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), raw));
}

function mimeFor(file: StandaloneSourceFile): string {
  if (file.mime && file.mime !== 'application/octet-stream') return file.mime;
  const ext = path.posix.extname(file.path).toLowerCase();
  return ({
    '.avif': 'image/avif', '.css': 'text/css', '.gif': 'image/gif',
    '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function loaderFor(filePath: string): Loader {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'ts';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.css') return 'css';
  if (ext === '.json') return 'json';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.woff', '.woff2', '.ttf', '.otf'].includes(ext)) return 'dataurl';
  return 'js';
}

function cssIgnoredRanges(css: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < css.length;) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      const rangeEnd = end < 0 ? css.length : end + 2;
      ranges.push([index, rangeEnd]);
      index = rangeEnd;
      continue;
    }
    const quote = css[index];
    if (quote === '"' || quote === "'") {
      const start = index++;
      while (index < css.length) {
        if (css[index] === '\\') index += 2;
        else if (css[index++] === quote) break;
      }
      ranges.push([start, Math.min(index, css.length)]);
      continue;
    }
    index += 1;
  }
  return ranges;
}

function parseSrcset(srcset: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let index = 0;
  while (index < srcset.length) {
    while (index < srcset.length && (srcset[index] === ',' || /\s/.test(srcset[index]!))) index += 1;
    if (index >= srcset.length) break;
    const start = index;
    const dataUrl = srcset.slice(index, index + 5).toLowerCase() === 'data:';
    while (index < srcset.length && !/\s/.test(srcset[index]!)) {
      if (srcset[index] === ',' && (!dataUrl || /\s/.test(srcset[index + 1] ?? ''))) break;
      index += 1;
    }
    const url = srcset.slice(start, index);
    while (index < srcset.length && /\s/.test(srcset[index]!)) index += 1;
    const descriptorStart = index;
    while (index < srcset.length && srcset[index] !== ',') index += 1;
    candidates.push({ url, descriptor: srcset.slice(descriptorStart, index).trim() });
    if (srcset[index] === ',') index += 1;
  }
  return candidates;
}

function inRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
  skipRanges: Array<[number, number]> = [],
): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input))) {
    if (inRanges(match.index, skipRanges)) continue;
    parts.push(input.slice(cursor, match.index), await replacer(match));
    cursor = match.index + match[0].length;
  }
  parts.push(input.slice(cursor));
  return parts.join('');
}

function ownerFromBase(entryPath: string, href: string): string {
  const raw = referencePath(href).replace(/\\/g, '/');
  const resolved = raw.startsWith('/')
    ? path.posix.normalize(raw.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), raw));
  return href.endsWith('/') ? path.posix.join(resolved, '__readable_base__.html') : resolved;
}

export async function bundleStandaloneHtml(source: StandaloneSource): Promise<StandaloneBundleReport> {
  const ownerBytes = Buffer.byteLength(source.html, 'utf8');
  if (ownerBytes > MAX_STANDALONE_HTML_SOURCE_BYTES) {
    throw new StandaloneHtmlLimitError(`source HTML exceeds ${MAX_STANDALONE_HTML_SOURCE_BYTES} bytes`);
  }

  const external = new Set<string>();
  const missing = new Set<string>();
  const missingKeys = new Set<string>();
  const fileReads = new Map<string, Promise<Buffer>>();
  const readReservations = new Map<string, number>();
  const dataUris = new Map<string, Promise<string | null>>();
  let candidateCount = 0;
  let embeddedBytes = ownerBytes;
  let effectiveOwner = source.entryPath;
  let externalBase = false;
  let activeReads = 0;
  const readWaiters: Array<() => void> = [];

  const noteCandidate = () => {
    candidateCount += 1;
    if (candidateCount > MAX_STANDALONE_REFERENCES) {
      throw new StandaloneHtmlLimitError(`more than ${MAX_STANDALONE_REFERENCES} static references`);
    }
  };

  const noteMissing = (reference: string, ownerPath: string) => {
    const key = localReferenceKey(reference, ownerPath);
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.add(reference);
  };

  const adjustBytes = (delta: number) => {
    embeddedBytes += delta;
    if (embeddedBytes > MAX_STANDALONE_HTML_BYTES) {
      throw new StandaloneHtmlLimitError(`standalone HTML exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`);
    }
  };

  const releaseReadReservation = (file: StandaloneSourceFile) => {
    const reserved = readReservations.get(file.path);
    if (reserved === undefined) return;
    readReservations.delete(file.path);
    adjustBytes(-reserved);
  };

  const withReadSlot = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeReads >= MAX_STANDALONE_READ_CONCURRENCY) {
      await new Promise<void>((resolveWaiter) => readWaiters.push(resolveWaiter));
    }
    activeReads += 1;
    try {
      return await operation();
    } finally {
      activeReads -= 1;
      readWaiters.shift()?.();
    }
  };

  const read = (file: StandaloneSourceFile) => {
    let pending = fileReads.get(file.path);
    if (!pending) {
      if (file.size > MAX_STANDALONE_HTML_BYTES) {
        pending = Promise.reject(new StandaloneHtmlLimitError(`asset ${file.path} exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`));
      } else {
        adjustBytes(file.size);
        readReservations.set(file.path, file.size);
        pending = withReadSlot(async () => {
          const bytes = await file.read();
          if (bytes.length > MAX_STANDALONE_HTML_BYTES) {
            throw new StandaloneHtmlLimitError(`asset ${file.path} exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`);
          }
          const reserved = readReservations.get(file.path);
          if (reserved !== undefined && reserved !== bytes.length) {
            adjustBytes(bytes.length - reserved);
            readReservations.set(file.path, bytes.length);
          }
          return bytes;
        });
      }
      fileReads.set(file.path, pending);
    }
    return pending;
  };

  const readLocal = async (file: StandaloneSourceFile, reference: string, ownerPath: string) => {
    try {
      return await read(file);
    } catch (error) {
      if (error instanceof StandaloneHtmlLimitError) throw error;
      releaseReadReservation(file);
      noteMissing(reference, ownerPath);
      return null;
    }
  };

  const resolve = async (reference: string, ownerPath: string) => {
    const kind = classifyReference(reference);
    if (kind === 'ignored') return { kind } as const;
    noteCandidate();
    if (kind === 'external' || externalBase) {
      external.add(reference);
      return { kind: 'external' } as const;
    }
    try {
      const file = await source.resolve(referencePath(reference), ownerPath);
      if (!file) {
        noteMissing(reference, ownerPath);
        return { kind: 'missing' } as const;
      }
      return { kind: 'file', file } as const;
    } catch (error) {
      if (error instanceof StandaloneHtmlLimitError || error instanceof StandaloneHtmlResolutionError) throw error;
      noteMissing(reference, ownerPath);
      return { kind: 'missing' } as const;
    }
  };

  const inlineUrl = async (reference: string, ownerPath: string): Promise<string> => {
    const result = await resolve(reference, ownerPath);
    if (result.kind !== 'file') return reference;
    const mimePrefix = `data:${mimeFor(result.file)};base64,`;
    const projectedUriBytes = Buffer.byteLength(mimePrefix, 'utf8') + 4 * Math.ceil(result.file.size / 3);
    if (embeddedBytes + Math.max(0, projectedUriBytes - Buffer.byteLength(reference, 'utf8')) > MAX_STANDALONE_HTML_BYTES) {
      throw new StandaloneHtmlLimitError(`standalone HTML exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`);
    }
    let pending = dataUris.get(result.file.path);
    if (!pending) {
      pending = (async () => {
        const bytes = await readLocal(result.file, reference, ownerPath);
        if (!bytes) return null;
        return `${mimePrefix}${bytes.toString('base64')}`;
      })();
      dataUris.set(result.file.path, pending);
    }
    const uri = await pending;
    if (uri === null) return reference;
    releaseReadReservation(result.file);
    adjustBytes(Buffer.byteLength(`${uri}${referenceFragment(reference)}`, 'utf8') - Buffer.byteLength(reference, 'utf8'));
    return `${uri}${referenceFragment(reference)}`;
  };

  const processCss = async (css: string, ownerPath: string, stack = new Set<string>()): Promise<string> => {
    const importRanges = cssIgnoredRanges(css);
    const importsExpanded = await replaceAsync(
      css,
      /@import\s+(?:url\(\s*(?:(['"])([^'"]*?)\1|([^'"\s)][^)]*?))\s*\)|(['"])([^'"]*?)\4)\s*([^;]*);/gi,
      async (match) => {
        const reference = (match[2] ?? match[3] ?? match[5] ?? '').trim();
        const result = await resolve(reference, ownerPath);
        if (result.kind !== 'file') return match[0];
        if (stack.has(result.file.path)) {
          noteMissing(reference, ownerPath);
          return match[0];
        }
        const importBytes = Buffer.byteLength(match[0], 'utf8');
        adjustBytes(-importBytes);
        const bytes = await readLocal(result.file, reference, ownerPath);
        if (!bytes) {
          adjustBytes(importBytes);
          return match[0];
        }
        const nextStack = new Set(stack).add(result.file.path);
        const imported = await processCss(bytes.toString('utf8'), result.file.path, nextStack);
        const media = (match[6] ?? '').trim();
        const replacement = media ? `@media ${media}{\n${imported}\n}` : imported;
        releaseReadReservation(result.file);
        adjustBytes(bytes.length + Buffer.byteLength(replacement, 'utf8') - Buffer.byteLength(imported, 'utf8'));
        return replacement;
      },
      importRanges,
    );
    return replaceAsync(
      importsExpanded,
      /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi,
      async (match) => {
        const value = (match[2] ?? '').trim();
        if (!value) return match[0];
        return `url(${match[1] ?? ''}${await inlineUrl(value, ownerPath)}${match[1] ?? ''})`;
      },
      cssIgnoredRanges(importsExpanded),
    );
  };

  const bundleModule = async (contents: string, ownerPath: string) => {
    const moduleOwnerPath = /\.html?$/i.test(ownerPath)
      ? path.posix.join(path.posix.dirname(ownerPath), '__readable_inline_module__.js')
      : ownerPath;
    const files = new Map<string, StandaloneSourceFile>();
    const dataUrlReservations = new Map<string, number>();
    let fatalError: StandaloneHtmlLimitError | StandaloneHtmlResolutionError | undefined;
    const reserveModuleDataUrl = (file: StandaloneSourceFile) => {
      if (loaderFor(file.path) !== 'dataurl' || dataUrlReservations.has(file.path)) return;
      const projected = Buffer.byteLength(`data:${mimeFor(file)};base64,`, 'utf8') + 4 * Math.ceil(file.size / 3);
      const pendingRaw = readReservations.get(file.path) ?? (fileReads.has(file.path) ? 0 : file.size);
      const reservation = Math.max(0, projected - pendingRaw);
      adjustBytes(reservation);
      dataUrlReservations.set(file.path, reservation);
    };
    const reconcileModuleDataUrl = (file: StandaloneSourceFile, actualBytes: number) => {
      const reservation = dataUrlReservations.get(file.path);
      if (reservation === undefined) return;
      const projected = Buffer.byteLength(`data:${mimeFor(file)};base64,`, 'utf8') + 4 * Math.ceil(actualBytes / 3);
      const next = Math.max(0, projected - (readReservations.get(file.path) ?? 0));
      adjustBytes(next - reservation);
      dataUrlReservations.set(file.path, next);
    };
    const plugin: Plugin = {
      name: 'readable-studio-standalone',
      setup(esbuild) {
        esbuild.onResolve({ filter: /.*/ }, async (args) => {
          if (args.kind === 'entry-point') return { path: moduleOwnerPath, namespace: 'readable-entry' };
          const importer = !args.importer || args.importer === moduleOwnerPath || args.namespace === 'readable-entry'
            ? moduleOwnerPath
            : args.importer;
          let result;
          try {
            result = await resolve(args.path, importer);
          } catch (error) {
            if (error instanceof StandaloneHtmlLimitError || error instanceof StandaloneHtmlResolutionError) fatalError = error;
            throw error;
          }
          if (result.kind !== 'file') return { path: args.path, external: true };
          try {
            reserveModuleDataUrl(result.file);
            const bytes = await readLocal(result.file, args.path, importer);
            if (!bytes) return { path: args.path, external: true };
            reconcileModuleDataUrl(result.file, bytes.length);
          } catch (error) {
            if (error instanceof StandaloneHtmlLimitError || error instanceof StandaloneHtmlResolutionError) fatalError = error;
            throw error;
          }
          files.set(result.file.path, result.file);
          return { path: result.file.path, namespace: 'readable-file' };
        });
        esbuild.onLoad({ filter: /.*/, namespace: 'readable-entry' }, () => ({ contents, loader: loaderFor(moduleOwnerPath) }));
        esbuild.onLoad({ filter: /.*/, namespace: 'readable-file' }, async (args) => {
          const file = files.get(args.path)!;
          return { contents: await read(file), loader: loaderFor(file.path) };
        });
      },
    };
    try {
      const result = await build({
        entryPoints: ['readable-entry'],
        bundle: true,
        write: false,
        outdir: 'out',
        entryNames: 'bundle',
        platform: 'browser',
        format: 'esm',
        splitting: false,
        sourcemap: false,
        legalComments: 'inline',
        logLevel: 'silent',
        target: ['chrome120', 'edge120', 'firefox121', 'safari17'],
        plugins: [plugin],
      });
      const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? '';
      const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text;
      for (const file of files.values()) releaseReadReservation(file);
      for (const reservation of dataUrlReservations.values()) adjustBytes(-reservation);
      return { js, css };
    } catch (error) {
      if (fatalError) throw fatalError;
      if (error instanceof StandaloneHtmlLimitError || error instanceof StandaloneHtmlResolutionError) throw error;
      throw new StandaloneHtmlBundleError(error instanceof Error ? error.message : String(error));
    }
  };

  const $ = load(source.html);
  const base = $('base[href]').first();
  if (base.length) {
    const href = base.attr('href') ?? '';
    const kind = classifyReference(href);
    if (kind === 'local') {
      effectiveOwner = ownerFromBase(source.entryPath, href);
      base.remove();
    } else if (kind === 'external') {
      external.add(href);
      externalBase = true;
    }
  }

  for (const element of $('link[rel~="stylesheet"][href]').toArray()) {
    const tag = $(element);
    const href = tag.attr('href')!;
    const result = await resolve(href, effectiveOwner);
    if (result.kind !== 'file') continue;
    const originalTagBytes = Buffer.byteLength($.html(element), 'utf8');
    adjustBytes(-originalTagBytes);
    const bytes = await readLocal(result.file, href, effectiveOwner);
    if (!bytes) {
      adjustBytes(originalTagBytes);
      continue;
    }
    const css = await processCss(bytes.toString('utf8'), result.file.path, new Set([result.file.path]));
    const attrs = ['media', 'title', 'nonce'].flatMap((name) => tag.attr(name) == null ? [] : [`${name}="${tag.attr(name)}"`]);
    if (tag.is('[disabled]')) attrs.push('disabled');
    const replacement = `<style data-readable-bundled-from="${href.replace(/"/g, '&quot;')}"${attrs.length ? ` ${attrs.join(' ')}` : ''}>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
    releaseReadReservation(result.file);
    adjustBytes(bytes.length + Buffer.byteLength(replacement, 'utf8') - Buffer.byteLength(css, 'utf8'));
    tag.replaceWith(replacement);
  }

  for (const element of $('style').toArray()) {
    const tag = $(element);
    if (tag.is('[data-readable-bundled-from]')) continue;
    tag.text(await processCss(tag.html() ?? '', effectiveOwner));
  }
  for (const element of $('[style]').toArray()) {
    const tag = $(element);
    tag.attr('style', await processCss(tag.attr('style') ?? '', effectiveOwner));
  }

  for (const element of $('script[src]').toArray()) {
    const tag = $(element);
    const src = tag.attr('src')!;
    const result = await resolve(src, effectiveOwner);
    if (result.kind !== 'file') continue;
    const originalTagBytes = Buffer.byteLength($.html(element), 'utf8');
    adjustBytes(-originalTagBytes);
    const bytes = await readLocal(result.file, src, effectiveOwner);
    if (!bytes) {
      adjustBytes(originalTagBytes);
      continue;
    }
    const contents = bytes.toString('utf8');
    let injectedCss = '';
    if ((tag.attr('type') ?? '').toLowerCase() === 'module') {
      const bundled = await bundleModule(contents, result.file.path);
      tag.removeAttr('src integrity crossorigin').html(bundled.js.replace(/<\/script/gi, '<\\/script'));
      if (bundled.css) {
        injectedCss = `<style data-readable-bundled-module-css>${bundled.css.replace(/<\/style/gi, '<\\/style')}</style>`;
        tag.before(injectedCss);
      }
    } else {
      tag.removeAttr('src integrity crossorigin').html(contents.replace(/<\/script/gi, '<\\/script'));
    }
    releaseReadReservation(result.file);
    adjustBytes(Buffer.byteLength($.html(element), 'utf8') + Buffer.byteLength(injectedCss, 'utf8'));
  }
  for (const element of $('script[type="module"]:not([src])').toArray()) {
    const tag = $(element);
    const original = tag.html() ?? '';
    const originalTagBytes = Buffer.byteLength($.html(element), 'utf8');
    const bundled = await bundleModule(original, effectiveOwner);
    tag.html(bundled.js.replace(/<\/script/gi, '<\\/script'));
    const injectedCss = bundled.css
      ? `<style data-readable-bundled-module-css>${bundled.css.replace(/<\/style/gi, '<\\/style')}</style>`
      : '';
    if (injectedCss) tag.before(injectedCss);
    adjustBytes(Buffer.byteLength($.html(element), 'utf8') + Buffer.byteLength(injectedCss, 'utf8') - originalTagBytes);
  }

  const urlAttributes: Array<[string, string]> = [
    ['img[src]', 'src'], ['source[src]', 'src'], ['video[src]', 'src'], ['video[poster]', 'poster'],
    ['audio[src]', 'src'], ['track[src]', 'src'], ['input[type="image"][src]', 'src'],
    ['object[data]', 'data'], ['embed[src]', 'src'], ['link[rel~="icon"][href]', 'href'],
    ['link[rel="apple-touch-icon"][href]', 'href'], ['link[rel="mask-icon"][href]', 'href'],
    ['svg image[href]', 'href'], ['svg image[xlink\\:href]', 'xlink:href'],
  ];
  for (const [selector, attribute] of urlAttributes) {
    for (const element of $(selector).toArray()) {
      const tag = $(element);
      const value = tag.attr(attribute);
      if (!value) continue;
      const rewritten = await inlineUrl(value, effectiveOwner);
      if (rewritten !== value) tag.removeAttr('integrity crossorigin').attr(attribute, rewritten);
    }
  }

  for (const element of $('[srcset]').toArray()) {
    const tag = $(element);
    const srcset = tag.attr('srcset') ?? '';
    const rewritten: string[] = [];
    for (const { url, descriptor } of parseSrcset(srcset)) {
      rewritten.push(`${await inlineUrl(url, effectiveOwner)}${descriptor ? ` ${descriptor}` : ''}`);
    }
    if (rewritten.length) tag.attr('srcset', rewritten.join(', '));
  }

  for (const element of $('link[rel="preload"], link[rel="modulepreload"]').toArray()) {
    const tag = $(element);
    const href = tag.attr('href');
    if (!href) continue;
    const result = await resolve(href, effectiveOwner);
    if (result.kind === 'file') tag.remove();
  }

  let html = $.html();
  html = injectStandaloneDeckKeyDedupe(html);
  const fontResult = await embedUsedSystemFonts(html, [], {
    maxTotalBytes: Math.max(0, MAX_STANDALONE_HTML_BYTES - Buffer.byteLength(html, 'utf8')),
  });
  html = fontResult.html;
  const outputBytes = Buffer.byteLength(html, 'utf8');
  if (outputBytes > MAX_STANDALONE_HTML_BYTES) {
    throw new StandaloneHtmlLimitError(`standalone HTML exceeds ${MAX_STANDALONE_HTML_BYTES} bytes`);
  }
  return {
    html,
    outputBytes,
    externalReferences: [...external],
    missingLocalReferences: [...missing],
    skippedSystemFonts: fontResult.skipped,
  };
}
