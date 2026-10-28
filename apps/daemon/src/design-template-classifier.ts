// Deterministic deck/report detection for an uploaded design template.
// Static analysis only: no LLM, rendering, network, clock, randomness, env or
// locale-sensitive operations, so the same pages always give the same answer.
// Daemon-only; the web app receives the result through the upload contracts.
//
// Rules were tuned on plugins/_official/examples (hubType = truth): explicit
// front matter wins; otherwise only "real" pages vote (fragments, iframed
// pages, kit/component folders and link-only indexes are dropped), each page
// scores deck vs report evidence, and the template takes the page majority.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { CheerioAPI } from 'cheerio';
import type { DesignTemplateTypeDetection, UploadableDesignTemplateType } from '@readable-studio/contracts';
import { MAX_FILE_BYTES } from './claude-design-import.js';
import {
  MAX_CSS_RULES,
  cssRules,
  expandVariables,
  loadTemplatePage,
  nextConditionalBlock,
  readTemplatePageViewportWithSource,
  selectorMatcher,
  stripDelimited,
  withoutImportant,
  type SourcedTemplateViewport,
  type TemplateTextReader,
} from './design-template-viewport.js';
import { parseFrontmatter } from './frontmatter.js';

export interface DesignTemplateClassifierInput {
  /** Extracted pages/ dir; HTML, CSS and JS are read relative to it (confined, like readTemplatePageViewport). */
  pagesDir: string;
  /** PROMPT.md text (front matter + body). */
  prompt: string;
  /** HTML pages relative to pagesDir in ZIP order; pass a precomputed viewport to avoid a second parse. */
  pages: ReadonlyArray<{ file: string; viewport?: SourcedTemplateViewport }>;
}

export const MAX_CLASSIFIED_PAGES = 60;
const MAX_LINKED_FILES = 40;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Linked CSS (and, separately, JS) read for one page, in characters; files past it count as missing. */
const MAX_LINKED_CHARS_PER_PAGE = MAX_TEXT_BYTES;
/** Distinct linked stylesheets and scripts read for a whole template (bundled examples peak at 3 files, 46 KB). */
const MAX_TEMPLATE_LINKED_FILES = 200;
const MAX_TEMPLATE_LINKED_BYTES = 16 * 1024 * 1024;
const MAX_SIGNALS = 12;
const MAX_SIGNAL_LENGTH = 120;

const T = {
  slideGroupStrong: 3, // >= N repeated same-parent slide units = deck
  slideGroupWeak: 2, // 2 units + landscape/fullscreen/nav
  landscapeMin: 1.25, landscapeMax: 1.9, // 4:3 .. ~16:9
  portraitMax: 0.85, // A4 = 0.707, Letter = 0.773
  longDocText: 1500, // visible chars of a free-flowing document
  pageVoteShare: 0.6,
};

const FRONT_MATTER_KEYS = ['type', 'templateType', 'template_type', 'kind', 'hubType', 'mode'];
const NON_PAGE_DIRS = /(^|\/)(kit|components?|partials?|fragments?|includes?|snippets?|examples?|node_modules|vendor|assets?)(\/|$)/i;
const KEYWORDS_DECK = /\b(deck|slides?|presentation|pitch|keynote|powerpoint|pptx?|slideshow)\b|발표|프레젠테이션|슬라이드|PPT/i;
const KEYWORDS_REPORT = /\b(report|document|doc|whitepaper|white paper|memo|paper|article|essay|brief|resume|cv|invoice|proposal|newsletter|handbook|guide|manual|ebook|e-?guide|runbook|spec)\b|보고서|문서|리포트|논문|이력서/i;
const SLIDE_TOKEN = /^(slide|deck-slide|ppt-slide|slide-page|swiper-slide)$/;
const SLIDE_LIKE = /(^|-)slide(-|$)/;
const PAGE_TOKEN = /^(page|sheet|a4|paper|a4-page|print-page)$/;
// Only these declarations feed sizes, so other rules are never matched against nodes.
const SIZE_PROPERTIES = new Set(['width', 'min-width', 'height', 'min-height', 'max-width', 'aspect-ratio']);
const REF = { w: 1920, h: 1080 };

interface PageFeatures {
  isDocument: boolean;
  textLen: number; // visible text chars, whitespace collapsed
  headings: number;
  localLinks: number; // <a href> to local html
  iframes: string[];
  articleLike: boolean;
  groupKind: 'slide' | 'page' | 'section100' | 'sized' | 'none';
  groupSize: number;
  groupRatio: number | null; // w/h of the repeated unit when resolvable
  groupFull: boolean; // unit is 100vw/100vh/100%
  deckRuntime: string[];
  navScript: boolean; // keydown + arrow/page keys + slide/active word
  scrollSnap: boolean;
  atPage: 'none' | 'landscape' | 'portrait' | 'unknown';
  atPageSize: string;
  printCss: boolean;
  paperHint: boolean;
  proseWidth: boolean; // max-width 560..1000px on body/main/article/.container
  slideLikeClass: boolean;
  cssSlideRule: 'fullviewport' | 'canvas' | 'portrait' | 'plain' | 'none';
}

export async function classifyDesignTemplate(input: DesignTemplateClassifierInput): Promise<DesignTemplateTypeDetection> {
  try {
    return await classify(input);
  } catch (err) {
    console.warn(`[design-template-classifier] classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: 'deck', confidence: 'low', ambiguous: true, signals: ['error'] };
  }
}

async function classify(input: DesignTemplateClassifierInput): Promise<DesignTemplateTypeDetection> {
  const fm = parseFrontmatter(input.prompt).data;
  for (const key of FRONT_MATTER_KEYS) {
    const raw = fm[key];
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const type = value === 'deck' || value === 'slides' || value === 'presentation' ? 'deck'
      : value === 'report' || value === 'document' || value === 'doc' ? 'report' : null;
    if (type) return { type, confidence: 'high', ambiguous: false, signals: [`frontmatter:${key}=${value}`] };
  }

  const root = path.resolve(input.pagesDir);
  // Pages share stylesheets and scripts, and the canvas fallback re-reads the page: read each file once.
  const texts = new Map<string, Promise<string | null>>();
  // Template-wide caps on distinct linked files: past them, new files count as missing.
  let linkedFiles = 0;
  let linkedBytes = 0;
  const read: TemplateTextReader = (file) => {
    let text = texts.get(file);
    if (!text) {
      const isPage = /\.html?$/i.test(file);
      text = !isPage && (linkedFiles >= MAX_TEMPLATE_LINKED_FILES || linkedBytes >= MAX_TEMPLATE_LINKED_BYTES)
        ? Promise.resolve(null)
        : readText(file).then((value) => {
          if (isPage || value === null) return value;
          linkedFiles++;
          linkedBytes += Buffer.byteLength(value);
          return linkedBytes <= MAX_TEMPLATE_LINKED_BYTES ? value : null;
        });
      texts.set(file, text);
    }
    return text;
  };
  const raw: Array<{ path: string; features: PageFeatures; viewport: SourcedTemplateViewport | undefined }> = [];
  for (const page of input.pages.slice(0, MAX_CLASSIFIED_PAGES)) {
    const file = norm(page.file);
    const target = inside(root, file);
    const html = target ? await read(target) : null;
    const features = html === null ? null : await pageFeatures(root, file, html, read);
    if (features) raw.push({ path: file, features, viewport: page.viewport });
    await yieldToEventLoop();
  }

  // Real pages: whole documents that no other page iframes, outside kit/component folders when possible.
  const iframed = new Set<string>();
  for (const r of raw) for (const src of r.features.iframes) iframed.add(path.posix.normalize(path.posix.join(path.posix.dirname(r.path), src.split(/[?#]/)[0]!)));
  let real = raw.filter((r) => r.features.isDocument && !iframed.has(r.path));
  const dropped = raw.length - real.length;
  const outsideDirs = real.filter((r) => !NON_PAGE_DIRS.test(r.path));
  if (outsideDirs.length) real = outsideDirs;
  // Gallery/index pages: mostly links and little content beside other pages.
  if (real.length > 1) {
    const content = real.filter((r) => !(/^(index|gallery|toc|overview)\.html?$/i.test(path.posix.basename(r.path)) && r.features.localLinks >= 2 && r.features.textLen < 800));
    if (content.length) real = content;
  }
  const fmPages = Array.isArray(fm.pages)
    ? fm.pages.map((p) => (p && typeof p === 'object' && !Array.isArray(p) ? norm(String(p.file ?? '')) : '')).filter(Boolean)
    : [];
  if (fmPages.length >= 2) {
    const declared = real.filter((r) => fmPages.includes(r.path));
    if (declared.length) real = declared;
  }

  const pv: Array<{ path: string; textLen: number; deck: number; report: number; why: string[] }> = [];
  for (const r of real) {
    let viewport = r.viewport;
    if (!viewport) {
      try { viewport = await readTemplatePageViewportWithSource(root, r.path, pageReader(read, path.resolve(root, r.path))); } catch { /* unreadable page: no canvas signal */ }
      await yieldToEventLoop();
    }
    // A generic size (a top-level hero banner over more prose) is not a slide canvas.
    const canvas = viewport && viewport.source !== 'default' && !viewport.generic ? viewport.width / viewport.height : null;
    pv.push({ path: r.path, textLen: r.features.textLen, ...scorePage(r.features, canvas) });
  }

  const signals = [`pages:${raw.length} real:${real.length} dropped:${dropped}`];
  for (const p of pv.slice(0, 6)) signals.push(`${p.path} deck=${p.deck} report=${p.report}${p.why.length ? `: ${p.why.join(', ')}` : ''}`);
  // Soft hint from the author-written name/description; only breaks ties.
  const hint = `${fm.name ?? ''} ${fm.description ?? ''}`;
  const kwDeck = KEYWORDS_DECK.test(hint);
  const kwReport = KEYWORDS_REPORT.test(hint);
  const kw: UploadableDesignTemplateType | null = kwDeck && !kwReport ? 'deck' : kwReport && !kwDeck ? 'report' : null;
  if (kw) signals.push(`keyword:${kw}`);
  const done = (type: UploadableDesignTemplateType | 'ambiguous', confidence: DesignTemplateTypeDetection['confidence'], decided: string, guess?: UploadableDesignTemplateType): DesignTemplateTypeDetection => {
    const out = [...signals, `decided:${decided}`].slice(0, MAX_SIGNALS).map((s) => s.slice(0, MAX_SIGNAL_LENGTH).replace(/[\uD800-\uDBFF]$/, ''));
    return type === 'ambiguous'
      ? { type: guess ?? 'report', confidence: 'low', ambiguous: true, signals: out }
      : { type, confidence, ambiguous: false, signals: out };
  };

  const n = pv.length;
  if (n === 0) return done('ambiguous', 'low', 'no-real-pages', kw ?? 'report');
  const dShare = pv.filter((p) => p.deck >= 4 && p.deck > p.report).length / n;
  const rShare = pv.filter((p) => p.report >= 4 && p.report > p.deck).length / n;
  const reportLeaning = pv.filter((p) => p.report >= 2 && p.report > p.deck).length / n;
  if (n >= 2 && dShare >= 0.25 && reportLeaning >= 0.25) return done('ambiguous', 'low', 'mixed', dShare >= reportLeaning ? 'deck' : 'report');
  if (dShare >= T.pageVoteShare && rShare < 0.25) return done('deck', n === 1 || dShare === 1 ? 'high' : 'medium', 'page-vote');
  if (rShare >= T.pageVoteShare && dShare < 0.25) return done('report', 'high', 'page-vote');

  // No decisive page evidence: average scores, then the keyword, then text length.
  const dAvg = pv.reduce((a, p) => a + p.deck, 0) / n;
  const rAvg = pv.reduce((a, p) => a + p.report, 0) / n;
  if (kw && Math.abs(dAvg - rAvg) < 4) return done(kw, 'medium', 'keyword');
  if (dAvg >= 2 && dAvg > rAvg + 1) return done('deck', 'low', 'weak-deck');
  if (rAvg >= 2 && rAvg > dAvg + 1) return done('report', 'medium', 'weak-report');
  if (pv.reduce((a, p) => a + p.textLen, 0) / n >= T.longDocText) return done('report', 'medium', 'long-doc');
  return done('ambiguous', 'low', 'none', kw ?? 'report');
}

function scorePage(f: PageFeatures, canvas: number | null): { deck: number; report: number; why: string[] } {
  const why: string[] = [];
  let deck = 0;
  let report = 0;
  const land = f.groupRatio !== null && f.groupRatio >= T.landscapeMin && f.groupRatio <= T.landscapeMax;
  const portrait = f.groupRatio !== null && f.groupRatio < 1;
  if (f.deckRuntime.length) { deck += 6; why.push(`deck:runtime ${f.deckRuntime.join('+')}`); }
  if (f.groupKind === 'slide' && f.groupSize >= T.slideGroupStrong) { deck += 5; why.push(`deck:slide-group x${f.groupSize}`); }
  else if (f.groupKind === 'slide' && f.groupSize >= T.slideGroupWeak && (land || f.groupFull || f.navScript)) { deck += 4; why.push(`deck:slide-group x${f.groupSize}+size`); }
  if (f.groupKind === 'page' && f.groupSize >= 2) {
    if (portrait) { report += 5; why.push(`report:page-group x${f.groupSize} portrait`); }
    else if (land) { deck += 5; why.push(`deck:page-group x${f.groupSize} landscape`); }
  }
  if (f.groupKind === 'sized' && f.groupSize >= 2) {
    if (land) { deck += f.groupSize >= 3 ? 5 : 4; why.push(`deck:sized-group x${f.groupSize} landscape`); }
    else if (portrait) { report += 4; why.push(`report:sized-group x${f.groupSize} portrait`); }
  }
  if (f.groupKind === 'section100' && f.navScript) { deck += 3; why.push('deck:100vh-sections+nav'); }
  if (f.cssSlideRule === 'fullviewport' || f.cssSlideRule === 'canvas') { deck += 3; why.push(`deck:css .slide ${f.cssSlideRule}`); }
  if (f.cssSlideRule === 'portrait') { report += 3; why.push('report:css .slide portrait'); }
  if (f.navScript) { deck += 2; why.push('deck:nav-script'); }
  if (f.scrollSnap && f.groupKind !== 'none') { deck += 1; why.push('deck:scroll-snap'); }
  if (canvas !== null && canvas >= T.landscapeMin && canvas <= T.landscapeMax) { deck += 4; why.push(`deck:canvas ${canvas.toFixed(2)}`); }
  if (canvas !== null && canvas < T.portraitMax) { report += 5; why.push(`report:canvas portrait ${canvas.toFixed(2)}`); }
  if (f.atPage === 'landscape') { deck += 2; why.push('deck:@page landscape'); }
  if (f.atPage === 'portrait') { report += 5; why.push(`report:@page portrait ${f.atPageSize}`.trim()); }
  if (f.slideLikeClass && f.groupKind === 'none') { deck += 1; why.push('deck:slide-like class'); }
  if (f.paperHint) { report += 2; why.push('report:paper-size'); }
  if (f.printCss && deck === 0) { report += 1; why.push('report:print css'); }
  if (f.proseWidth) { report += 2; why.push('report:prose width'); }
  if (f.articleLike) { report += 1; why.push('report:article'); }
  if (f.groupKind === 'none' && f.textLen >= T.longDocText && f.headings >= 3) { report += 2; why.push('report:long text'); }
  return { deck, report, why };
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function inside(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
}

/** `read` for one page's stylesheets or scripts: past MAX_LINKED_CHARS_PER_PAGE in total, the rest count as missing (unread). */
function pageReader(read: TemplateTextReader, page = ''): TemplateTextReader {
  let left = MAX_LINKED_CHARS_PER_PAGE;
  return async (file) => {
    if (file === page) return read(file);
    if (left <= 0) return null;
    const text = await read(file);
    if (text !== null) left -= text.length;
    return left >= 0 ? text : null;
  };
}

// Base64 payloads (inlined images and fonts) carry no layout signal, so a deck that inlines its
// assets is still read; whatever is larger than 2 MiB without them counts as missing.
async function readText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const text = (await readFile(file, 'utf8')).replace(/;base64,[\w+/=-]+/gi, ';base64,');
    return Buffer.byteLength(text) <= MAX_TEXT_BYTES ? text : null;
  } catch {
    return null;
  }
}

// Parses the page once, reads its local stylesheets and scripts (bounded), then extracts features.
// A page nested deeper than MAX_DOM_DEPTH is not a template page and counts as unreadable.
async function pageFeatures(root: string, file: string, html: string, read: TemplateTextReader): Promise<PageFeatures | null> {
  const source = stripDelimited(html, '<!--', '-->');
  const $ = loadTemplatePage(source);
  if (!$) return null;
  const linked = new Map<string, string | null>();
  const byTarget = new Map<string, string | null>();
  // Separate allowances, so a large script bundle linked first cannot starve the stylesheets.
  const readCss = pageReader(read);
  const readJs = pageReader(read);
  for (const node of $('link[rel~="stylesheet"][href], script[src]').toArray()) {
    const href = $(node).attr('href') ?? $(node).attr('src') ?? '';
    if (linked.has(href) || /^(?:[a-z][\w+.-]*:|\/\/|\/|#)/i.test(href)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(href.split(/[?#]/)[0]!); } catch { continue; }
    const target = inside(root, path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded)));
    if (!target || (!byTarget.has(target) && byTarget.size >= MAX_LINKED_FILES)) continue;
    if (!byTarget.has(target)) byTarget.set(target, await (node.tagName === 'script' ? readJs : readCss)(target));
    linked.set(href, byTarget.get(target)!);
  }
  return extractFeatures(source, $, (href) => linked.get(href) ?? null);
}

type Lookup = (name: string) => string | undefined;

function toPx(raw: string | undefined, vars: Lookup = () => undefined): { px: number | null; full: boolean } {
  const v = raw ? expandVariables(raw, vars, 6) : null;
  if (v === null) return { px: null, full: false };
  const m = /^(\d+(?:\.\d+)?)\s*(px|mm|cm|in|pt|vw|vh|%|rem|em)?$/i.exec(v.trim());
  if (!m) return { px: null, full: false };
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const k: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, rem: 16, em: 16 };
  if (unit in k) return { px: n * k[unit]!, full: false };
  if (unit === 'vw') return { px: (n / 100) * REF.w, full: n >= 100 };
  if (unit === 'vh') return { px: (n / 100) * REF.h, full: n >= 100 };
  return { px: null, full: unit === '%' && n >= 100 };
}

function decls(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
    out[m[1]!.startsWith('--') ? m[1]! : m[1]!.toLowerCase()] = withoutImportant(m[2]!);
  }
  return out;
}

/** Drops @media/@supports/@container blocks (responsive overrides) and returns the base css plus the print css. */
function splitCss(css: string): { base: string; print: string } {
  css = stripDelimited(css, '/*', '*/');
  let base = '';
  let print = '';
  let off = 0;
  for (let block = nextConditionalBlock(css, 0); block; block = nextConditionalBlock(css, off)) {
    base += css.slice(off, block.index);
    let depth = 1;
    let c = block.body;
    for (; c < css.length && depth > 0; c++) { if (css[c] === '{') depth++; else if (css[c] === '}') depth--; }
    if (block.kind === 'media' && /\bprint\b/i.test(block.prelude)) print += css.slice(block.body, c - 1);
    off = c;
  }
  return { base: base + css.slice(off), print };
}

function extractFeatures(source: string, $: CheerioAPI, linked: (href: string) => string | null): PageFeatures | null {
  const all = $.root().find('*').toArray(); // = $('*'), typed as elements
  type El = (typeof all)[number];

  // ---- CSS: later rules win (source order, no specificity), inline style last
  const cssParts: string[] = [];
  $('style').each((_, n) => { cssParts.push($(n).text()); });
  $('link[rel~="stylesheet"]').each((_, n) => { const href = $(n).attr('href'); const css = href ? linked(href) : null; if (css) cssParts.push(css); });
  const allCss = cssParts.join('\n');
  const { base, print } = splitCss(allCss);
  const parsedRules = cssRules(base, true);
  if (parsedRules.length > MAX_CSS_RULES) return null; // checked before any selector is matched
  const rules = parsedRules.map((m) => ({ sel: m.selector.trim(), d: decls(m.body) }));
  const rootVars: Record<string, string> = {};
  for (const r of rules) if (/^(:root|html|body)$/.test(r.sel)) for (const [k, v] of Object.entries(r.d)) if (k.startsWith('--')) rootVars[k] = v;
  const sizeRules = rules.filter((r) => Object.keys(r.d).some((k) => k.startsWith('--') || SIZE_PROPERTIES.has(k)));
  // Each selector is matched once per page (source order kept per node); matching node by node
  // recompiled it for every element, which utility CSS turns into seconds per page.
  const match = selectorMatcher($, all);
  const matched = new Map<El, Record<string, string>>();
  for (const r of sizeRules) for (const s of r.sel.split(',')) {
    let nodes: El[];
    try { nodes = match(s.trim()); } catch { continue; /* unsupported selector */ }
    for (const n of nodes) { const got = matched.get(n); if (got) Object.assign(got, r.d); else matched.set(n, { ...r.d }); }
  }
  const resolved = new Map<El, Record<string, string>>();
  const props = (node: El): Record<string, string> => {
    let got = resolved.get(node);
    if (!got) resolved.set(node, got = { ...matched.get(node), ...decls(node.attribs.style ?? '') });
    return got;
  };
  // Own declarations first, then :root/html/body; a lookup instead of copying every root variable per call.
  const scope = (own: Record<string, string>): Lookup => (name) => own[name] ?? rootVars[name];
  const sizes = new Map<El, { w: number | null; h: number | null; full: boolean }>();
  const sizeOf = (node: El): { w: number | null; h: number | null; full: boolean } => {
    let size = sizes.get(node);
    if (!size) sizes.set(node, size = measure(node));
    return size;
  };
  const measure = (node: El): { w: number | null; h: number | null; full: boolean } => {
    const p = props(node);
    const vars = scope(p);
    let w = toPx(p.width ?? p['min-width'], vars).px;
    let h = toPx(p.height ?? p['min-height'], vars).px;
    const ar = p['aspect-ratio'] && /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(p['aspect-ratio'].trim());
    if (ar) {
      const r = Number(ar[1]) / Number(ar[2]);
      if (w && !h) h = w / r;
      else if (h && !w) w = h * r;
      else if (!w && !h) { w = r * 1000; h = 1000; }
    }
    const full = (/^100(vh|%)$/.test((p.height ?? p['min-height'] ?? '').trim()) || /^100vh$/.test((p['min-height'] ?? '').trim()))
      && (!p.width || /^100(vw|%)$/.test(p.width.trim()));
    return { w, h, full };
  };

  // .slide { width:100vw; height:100vh } or a fixed 16:9 rule, even with a single instance on the page
  let cssSlideRule: PageFeatures['cssSlideRule'] = 'none';
  for (const r of rules) {
    if (!r.sel.split(',').some((x) => /(^|[\s>+~])(\.slide|\.deck-slide|\.ppt-slide)(?![\w-])/.test(x.trim()) && !/::|:hover/.test(x))) continue;
    if (cssSlideRule === 'none') cssSlideRule = 'plain';
    const v = scope(r.d);
    const w = toPx(r.d.width ?? r.d['min-width'], v).px;
    const h = toPx(r.d.height ?? r.d['min-height'], v).px;
    if (/^100(vw|%)$/.test((r.d.width ?? '').trim()) && /^100(vh|%)$/.test((r.d.height ?? r.d['min-height'] ?? '').trim())) cssSlideRule = 'fullviewport';
    else if (w && h) { const q = w / h; if (q >= T.landscapeMin && q <= T.landscapeMax) cssSlideRule = 'canvas'; else if (q < T.portraitMax) cssSlideRule = 'portrait'; }
  }

  // ---- repeated same-parent units
  const tokens = (n: El) => (n.attribs.class ?? '').split(/\s+/).filter(Boolean);
  const group = (test: (t: string[], n: El) => boolean) => {
    let best: El[] = [];
    for (const parent of all) {
      const kids = $(parent).children().toArray().filter((c) => test(tokens(c), c));
      if (kids.length > best.length) best = kids;
    }
    return best;
  };
  const slides = group((t) => t.some((x) => SLIDE_TOKEN.test(x)));
  const reveal = group((_t, n) => n.tagName === 'section' && ($(n).parent().hasClass('slides') || $(n).parent()[0]?.tagName === 'deck-stage'));
  const pages = group((t) => t.some((x) => PAGE_TOKEN.test(x)));
  const sized = group((_t, n) => {
    if (!/^(section|div|article|main)$/.test(n.tagName)) return false;
    const q = sizeOf(n);
    return !!(q.w && q.h && q.w >= 480 && q.h >= 240 && !q.full);
  });
  const sections = group((_t, n) => (n.tagName === 'section' || n.tagName === 'div') && sizeOf(n).full);
  let groupKind: PageFeatures['groupKind'] = 'none';
  let nodes: El[] = [];
  if (slides.length >= 2) { groupKind = 'slide'; nodes = slides; }
  else if (reveal.length >= 2) { groupKind = 'slide'; nodes = reveal; }
  else if (pages.length >= 2) { groupKind = 'page'; nodes = pages; }
  else if (sized.length >= 2) { groupKind = 'sized'; nodes = sized; }
  else if (sections.length >= 3) { groupKind = 'section100'; nodes = sections; }
  let groupRatio: number | null = null;
  let groupFull = false;
  if (nodes.length) {
    const s = sizeOf(nodes[0]!);
    groupFull = s.full;
    if (s.w && s.h) groupRatio = s.w / s.h;
    // A slide class without its own size falls back to a sized wrapper (#deck-stage etc.).
    const parent = $(nodes[0]!).parent()[0];
    if (groupRatio === null && parent) { const ps = sizeOf(parent); if (ps.w && ps.h && ps.w / ps.h > 1.2) groupRatio = ps.w / ps.h; }
  }

  // ---- deck runtimes and navigation
  const scriptText = $('script').toArray().map((n) => {
    const src = $(n).attr('src');
    return $(n).text() + (src && !/^(?:[a-z]+:)?\/\//i.test(src) ? (linked(src) ?? '') : '');
  }).join('\n');
  const scriptSrc = $('script[src]').toArray().map((n) => ($(n).attr('src') ?? '').toLowerCase());
  const deckRuntime: string[] = [];
  if ($('#deck-stage, .deck-stage').length) deckRuntime.push('deck-stage');
  if ($('.deck-shell').length) deckRuntime.push('deck-shell');
  if ($('.deck > .slide').length) deckRuntime.push('deck>slide');
  if ($('.reveal .slides').length || scriptSrc.some((s) => /reveal(.min)?.js/.test(s)) || /Reveal\.initialize/.test(scriptText)) deckRuntime.push('reveal');
  if ($('deck-stage').length) deckRuntime.push('<deck-stage>');
  if ($('#impress').length || scriptSrc.some((s) => /impress/.test(s)) || /impress\(\)/.test(scriptText)) deckRuntime.push('impress');
  if (/swiper/i.test(scriptSrc.join(' '))) deckRuntime.push('swiper');
  const navScript = /keydown/i.test(scriptText) && /Arrow(Right|Left|Down)|PageDown|ArrowUp/.test(scriptText) && /(slide|active|current|goto|next\s*\()/i.test(scriptText);
  const scrollSnap = /scroll-snap-type/i.test(allCss) && /scroll-snap-align/i.test(allCss);

  // ---- print / paper
  // = /@page\b[^{]*\{([^}]*)\}/i, which rescans to the end from every '@page' without a block.
  const pageAt = allCss.search(/@page\b/i);
  const pageOpen = pageAt < 0 ? -1 : allCss.indexOf('{', pageAt);
  const pageClose = pageOpen < 0 ? -1 : allCss.indexOf('}', pageOpen);
  let atPage: PageFeatures['atPage'] = 'none';
  let atPageSize = '';
  if (pageClose >= 0) {
    const size = /size\s*:\s*([^;}]+)/i.exec(allCss.slice(pageOpen + 1, pageClose))?.[1]?.trim() ?? '';
    atPageSize = size.replace(/\s+/g, ' ').slice(0, 24);
    // (?<!\d): a number that fails as a whole fails from inside too, so do not retry from every digit.
    const dims = [...size.matchAll(/(?<!\d)(\d+(?:\.\d+)?)\s*(px|mm|cm|in|pt)/gi)].map((m) => toPx(m[1]! + m[2]!).px!);
    if (/a4|letter|legal|a3|a5/i.test(size)) atPage = /landscape/i.test(size) ? 'landscape' : 'portrait';
    else if (dims.length === 2) atPage = dims[0]! >= dims[1]! ? 'landscape' : 'portrait';
    else if (/landscape/i.test(size)) atPage = 'landscape';
    else if (/portrait/i.test(size)) atPage = 'portrait';
    else atPage = 'unknown';
  }
  // = /@media[^{]*print/i, one '{'-free segment at a time.
  const printCss = print.trim().length > 0 || allCss.split('{').some((seg) => { const at = seg.search(/@media/i); return at >= 0 && /print/i.test(seg.slice(at + 6)); });
  const paperHint = /\b(210mm|297mm|8\.5in|11in|794px|1123px|816px|1056px)\b/.test(allCss) || /size\s*:\s*(a4|letter)/i.test(allCss);
  let proseWidth = false;
  for (const sel of ['body', 'main', 'article', '.container', '.content', '.wrap', '.doc', '.page']) {
    const n = $.root().find(sel).toArray()[0];
    if (!n) continue;
    const p = props(n);
    const mw = toPx(p['max-width'], scope(p)).px;
    if (mw && mw >= 560 && mw <= 1000) { proseWidth = true; break; }
  }

  $('script, style, noscript, template').remove();
  return {
    isDocument: /<\s*(html|body)\b/i.test(source) || /<!doctype/i.test(source),
    textLen: $('body').text().replace(/\s+/g, ' ').trim().length || $.root().text().replace(/\s+/g, ' ').trim().length,
    headings: $('h1,h2,h3,h4').length,
    localLinks: $('a[href]').toArray().map((n) => $(n).attr('href') ?? '').filter((h) => /\.html?(?:[#?][\s\S]*)?$/i.test(h) && !/^[a-z]+:/i.test(h)).length,
    iframes: $('iframe[src]').toArray().map((n) => $(n).attr('src') ?? ''),
    articleLike: $('article').length > 0,
    groupKind,
    groupSize: nodes.length,
    groupRatio,
    groupFull,
    deckRuntime,
    navScript,
    scrollSnap,
    atPage,
    atPageSize,
    printCss,
    paperHint,
    proseWidth,
    slideLikeClass: $.root().find('*').toArray().some((n) => tokens(n).some((t) => SLIDE_LIKE.test(t))),
    cssSlideRule,
  };
}
