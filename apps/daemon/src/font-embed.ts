// Base64-embed the installed (non-web-safe) fonts a design actually uses
// into an export/deploy HTML so it renders the same on a machine that does
// not have those fonts.
//
// Pure + dependency-injected (`resolveFamily`, `readFontBytes`) so it unit
// tests without a real Windows font registry. Real callers wire it to
// `system-fonts.ts` + `fs`.

import type { SystemFontFace, SystemFontFamily, SystemFontFormat } from '@readable-studio/contracts';

export const MAX_SYSTEM_FONT_FACE_BYTES = 5 * 1024 * 1024;
export const MAX_SYSTEM_FONT_TOTAL_BYTES = 50 * 1024 * 1024;

export interface EmbedFontsDeps {
  /** Look up an installed family by its (case-insensitive) name; undefined if not installed. */
  resolveFamily: (name: string) => SystemFontFamily | undefined;
  /** Read a font file's bytes; return null if missing/unreadable. */
  readFontBytes: (absPath: string) => Promise<Buffer | null>;
}

export interface EmbedFontsOptions {
  /** Skip a single face larger than this (default: MAX_SYSTEM_FONT_FACE_BYTES). */
  maxAssetBytes?: number;
  /** Stop once embedded base64 output would exceed this (default: MAX_SYSTEM_FONT_TOTAL_BYTES). */
  maxTotalBytes?: number;
  /**
   * Extra raw CSS (external stylesheets) to scan for used families and
   * existing @font-face declarations, alongside the HTML itself. The deploy
   * path bundles linked CSS as separate files, so fonts used only there would
   * otherwise be missed; @font-face are injected into `html` regardless.
   */
  extraCss?: string[];
}

export interface EmbedFontsResult {
  html: string;
  /** Family names that were embedded (one entry per family, not per face). */
  embedded: string[];
  /** Family names skipped because a face exceeded a size cap or read failed. */
  skipped: string[];
}

// Universally-available primary families + generic/keyword tokens we never
// embed (they render everywhere, so embedding is pure bloat). Windows-only
// fonts (Segoe UI, Calibri, Cambria, ...) are deliberately NOT here — those
// are exactly what must travel with the export.
const NON_EMBEDDABLE_PRIMARY = new Set(
  [
    // generic families
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont',
    // css-wide keywords
    'inherit', 'initial', 'unset', 'revert', 'revert-layer', '',
    // web-safe families present on effectively every OS
    'arial', 'helvetica', 'helvetica neue', 'times', 'times new roman',
    'georgia', 'courier', 'courier new', 'verdana', 'tahoma', 'trebuchet ms',
    'sfmono-regular',
  ].map((s) => s.toLowerCase()),
);

const MIME_BY_FORMAT: Record<SystemFontFormat, string> = {
  truetype: 'font/ttf',
  opentype: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  collection: 'font/collection',
};

/** Decode the handful of HTML entities that can appear inside a `style=` attr value. */
function decodeStyleEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/** The primary (first) family token of a `font-family` value, unquoted + normalized. */
export function primaryFontFamilyToken(value: string): string {
  const first = decodeStyleEntities(value).split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Collect the distinct primary family tokens declared anywhere in the HTML:
 * `font-family:` in `<style>` blocks and in inline `style=` attributes.
 * Only the primary token matters — a curated stack's primary is web-safe (or
 * a non-Windows font that won't resolve), while a system pick's primary IS
 * the installed family. `font:` shorthand is out of scope (the manual-edit
 * picker always writes `font-family:`).
 */
/** Add every `font-family:` primary token in a raw CSS string (a <style> body or a linked stylesheet). */
function addCssFontFamilies(css: string, add: (rawValue: string) => void): void {
  const declRe = /font-family\s*:\s*([^;}]+)/gi;
  let decl: RegExpExecArray | null;
  while ((decl = declRe.exec(css))) add(decl[1] ?? '');
}

/**
 * Primary font-family tokens declared anywhere in the doc: `<style>` blocks,
 * inline `style=` attributes, and any `extraCss` (external stylesheets the
 * deploy path bundles as separate files rather than inlining — see
 * `font-embed-runtime.ts`).
 */
export function collectUsedFontFamilies(html: string, extraCss: string[] = []): string[] {
  const seen = new Set<string>();
  const add = (rawValue: string) => {
    const token = primaryFontFamilyToken(rawValue);
    if (token) seen.add(token);
  };

  // <style> blocks (raw CSS — value runs to ; or })
  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let block: RegExpExecArray | null;
  while ((block = styleBlockRe.exec(html))) addCssFontFamilies(block[1] ?? '', add);

  // inline style="..." / style='...' attributes (decode entities first)
  const attrRe = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let attr: RegExpExecArray | null;
  while ((attr = attrRe.exec(html))) {
    const styleText = decodeStyleEntities(attr[2] ?? attr[3] ?? '');
    const declRe = /font-family\s*:\s*([^;]+)/gi;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(styleText))) add(decl[1] ?? '');
  }

  for (const css of extraCss) addCssFontFamilies(css, add);

  return [...seen];
}

/** Family names already covered by an `@font-face` (in the doc or linked CSS) — never re-embed those. */
export function existingFontFaceFamilies(html: string, extraCss: string[] = []): Set<string> {
  const families = new Set<string>();
  const scan = (text: string) => {
    const faceRe = /@font-face\s*\{([^}]*)\}/gi;
    let face: RegExpExecArray | null;
    while ((face = faceRe.exec(text))) {
      const m = /font-family\s*:\s*([^;}]+)/i.exec(face[1] ?? '');
      if (m) {
        const token = primaryFontFamilyToken(m[1] ?? '');
        if (token) families.add(token.toLowerCase());
      }
    }
  };
  scan(html);
  for (const css of extraCss) scan(css);
  return families;
}

// CSS-string-quote a family name for injection into a <style> block. `\` and
// `'` are escaped for CSS-string safety; `<` and `>` are CSS-escaped as `\3C`
// / `\3E` so no literal `</style>` can reach the HTML tokenizer and break out
// of the raw-text <style> element. CSS treats `\3C` as `<`, so the value still
// computes to the same family name and the closed-loop match is preserved — a
// font whose (registry-derived) name contains `</style><script>` is neutralized
// rather than executed. See the XSS test in font-embed.test.ts.
function cssQuoteFamily(name: string): string {
  const escaped = name
    .replace(/[\\']/g, '\\$&')
    .replace(/</g, '\\3C ')
    .replace(/>/g, '\\3E ');
  return `'${escaped}'`;
}

function faceToRule(family: string, face: SystemFontFace, base64: string): string {
  const mime = MIME_BY_FORMAT[face.format];
  return (
    `@font-face{font-family:${cssQuoteFamily(family)};` +
    `font-weight:${face.weight};font-style:${face.style};font-display:swap;` +
    `src:url(data:${mime};base64,${base64}) format('${face.format}')}`
  );
}

function injectStyle(html: string, css: string): string {
  const style = `<style data-readable-embedded-fonts>${css}</style>`;
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) return html.slice(0, headClose.index) + style + html.slice(headClose.index);
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, at) + style + html.slice(at);
  }
  return style + html;
}

/**
 * Scan `html` for used non-web-safe font families, resolve each to installed
 * font files, base64-embed every available face as an `@font-face`, and
 * inject them into `<head>`. Returns the original HTML unchanged when there
 * is nothing to embed.
 */
export async function embedSystemFonts(
  html: string,
  deps: EmbedFontsDeps,
  options: EmbedFontsOptions = {},
): Promise<EmbedFontsResult> {
  const maxAssetBytes = options.maxAssetBytes ?? MAX_SYSTEM_FONT_FACE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_SYSTEM_FONT_TOTAL_BYTES;
  const extraCss = options.extraCss ?? [];

  const alreadyFaced = existingFontFaceFamilies(html, extraCss);
  const embedded: string[] = [];
  const skipped: string[] = [];
  const rules: string[] = [];
  let totalBytes = 0;

  for (const token of collectUsedFontFamilies(html, extraCss)) {
    const lower = token.toLowerCase();
    if (NON_EMBEDDABLE_PRIMARY.has(lower)) continue;
    if (alreadyFaced.has(lower)) continue;
    const family = deps.resolveFamily(token);
    if (!family || family.faces.length === 0) continue;

    const familyRules: string[] = [];
    let familyBytes = 0;
    let familySkipped = false;
    for (const face of family.faces) {
      const bytes = await deps.readFontBytes(face.path);
      if (!bytes) {
        familySkipped = true;
        continue;
      }
      if (bytes.byteLength > maxAssetBytes) {
        familySkipped = true;
        continue;
      }
      const base64 = bytes.toString('base64');
      if (totalBytes + familyBytes + base64.length > maxTotalBytes) {
        familySkipped = true;
        break; // out of total budget; stop this family
      }
      familyBytes += base64.length;
      // Emit under the resolved family name; CSS font-family matching is
      // case-insensitive, so it still matches the doc's token.
      familyRules.push(faceToRule(family.family, face, base64));
    }

    if (familyRules.length > 0) {
      rules.push(...familyRules);
      totalBytes += familyBytes;
      embedded.push(family.family);
      // Mark as faced so a second reference to the same family in a different
      // case (e.g. "Segoe UI" in the HTML and "segoe ui" in a bundled CSS)
      // isn't embedded twice — double bytes would prematurely trip the cap.
      alreadyFaced.add(family.family.toLowerCase());
    }
    if (familySkipped) skipped.push(family.family);
  }

  if (rules.length === 0) return { html, embedded, skipped };
  return { html: injectStyle(html, rules.join('')), embedded, skipped };
}
