import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load, type CheerioAPI } from 'cheerio';

export type TemplateViewport = { width: number; height: number };
export const DEFAULT_TEMPLATE_VIEWPORT: TemplateViewport = { width: 1920, height: 1080 };
/** css: a canvas node resolved both sizes; meta: numeric viewport metadata; default: neither. */
export type TemplateViewportSource = 'css' | 'meta' | 'default';
/** generic: the size came from an arbitrary top-level element (`body > *`) holding less text than the rest of the page, like a hero banner. */
export type SourcedTemplateViewport = TemplateViewport & { source: TemplateViewportSource; generic?: true };
/** Reads a confined absolute path; null counts as a missing file. */
export type TemplateTextReader = (file: string) => Promise<string | null>;

const CANVAS_CANDIDATES = ['#deck-stage', '.deck-stage', '.slide', '.page', '.canvas', '.artboard', '.screen', 'main', 'body > *', 'body', 'html'];
const GENERIC_CANDIDATE = 'body > *';
const CANVAS_PROPERTIES = new Set(['width', 'height']);
// ponytail: a flat cap on weighted selector work per page (one unit ~ one node check, ~0.15 s in
// all); a selector that no longer fits matches nothing. The heaviest bundled example uses 40%.
const MATCH_BUDGET = 2_000_000;
// Compiling a selector costs about as much as 40-50 node checks (measured with cheerio's filter).
const COMPILE_COST = 50;
/** Pages nested deeper than this are not templates; their selector walks and text are not analysed. */
export const MAX_DOM_DEPTH = 256;
/** A real px value is short; longer var() expansions are a nested fan-out and resolve to nothing. */
const MAX_EXPANDED_LENGTH = 256;
const VARIABLE_REFERENCE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g;
const NON_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

type CheerioElement = ReturnType<ReturnType<CheerioAPI['root']>['children']>[number];
type CheerioNode = CheerioElement | NonNullable<CheerioElement['parent']> | CheerioElement['children'][number];

// ---- Hard input caps, checked before cheerio/parse5 runs (parse5 is quadratic in nesting depth).
// A page past any cap is skipped: the classifier gets no vote from it, the viewport uses the default.
/** One page's HTML in UTF-8 bytes (bundled examples peak at 94,499; the classifier's reader also drops inlined base64 first). */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Start tags on one page (bundled examples peak at 901). */
export const MAX_PAGE_ELEMENTS = 50_000;
/** Open-element depth from the pre-parse scan (bundled examples peak at 14); MAX_DOM_DEPTH still applies after parsing. */
export const MAX_SCANNED_DEPTH = 1024;
/** Rules in one page's base CSS (bundled examples peak at 481). */
export const MAX_CSS_RULES = 20_000;

const VOID_TAGS = new Set('area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr'.split(' '));
const RAW_TEXT_TAGS = new Set('script style xmp iframe noembed noframes noscript textarea title'.split(' '));
// parse5 ignores `</x>` for a non-special x when a special element is open above it, so the scan must too.
const SPECIAL_TAGS = new Set('address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dialog dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp'.split(' '));
const SCOPE_BOUNDARY_TAGS = new Set('applet caption html table td th marquee object template svg math'.split(' '));
const RAW_TEXT_END =new Map([...RAW_TEXT_TAGS].map((name) => [name, new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')]));

/**
 * One linear pass over raw markup, before any DOM exists: the start-tag count and the deepest
 * open-element stack, modelled on parse5 closely enough to never undercount the usual tricks
 * (`<div/>` outside SVG, stray or misnested end tags). Null once either cap is passed.
 * ponytail: formatting-element reconstruction (`<p><b id=1>…</p>` then many `<div>x</div>`) can still
 * make parse5 build far more nodes than start tags; modelling the active-formatting list is the upgrade.
 */
export function scanMarkup(html: string): { elements: number; depth: number } | null {
  const stack: Array<{ name: string; special: boolean }> = [];
  const open = new Map<string, number[]>(); // name -> stack indices, innermost last
  const specials: number[] = [];
  const boundaries: number[] = [];
  let foreign = 0;
  let elements = 0;
  let deepest = 0;
  const pop = () => {
    const entry = stack.pop()!;
    open.get(entry.name)!.pop();
    if (entry.special) specials.pop();
    if (SCOPE_BOUNDARY_TAGS.has(entry.name)) boundaries.pop();
    if (entry.name === 'svg' || entry.name === 'math') foreign--;
  };
  const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    const next = html.charCodeAt(i);
    if (next === 33 /* ! */) {
      if (html.startsWith('!--', i)) {
        const close = html.indexOf('-->', i + 3);
        if (close < 0) break;
        // `<!-->` and `<!--->` close at once; otherwise the comment runs to `-->`.
        i = html.startsWith('>', i + 3) ? i + 4 : html.startsWith('->', i + 3) ? i + 5 : close + 3;
      } else {
        const close = html.indexOf('>', i);
        if (close < 0) break;
        i = close + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const close = html.indexOf('>', i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    const end = next === 47 /* / */;
    if (end) i++;
    if (!/[a-z]/i.test(html[i] ?? '')) {
      if (end) { const close = html.indexOf('>', i); if (close < 0) break; i = close + 1; }
      continue;
    }
    const nameStart = i;
    while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== '/' && html[i] !== '>') i++;
    const name = html.slice(nameStart, i).toLowerCase();
    // Attributes: a quote opens a value only right after `=`, as in the tokenizer.
    let selfClosing = false;
    let closed = false;
    while (i < n) {
      const c = html[i]!;
      if (isSpace(html.charCodeAt(i))) { i++; continue; }
      if (c === '>') { i++; closed = true; break; }
      if (c === '/') { i++; if (html[i] === '>') { i++; selfClosing = closed = true; break; } continue; }
      i++;
      while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++;
      while (i < n && isSpace(html.charCodeAt(i))) i++;
      if (html[i] !== '=') continue;
      i++;
      while (i < n && isSpace(html.charCodeAt(i))) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0) { i = n; break; }
        i = close + 1;
      } else {
        while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== '>') i++;
      }
    }
    if (!closed) break; // EOF inside a tag: parse5 drops it
    if (end) {
      const at = open.get(name);
      const index = at?.length ? at[at.length - 1]! : -1;
      if (index < 0) continue;
      const blocker = SPECIAL_TAGS.has(name) ? boundaries : specials; // scope boundaries stop special end tags
      if (blocker.length && blocker[blocker.length - 1]! > index) continue;
      while (stack.length > index) pop();
      continue;
    }
    if (++elements > MAX_PAGE_ELEMENTS) return null;
    if (VOID_TAGS.has(name) || (selfClosing && (foreign > 0 || name === 'svg' || name === 'math'))) continue;
    if (RAW_TEXT_TAGS.has(name) && foreign === 0) {
      const close = RAW_TEXT_END.get(name)!;
      close.lastIndex = i;
      const match = close.exec(html);
      if (!match) break;
      i = match.index;
      continue;
    }
    if (name === 'plaintext' && foreign === 0) break;
    const special = SPECIAL_TAGS.has(name);
    if (special) specials.push(stack.length);
    if (SCOPE_BOUNDARY_TAGS.has(name)) boundaries.push(stack.length);
    let at = open.get(name);
    if (!at) open.set(name, at = []);
    at.push(stack.length);
    stack.push({ name, special });
    if (name === 'svg' || name === 'math') foreign++;
    if (stack.length > deepest && (deepest = stack.length) > MAX_SCANNED_DEPTH) return null;
  }
  return { elements, depth: deepest };
}

/** Parses a page only when its raw markup passed every pre-parse cap and the result is not nested past MAX_DOM_DEPTH. */
export function loadTemplatePage(html: string): CheerioAPI | null {
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES || !scanMarkup(html)) return null;
  const $ = load(html);
  return domDepth($) > MAX_DOM_DEPTH ? null : $;
}

/** The deepest element nesting on the page (html = 1). */
export function domDepth($: CheerioAPI): number {
  // find('*') lists elements in document order, so a parent is always measured before its children.
  const depth = new Map<unknown, number>();
  let deepest = 0;
  for (const element of $.root().find('*').toArray()) {
    const level = (depth.get(element.parent) ?? 0) + 1;
    depth.set(element, level);
    if (level > deepest) deepest = level;
  }
  return deepest;
}

/**
 * One pass over a selector: its descendant combinators (inside :is()/:not()/:has() too) and a
 * class its subject compound requires outside any parentheses or brackets, so the matcher only
 * checks the nodes carrying it. Escaped class names are not used.
 */
function selectorShape(selector: string): { descendants: number; subjectClass: string | undefined } {
  // css-what's identifier characters: a class like `.cover-표지` or `.café` is one name.
  const className = /[\w°-￿-]+/y;
  let descendants = 0;
  let subjectClass: string | undefined;
  let nesting = 0;
  let quote = '';
  let previous = '';
  let space = false;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]!;
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = ''; continue; }
    if (/\s/.test(character)) { space = true; continue; }
    if (space && !'>+~,(['.includes(previous) && !'>+~,)]'.includes(character)) {
      descendants++;
      if (nesting === 0) subjectClass = undefined;
    }
    space = false;
    previous = character;
    if (character === '\\') index++;
    else if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') nesting++;
    else if (character === ')' || character === ']') nesting = Math.max(0, nesting - 1);
    else if (nesting === 0 && '>+~,'.includes(character)) subjectClass = undefined;
    else if (nesting === 0 && character === '.') {
      className.lastIndex = index + 1;
      const name = className.exec(selector)?.[0];
      if (!name) continue;
      index += name.length;
      if (selector[index + 1] !== '\\') subjectClass = name;
    }
  }
  return { descendants, subjectClass };
}

/**
 * Matches CSS selectors against `nodes` (throws on unsupported selectors, like cheerio's `is`).
 * Each selector is compiled once for all nodes, and one whose subject needs a class only checks
 * the nodes carrying it, so utility CSS costs about one lookup per rule instead of one per element.
 */
export function selectorMatcher<T extends CheerioElement>($: CheerioAPI, nodes: T[]): (selector: string) => T[] {
  const byClass = new Map<string, T[]>();
  for (const node of nodes) {
    for (const name of new Set((node.attribs.class ?? '').split(/\s+/))) {
      const list = byClass.get(name);
      if (list) list.push(node); else if (name) byClass.set(name, [node]);
    }
  }
  // Per node checked, a descendant combinator walks up to the page depth, sibling scans (:nth-*,
  // *-of-type, ~) the widest sibling list and subtree scans (:has, :contains) the whole page.
  const elements = $.root().find('*').toArray();
  const siblings = elements.reduce((most, element) => Math.max(most, element.parent?.children.length ?? 1), 1);
  const depth = domDepth($);
  let budget = MATCH_BUDGET;
  return (selector) => {
    const plain = /^\.([\w°-￿-]+)$/.exec(selector);
    if (plain) return byClass.get(plain[1]!) ?? [];
    const { descendants, subjectClass } = selectorShape(selector);
    const pool = subjectClass ? byClass.get(subjectClass) ?? [] : nodes;
    const scan = /:has\(|:i?contains\(/i.test(selector) ? elements.length : /:nth-|-of-type|~/i.test(selector) ? siblings : 1;
    const cost = COMPILE_COST + pool.length * (scan + descendants * depth);
    if (!pool.length || cost > budget) return [];
    budget -= cost;
    return $(pool).filter(selector).toArray() as T[];
  };
}

/** Expands var(--name, fallback) up to `passes` times; null once a value outgrows any real size. */
export function expandVariables(value: string, lookup: (name: string) => string | undefined, passes: number): string | null {
  for (let pass = 0; pass < passes && value.includes('var('); pass++) {
    let grew = value.length > MAX_EXPANDED_LENGTH;
    if (!grew) {
      value = value.replace(VARIABLE_REFERENCE, (_match, name: string, fallback: string | undefined) => {
        const resolved = lookup(name) ?? fallback ?? '';
        grew ||= resolved.length > MAX_EXPANDED_LENGTH;
        return grew ? '' : resolved;
      });
    }
    if (grew) return null;
  }
  return value;
}

/** Visible characters under `node`: non-whitespace text outside script/style/noscript/template. */
function visibleTextLength(node: CheerioNode): number {
  let count = 0;
  const stack: CheerioNode[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === 'text') count += current.data.replace(/\s+/g, '').length;
    else if ('children' in current && !('name' in current && NON_TEXT_TAGS.has(current.name))) for (const child of current.children) stack.push(child);
  }
  return count;
}

// The CSS scanners below are linear on purpose: the regexes they replace retried from every
// position of a brace-less or unterminated run, which is quadratic on a hostile template.

/** `text.replace(/<open>[\s\S]*?<close>/g, '')` in one pass; an unterminated opener keeps the rest. */
export function stripDelimited(text: string, open: string, close: string): string {
  let result = '';
  let offset = 0;
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, offset)) {
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    result += text.slice(offset, start);
    offset = end + close.length;
  }
  return result + text.slice(offset);
}

/** The matches of /([^{}]+)\{([^{}]*)\}/g (with `breakAtAt`, /([^{}@]+)…/g): each innermost brace pair and the text before it. */
export function cssRules(css: string, breakAtAt = false): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let start = 0;
  let selector = -1;
  let open = -1;
  for (let index = 0; index < css.length; index++) {
    const code = css.charCodeAt(index);
    if (code === 123 /* { */) {
      [selector, open] = index > start ? [start, index] : [-1, -1];
      start = index + 1;
    } else if (code === 125 /* } */) {
      if (open >= 0) rules.push({ selector: css.slice(selector, open), body: css.slice(open + 1, index) });
      open = -1;
      start = index + 1;
    } else if (code === 64 /* @ */ && breakAtAt) {
      start = index + 1;
    }
  }
  return rules;
}

/** The next match of /@(media|supports|container)\b([^{}]*)\{/gi at or after `from`; `body` is the index after its '{'. */
export function nextConditionalBlock(css: string, from: number): { index: number; kind: string; prelude: string; body: number } | null {
  const at = /@(media|supports|container)\b/gi;
  const brace = /[{}]/g;
  at.lastIndex = from;
  for (let match = at.exec(css); match; match = at.exec(css)) {
    brace.lastIndex = at.lastIndex;
    const next = brace.exec(css);
    if (!next) return null;
    if (next[0] === '{') return { index: match.index, kind: match[1]!.toLowerCase(), prelude: css.slice(at.lastIndex, next.index), body: next.index + 1 };
    // Every occurrence before this '}' reaches it first too.
    at.lastIndex = next.index + 1;
  }
  return null;
}

/** `value.replace(/\s*!important\s*$/i, '').trim()` without the regex's quadratic whitespace retries. */
export function withoutImportant(value: string): string {
  const trimmed = value.trim();
  return /!important$/i.test(trimmed) ? trimmed.slice(0, -'!important'.length).trim() : trimmed;
}

function baseCanvasStyles(css: string): string {
  let result = '';
  let offset = 0;
  for (let block = nextConditionalBlock(css, 0); block; block = nextConditionalBlock(css, offset)) {
    result += css.slice(offset, block.index);
    let depth = 1;
    let quote = '';
    let cursor = block.body;
    for (; cursor < css.length && depth > 0; cursor++) {
      const character = css[cursor]!;
      if (character === '\\') { cursor++; continue; }
      if (quote) { if (character === quote) quote = ''; continue; }
      if (character === '"' || character === "'") quote = character;
      else if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    offset = cursor;
  }
  return result + css.slice(offset);
}

function selectorPriority(selector: string): number {
  const counted = selector.replace(/:where\([^()]*\)/g, '');
  return (counted.match(/#[\w-]+/g)?.length ?? 0) * 10_000
    // `[^\][]` keeps a bracket-heavy attribute value from rescanning to its end from every '['.
    + (counted.match(/\.[\w-]+|\[[^\][]+\]|:(?!:)[\w-]+/g)?.length ?? 0) * 100
    + (counted.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
}

/** A fixed template canvas keeps its authored size; responsive pages keep the existing viewport. */
export async function readTemplatePageViewport(pagesDir: string, file: string): Promise<TemplateViewport> {
  const { width, height } = await readTemplatePageViewportWithSource(pagesDir, file);
  return { width, height };
}

/**
 * Same as readTemplatePageViewport, plus where the size came from (the type classifier only trusts authored sizes).
 * `read` lets the classifier apply its size cap and share its file cache.
 */
export async function readTemplatePageViewportWithSource(
  pagesDir: string,
  file: string,
  read: TemplateTextReader = (target) => readFile(target, 'utf8'),
): Promise<SourcedTemplateViewport> {
  const fallback: SourcedTemplateViewport = { ...DEFAULT_TEMPLATE_VIEWPORT, source: 'default' };
  const root = path.resolve(pagesDir);
  const localFile = (name: string) => {
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
  };
  const pagePath = localFile(file);
  if (!pagePath) return fallback;
  const html = await read(pagePath);
  if (html === null) return fallback;
  const $ = loadTemplatePage(html);
  if (!$) return fallback;
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
    let css: string | null;
    try { css = await read(target); } catch { return; }
    if (css === null) return;
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) await readCss(match[1]!, name);
    styles.push(css);
  };
  for (const node of $('style, link[rel~="stylesheet"]').toArray()) {
    if (node.tagName === 'style') styles.push($(node).text());
    else await readCss($(node).attr('href') ?? '', file);
  }
  const declarations = (text: string): Record<string, string> => Object.fromEntries(
    [...text.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((match) => [match[1]!.startsWith('--') ? match[1]! : match[1]!.toLowerCase(), match[2]!.trim()]),
  );
  // Breakpoint overrides describe responsive variants, not the template's base canvas. Only
  // width, height and custom properties are ever read, so other declarations are dropped here.
  const parsedRules = cssRules(baseCanvasStyles(stripDelimited(styles.join('\n'), '/*', '*/')));
  if (parsedRules.length > MAX_CSS_RULES) return fallback;
  const rules = parsedRules
    .map((rule) => ({ selectors: rule.selector.trim().split(','), values: Object.fromEntries(Object.entries(declarations(rule.body)).filter(([name]) => name.startsWith('--') || CANVAS_PROPERTIES.has(name))) }))
    .filter((rule) => Object.keys(rule.values).length > 0);
  const candidates = new Map<CheerioElement, string>();
  for (const selector of CANVAS_CANDIDATES) for (const node of $.root().find(selector).toArray()) if (!candidates.has(node)) candidates.set(node, selector);
  // The cascade is resolved up front for every node it can read (the candidates and their
  // ancestors), one selector at a time, instead of once per node and rule. Each ancestor walk
  // stops at a node already collected, so nested candidates stay linear.
  const collected = new Set<CheerioElement>();
  for (const candidate of candidates.keys()) {
    for (let node: CheerioNode | null = candidate; node && node.type !== 'root' && !collected.has(node as CheerioElement); node = node.parent) collected.add(node as CheerioElement);
  }
  const needed = [...collected];
  const chosenByNode = new Map(needed.map((node) => [node, new Map<string, { value: string; priority: number }>()]));
  const apply = (chosen: Map<string, { value: string; priority: number }>, values: Record<string, string>, specificity: number) => {
    for (const [name, raw] of Object.entries(values)) {
      const priority = specificity + (/!important\s*$/i.test(raw) ? 1_000_000_000 : 0);
      if (priority >= (chosen.get(name)?.priority ?? -1)) chosen.set(name, { value: withoutImportant(raw), priority });
    }
  };
  const match = selectorMatcher($, needed);
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      let matched: CheerioElement[];
      try { matched = match(selector.trim()); } catch { continue; /* Unsupported selectors do not define a canvas. */ }
      if (!matched.length) continue;
      const priority = selectorPriority(selector.trim());
      for (const node of matched) apply(chosenByNode.get(node)!, rule.values, priority);
    }
  }
  const resolved = new Map<CheerioElement, Record<string, string>>();
  const properties = (node: CheerioElement): Record<string, string> => {
    const cached = resolved.get(node);
    if (cached) return cached;
    const chosen = chosenByNode.get(node)!;
    apply(chosen, declarations($(node).attr('style') ?? ''), 1_000_000);
    const result = Object.fromEntries([...chosen].map(([name, value]) => [name, value.value]));
    resolved.set(node, result);
    return result;
  };
  const pixels = (value: string | undefined, lookup: (name: string) => string | undefined): number | null => {
    const expanded = value ? expandVariables(value, lookup, 8) : null;
    const match = expanded === null ? null : /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(expanded.trim());
    const result = match ? Number(match[1]) : 0;
    return result >= 1 && result <= 8192 ? Math.round(result) : null;
  };
  // Custom properties inherit, so the nearest declaring node wins. Each lookup is memoized on
  // every node it walked, instead of copying all ancestors' variables for every candidate.
  const inherited = new Map<CheerioElement, Map<string, string | undefined>>();
  const variable = (node: CheerioElement, name: string): string | undefined => {
    const walked: CheerioElement[] = [];
    let value: string | undefined;
    for (let current: CheerioElement | null = node; current && chosenByNode.has(current); current = current.parent as CheerioElement | null) {
      const known = inherited.get(current);
      if (known?.has(name)) { value = known.get(name); break; }
      walked.push(current);
      value = properties(current)[name];
      if (value !== undefined) break;
    }
    for (const current of walked) {
      const known = inherited.get(current) ?? new Map<string, string | undefined>();
      inherited.set(current, known.set(name, value));
    }
    return value;
  };
  for (const [node, selector] of candidates) {
    const values = properties(node);
    const lookup = (name: string) => variable(node, name);
    const width = pixels(values.width, lookup);
    const height = pixels(values.height, lookup);
    if (!width || !height) continue;
    // A top-level element is the page's canvas unless the rest of the page holds more of its text (a hero banner over prose).
    const generic = selector === GENERIC_CANDIDATE && 2 * visibleTextLength(node) < visibleTextLength(node.parent!);
    return generic ? { width, height, source: 'css', generic: true } : { width, height, source: 'css' };
  }
  const viewport = $('meta[name="viewport"]').attr('content') ?? '';
  const none = () => undefined;
  const width = pixels(/(?:^|[,;])\s*width\s*=\s*([\d.]+)/i.exec(viewport)?.[1], none);
  const height = pixels(/(?:^|[,;])\s*height\s*=\s*([\d.]+)/i.exec(viewport)?.[1], none);
  return width && height ? { width, height, source: 'meta' } : fallback;
}

export function templateThumbnailOptions(viewport: TemplateViewport) {
  const scale = 480 / Math.max(viewport.width, viewport.height);
  return { ...viewport, outWidth: Math.max(1, Math.round(viewport.width * scale)), outHeight: Math.max(1, Math.round(viewport.height * scale)) };
}
