import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';

export type TemplateViewport = { width: number; height: number };
export const DEFAULT_TEMPLATE_VIEWPORT: TemplateViewport = { width: 1920, height: 1080 };

function baseCanvasStyles(css: string): string {
  const conditional = /@(?:media|supports|container)\b[^{}]*\{/gi;
  let result = '';
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = conditional.exec(css))) {
    result += css.slice(offset, match.index);
    let depth = 1;
    let quote = '';
    let cursor = conditional.lastIndex;
    for (; cursor < css.length && depth > 0; cursor++) {
      const character = css[cursor]!;
      if (character === '\\') { cursor++; continue; }
      if (quote) { if (character === quote) quote = ''; continue; }
      if (character === '"' || character === "'") quote = character;
      else if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    offset = cursor;
    conditional.lastIndex = cursor;
  }
  return result + css.slice(offset);
}

function selectorPriority(selector: string): number {
  const counted = selector.replace(/:where\([^()]*\)/g, '');
  return (counted.match(/#[\w-]+/g)?.length ?? 0) * 10_000
    + (counted.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0) * 100
    + (counted.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
}

/** A fixed template canvas keeps its authored size; responsive pages keep the existing viewport. */
export async function readTemplatePageViewport(pagesDir: string, file: string): Promise<TemplateViewport> {
  const root = path.resolve(pagesDir);
  const localFile = (name: string) => {
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
  };
  const pagePath = localFile(file);
  if (!pagePath) return DEFAULT_TEMPLATE_VIEWPORT;
  const $ = load(await readFile(pagePath, 'utf8'));
  const styles: string[] = [];
  const seen = new Set<string>();
  const readCss = async (href: string, from: string): Promise<void> => {
    if (/^(?:[a-z][\w+.-]*:|\/\/|\/|#)/i.test(href)) return;
    let decoded: string;
    try { decoded = decodeURIComponent(href.split(/[?#]/)[0]!); } catch { return; }
    const name = path.join(path.dirname(from), decoded);
    const target = localFile(name);
    if (!target || seen.has(target) || seen.size >= 40) return;
    seen.add(target);
    let css: string;
    try { css = await readFile(target, 'utf8'); } catch { return; }
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) await readCss(match[1]!, name);
    styles.push(css);
  };
  for (const node of $('style, link[rel~="stylesheet"]').toArray()) {
    if (node.tagName === 'style') styles.push($(node).text());
    else await readCss($(node).attr('href') ?? '', file);
  }
  // Breakpoint overrides describe responsive variants, not the template's base canvas.
  const rules = baseCanvasStyles(styles.join('\n').replace(/\/\*[\s\S]*?\*\//g, '')).matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const declarations = (text: string): Record<string, string> => Object.fromEntries(
    [...text.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((match) => [match[1]!.startsWith('--') ? match[1]! : match[1]!.toLowerCase(), match[2]!.trim()]),
  );
  const parsed = [...rules].map((match) => ({ selector: match[1]!.trim(), values: declarations(match[2]!) }));
  const properties = (node: (ReturnType<typeof $>)[number]): Record<string, string> => {
    const chosen = new Map<string, { value: string; priority: number }>();
    const apply = (values: Record<string, string>, specificity: number) => {
      for (const [name, raw] of Object.entries(values)) {
        const priority = specificity + (/!important\s*$/i.test(raw) ? 1_000_000_000 : 0);
        if (priority >= (chosen.get(name)?.priority ?? -1)) chosen.set(name, { value: raw.replace(/\s*!important\s*$/i, '').trim(), priority });
      }
    };
    for (const rule of parsed) {
      for (const selector of rule.selector.split(',')) {
        try { if ($(node).is(selector.trim())) apply(rule.values, selectorPriority(selector.trim())); } catch { /* Unsupported selectors do not define a canvas. */ }
      }
    }
    apply(declarations($(node).attr('style') ?? ''), 1_000_000);
    return Object.fromEntries([...chosen].map(([name, value]) => [name, value.value]));
  };
  const pixels = (value: string | undefined, vars: Record<string, string>): number | null => {
    if (!value) return null;
    for (let depth = 0; depth < 8 && value.includes('var('); depth++) {
      value = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g, (_match, name: string, fallback: string | undefined) => vars[name] ?? fallback ?? '');
    }
    const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
    const result = match ? Number(match[1]) : 0;
    return result >= 1 && result <= 8192 ? Math.round(result) : null;
  };
  const candidates = [...new Set(['#deck-stage', '.deck-stage', '.slide', '.page', '.canvas', '.artboard', '.screen', 'main', 'body > *', 'body', 'html']
    .flatMap((selector) => $(selector).toArray()))];
  for (const node of candidates) {
    const variables: Record<string, string> = {};
    for (const ancestor of $(node).parents().toArray().reverse()) {
      Object.assign(variables, Object.fromEntries(Object.entries(properties(ancestor)).filter(([name]) => name.startsWith('--'))));
    }
    const values = properties(node);
    const vars = { ...variables, ...values };
    const width = pixels(values.width, vars);
    const height = pixels(values.height, vars);
    if (width && height) return { width, height };
  }
  const viewport = $('meta[name="viewport"]').attr('content') ?? '';
  const width = pixels(/(?:^|[,;])\s*width\s*=\s*([\d.]+)/i.exec(viewport)?.[1], {});
  const height = pixels(/(?:^|[,;])\s*height\s*=\s*([\d.]+)/i.exec(viewport)?.[1], {});
  return width && height ? { width, height } : DEFAULT_TEMPLATE_VIEWPORT;
}

export function templateThumbnailOptions(viewport: TemplateViewport) {
  const scale = 480 / Math.max(viewport.width, viewport.height);
  return { ...viewport, outWidth: Math.max(1, Math.round(viewport.width * scale)), outHeight: Math.max(1, Math.round(viewport.height * scale)) };
}
