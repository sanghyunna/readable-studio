// Deterministic deck/report detection for uploaded templates. The bundled
// examples (hubType from readable-studio.json) are the labelled corpus; the
// synthetic cases re-create the prototype's stress set inline.
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { load } from 'cheerio';
import type { DesignTemplateTypeDetection } from '@readable-studio/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_CLASSIFIED_PAGES, classifyDesignTemplate } from '../src/design-template-classifier.js';
import { kitTemplateEntries, validTemplateEntries } from './helpers/template-zip.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const examplesRoot = path.resolve(__dirname, '../../../plugins/_official/examples');
const PROMPT = '---\nname: Imported Template\n---\nbody\n';
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Entry = { name: string; body: string | Buffer };
interface CorpusRow { id: string; truth: string; ms: number; detection: DesignTemplateTypeDetection }

async function classifyCorpus(): Promise<CorpusRow[]> {
  const rows: CorpusRow[] = [];
  for (const id of readdirSync(examplesRoot).sort(byCodeUnit)) {
    const dir = path.join(examplesRoot, id);
    let truth: string;
    try {
      truth = (JSON.parse(readFileSync(path.join(dir, 'readable-studio.json'), 'utf8')) as { readable?: { hubType?: string } }).readable?.hubType ?? 'none';
    } catch { continue; }
    const pages = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => /\.html?$/i.test(file))
      .sort(byCodeUnit);
    if (!pages.length) continue;
    const started = performance.now();
    const detection = await classifyDesignTemplate({ pagesDir: dir, prompt: PROMPT, pages: pages.map((file) => ({ file })) });
    rows.push({ id, truth, ms: performance.now() - started, detection });
  }
  return rows;
}

const tempDirs: string[] = [];
afterAll(async () => { await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

async function classifyEntries(entries: Entry[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'template-classifier-'));
  tempDirs.push(dir);
  let prompt = '';
  const pages: { file: string }[] = [];
  for (const entry of entries) {
    if (entry.name === 'PROMPT.md') { prompt = String(entry.body); continue; }
    const target = path.join(dir, entry.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.body);
    if (/\.html?$/i.test(entry.name)) pages.push({ file: entry.name });
  }
  return classifyDesignTemplate({ pagesDir: dir, prompt, pages });
}

const example = (id: string) => readFileSync(path.join(examplesRoot, id, 'example.html'), 'utf8');
const prompt = (name: string, extra = '') => ({ name: 'PROMPT.md', body: `---\nname: ${name}\n${extra}---\nbody\n` });

// One slide per file: keep exactly one .slide sibling of the first group.
function perSlide(html: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const $ = load(html);
    const slides = $('.deck > .slide, .deck-stage > .slide, body > .slide, .slide').toArray();
    slides.filter((slide) => slide.parent === slides[0]!.parent).forEach((slide, j) => { if (j !== i) $(slide).remove(); });
    return $.html();
  });
}

describe('bundled example corpus', () => {
  let rows: CorpusRow[];
  beforeAll(async () => { rows = await classifyCorpus(); }, 120_000);

  it('never confidently mislabels a deck or report example and guesses all of them right', () => {
    const scored = rows.filter((row) => row.truth === 'deck' || row.truth === 'report');
    expect(scored.length).toBeGreaterThanOrEqual(70);
    const label = (row: CorpusRow) => `${row.id} (${row.truth}) → ${row.detection.type} ${row.detection.confidence}: ${row.detection.signals.join(' | ')}`;
    expect(scored.filter((row) => !row.detection.ambiguous && row.detection.type !== row.truth).map(label)).toEqual([]);
    expect(scored.filter((row) => row.detection.type !== row.truth).map(label)).toEqual([]);
    expect(scored.filter((row) => row.detection.ambiguous).length).toBeLessThanOrEqual(3);
  });

  it('never calls a website example a confident deck', () => {
    const websites = rows.filter((row) => row.truth === 'website');
    expect(websites.length).toBeGreaterThan(0);
    expect(websites.filter((row) => row.detection.type === 'deck' && !row.detection.ambiguous).map((row) => row.id)).toEqual([]);
  });

  it('keeps signals short, bounded and free of absolute paths', () => {
    for (const { detection } of rows) {
      expect(detection.signals.length).toBeLessThanOrEqual(12);
      for (const signal of detection.signals) {
        expect(signal.length).toBeLessThanOrEqual(120);
        expect(signal).not.toContain(examplesRoot);
        expect(signal).not.toMatch(/[A-Za-z]:[\\/]|\\/);
      }
      if (detection.ambiguous) expect(detection.confidence).toBe('low');
    }
  });

  it('is deterministic across runs', async () => {
    const again = await classifyCorpus();
    expect(JSON.stringify(again.map((row) => [row.id, row.detection]))).toBe(JSON.stringify(rows.map((row) => [row.id, row.detection])));
    if (process.env.CLASSIFIER_TIMING) {
      const times = rows.map((row) => row.ms).sort((a, b) => a - b);
      console.log(`[classifier timing] n=${times.length} median=${times[times.length >> 1]!.toFixed(1)}ms max=${times[times.length - 1]!.toFixed(1)}ms`);
    }
  }, 120_000);
});

describe('synthetic layouts', () => {
  const reports = ['finance-report', 'blog-post', 'pm-spec', 'meeting-notes', 'eng-runbook', 'critique'];

  it.each(['html-ppt-pitch-deck', 'html-ppt-zhangzara-grove', 'ppt-keynote', 'weekly-update'])('one slide per file (%s) is a deck', async (id) => {
    const pages = perSlide(example(id), 4).map((body, i) => ({ name: `slide-${i + 1}.html`, body }));
    expect(await classifyEntries([prompt('Pack'), ...pages])).toMatchObject({ type: 'deck', ambiguous: false });
  });

  it.each([
    ['a .container', (i: number) => `<!doctype html><html><head><style>body{margin:0}.container{width:1280px;height:720px;padding:48px}</style></head><body><div class="container"><h1>Slide ${i}</h1><ul><li>Point</li><li>Point</li></ul></div></body></html>`],
    ['an inline style', (i: number) => `<!doctype html><html><body style="margin:0"><div style="width:1920px;height:1080px"><h1>Slide ${i}</h1><p>Key message</p></div></body></html>`],
    ['#stage', (i: number) => `<!doctype html><html><head><style>#stage{width:1920px;height:1080px}</style></head><body><div id="stage"><h1>Slide ${i}</h1></div><script>/* deck runtime */</script></body></html>`],
  ])('one slide per file sized by %s on a body-level element is a deck', async (_name, slide) => {
    const pages = [1, 2, 3, 4].map((i) => ({ name: `slide-${i}.html`, body: slide(i) }));
    expect(await classifyEntries([prompt('Quarterly Pack'), ...pages])).toMatchObject({ type: 'deck', ambiguous: false });
  });

  it('ignores fragment kits and gallery indexes beside a deck', async () => {
    const deck = { name: 'deck.html', body: example('html-ppt-pitch-deck') };
    const fragments = Array.from({ length: 10 }, (_, i) => ({ name: `kit/components/card-${i}.html`, body: `<div class="card"><h3>Card ${i}</h3><p>fragment</p></div>` }));
    expect(await classifyEntries([prompt('Pack'), deck, ...fragments])).toMatchObject({ type: 'deck', ambiguous: false });
    const docs = Array.from({ length: 10 }, (_, i) => ({ name: `components/btn-${i}.html`, body: `<!doctype html><html><body><button class="b">Btn ${i}</button></body></html>` }));
    const index = { name: 'index.html', body: '<!doctype html><html><body><a href="deck.html">deck</a><a href="components/btn-1.html">b</a><a href="components/btn-2.html">c</a></body></html>' };
    expect(await classifyEntries([prompt('Pack'), deck, ...docs, index])).toMatchObject({ type: 'deck', ambiguous: false });
  });

  it('reads report kits in a kit/ folder or at the root as reports', async () => {
    expect(await classifyEntries([prompt('Pack'), ...reports.map((id) => ({ name: `kit/${id}.html`, body: example(id) }))])).toMatchObject({ type: 'report', ambiguous: false });
    expect(await classifyEntries([prompt('Pack'), ...reports.map((id) => ({ name: `${id}.html`, body: example(id) }))])).toMatchObject({ type: 'report', ambiguous: false });
  });

  it('uses the page canvas: A4 pages are a report, fixed 16:9 pages a deck', async () => {
    const a4 = (i: number) => `<!doctype html><html><head><style>@page{size:A4}body{margin:0}.page{width:210mm;height:297mm;padding:20mm}</style></head><body><div class="page"><h1>Section ${i}</h1><p>text</p></div></body></html>`;
    const a4Result = await classifyEntries([prompt('Pack'), ...[1, 2, 3, 4].map((i) => ({ name: `p${i}.html`, body: a4(i) }))]);
    expect(a4Result).toMatchObject({ type: 'report', ambiguous: false });
    expect(a4Result.signals.some((signal) => signal.includes('report:@page portrait A4'))).toBe(true);
    const slide = (i: number) => `<!doctype html><html><head><style>html,body{margin:0}.slide{width:1920px;height:1080px}</style></head><body><div class="slide"><h1>S ${i}</h1></div></body></html>`;
    expect(await classifyEntries([prompt('Pack'), ...[1, 2, 3, 4].map((i) => ({ name: `s${i}.html`, body: slide(i) }))])).toMatchObject({ type: 'deck', ambiguous: false });
    const main = (i: number) => `<!doctype html><html><head><style>body{margin:0}main{width:1280px;height:720px}</style></head><body><main><h1>S ${i}</h1></main></body></html>`;
    expect(await classifyEntries([prompt('Pack'), ...[1, 2, 3].map((i) => ({ name: `s${i}.html`, body: main(i) }))])).toMatchObject({ type: 'deck', ambiguous: false });
  });

  it('detects single-file reveal.js, impress.js and 16:9 section decks', async () => {
    const reveal = '<!doctype html><html><head><link rel="stylesheet" href="https://cdn/reveal.css"><script src="https://cdn/reveal.js"></script></head><body><div class="reveal"><div class="slides"><section>A</section><section>B</section><section>C</section></div></div><script>Reveal.initialize()</script></body></html>';
    expect(await classifyEntries([prompt('Pack'), { name: 'index.html', body: reveal }])).toMatchObject({ type: 'deck', ambiguous: false });
    const impress = '<!doctype html><html><body><div id="impress"><div class="step" data-x="0">A</div><div class="step" data-x="1000">B</div></div><script src="impress.js"></script><script>impress().init()</script></body></html>';
    expect(await classifyEntries([prompt('Pack'), { name: 'index.html', body: impress }])).toMatchObject({ type: 'deck', ambiguous: false });
    const sections = '<!doctype html><html><head><style>section{width:1920px;height:1080px;position:relative}</style></head><body>' + [1, 2, 3, 4, 5].map((i) => `<section><h1>${i}</h1></section>`).join('') + '</body></html>';
    expect(await classifyEntries([prompt('Pack'), { name: 'index.html', body: sections }])).toMatchObject({ type: 'deck', ambiguous: false });
  });

  it('does not take scroll-reveal landing pages or decorative .slide classes for decks', async () => {
    const landing = await classifyEntries([prompt('Pack'), { name: 'index.html', body: example('liquid-glass-agency') }]);
    expect(landing.type === 'deck' && !landing.ambiguous).toBe(false);
    const decorated = example('finance-report').replace('</body>', '<div class="slide-icon">i</div><span class="slide">x</span></body>');
    expect(await classifyEntries([prompt('Pack'), { name: 'index.html', body: decorated }])).toMatchObject({ type: 'report', ambiguous: false });
  });

  it('flags a kit mixing decks and reports as ambiguous', async () => {
    const decks = ['html-ppt-pitch-deck', 'ppt-keynote', 'simple-deck'].map((id) => ({ name: `d-${id}.html`, body: example(id) }));
    const mixed = await classifyEntries([prompt('Pack'), ...decks, ...reports.slice(0, 3).map((id) => ({ name: `r-${id}.html`, body: example(id) }))]);
    expect(mixed).toMatchObject({ ambiguous: true, confidence: 'low' });
  });

  it('classifies the shared test fixtures', async () => {
    expect(await classifyEntries(kitTemplateEntries())).toMatchObject({ type: 'report' });
    expect(await classifyEntries(validTemplateEntries())).toMatchObject({ type: 'deck' });
  });
});

describe('front matter', () => {
  it('wins over page evidence', async () => {
    const deck = { name: 'deck.html', body: example('html-ppt-pitch-deck') };
    expect(await classifyEntries([prompt('Pack', 'type: report\n'), deck]))
      .toEqual({ type: 'report', confidence: 'high', ambiguous: false, signals: ['frontmatter:type=report'] });
    expect(await classifyEntries([prompt('Pack', 'type: deck\n'), { name: 'a.html', body: '<!doctype html><h1>x</h1>' }]))
      .toEqual({ type: 'deck', confidence: 'high', ambiguous: false, signals: ['frontmatter:type=deck'] });
  });

  it('checks the keys in order, normalises values and skips website or unknown values', async () => {
    const page = { name: 'a.html', body: '<!doctype html><h1>x</h1>' };
    expect(await classifyEntries([prompt('Pack', 'type: website\ntemplateType: " Document "\nkind: slides\n'), page]))
      .toMatchObject({ type: 'report', signals: ['frontmatter:templateType=document'] });
    expect(await classifyEntries([prompt('Pack', 'hubType: Presentation\nmode: report\n'), page]))
      .toMatchObject({ type: 'deck', signals: ['frontmatter:hubType=presentation'] });
    const fallthrough = await classifyEntries([prompt('Pack', 'type: website\nkind: poster\n'), page]);
    expect(fallthrough.signals.some((signal) => signal.startsWith('frontmatter:'))).toBe(false);
  });

  it('lets only the pages it declares vote', async () => {
    const deck = example('html-ppt-pitch-deck');
    const pages = [{ name: 'a.html', body: deck }, { name: 'b.html', body: deck }, { name: 'c.html', body: example('finance-report') }];
    // Undeclared, the report page makes the kit mixed.
    expect(await classifyEntries([prompt('Pack'), ...pages])).toMatchObject({ ambiguous: true });
    const declared = await classifyEntries([prompt('Pack', 'pages:\n  - file: a.html\n  - file: b.html\n'), ...pages]);
    expect(declared).toMatchObject({ type: 'deck', confidence: 'high', ambiguous: false });
    expect(declared.signals[0]).toBe('pages:3 real:2 dropped:0');
    expect(declared.signals.join('\n')).not.toContain('c.html');
  });
});

describe('bounds and failure handling', () => {
  const deckPage = '<!doctype html><html><body><div id="deck-stage"><section class="slide">1</section><section class="slide">2</section><section class="slide">3</section></div></body></html>';

  it(`analyses only the first ${MAX_CLASSIFIED_PAGES} pages in input order`, async () => {
    const fragments = Array.from({ length: MAX_CLASSIFIED_PAGES }, (_, i) => ({ name: `f-${String(i).padStart(2, '0')}.html`, body: `<p>fragment ${i}</p>` }));
    // Last in input order but first in sorted order, so sorting before the cut would let it in.
    const result = await classifyEntries([prompt('Pack'), ...fragments, { name: 'a-deck.html', body: deckPage }]);
    expect(result).toMatchObject({ ambiguous: true });
    expect(result.signals[0]).toBe(`pages:${MAX_CLASSIFIED_PAGES} real:0 dropped:${MAX_CLASSIFIED_PAGES}`);
  });

  it('treats oversized and missing files as absent and never reads outside pagesDir', async () => {
    const huge = deckPage.replace('</body>', `<!--${'x'.repeat(2 * 1024 * 1024)}--></body>`);
    const result = await classifyEntries([prompt('Pack'), { name: 'big.html', body: huge }]);
    expect(result).toMatchObject({ ambiguous: true });
    expect(result.signals[0]).toBe('pages:0 real:0 dropped:0');

    const root = await mkdtemp(path.join(os.tmpdir(), 'template-classifier-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'pages'));
    await writeFile(path.join(root, 'outside.css'), '@page{size:A4}');
    await writeFile(path.join(root, 'outside.html'), example('html-ppt-pitch-deck'));
    await writeFile(path.join(root, 'pages', 'a.html'), '<!doctype html><html><head><link rel="stylesheet" href="../outside.css"></head><body><p>x</p></body></html>');
    const confined = await classifyDesignTemplate({ pagesDir: path.join(root, 'pages'), prompt: PROMPT, pages: [{ file: 'missing.html' }, { file: '../outside.html' }, { file: 'a.html' }] });
    expect(confined.signals.join('\n')).not.toContain('@page');
    expect(confined.signals[0]).toBe('pages:1 real:1 dropped:0');
    expect(confined.signals.some((signal) => signal.includes('deck:'))).toBe(false);
  });

  it('reads decks whose inlined images or fonts push a file past 2 MiB', async () => {
    const payload = 'QUJD'.repeat(768 * 1024); // 3 MiB of base64
    const inlined = example('html-ppt-pitch-deck').replace('</body>', `<img alt="" src="data:image/png;base64,${payload}"></body>`);
    expect(await classifyEntries([prompt('Pack'), { name: 'deck.html', body: inlined }])).toMatchObject({ type: 'deck', ambiguous: false });
    const css = `@font-face{font-family:Brand;src:url("data:font/woff2;base64,${payload}") format("woff2")}.slide{width:1920px;height:1080px}`;
    const page = '<!doctype html><html><head><link rel="stylesheet" href="deck.css"></head><body><section class="slide"><h1>A</h1></section><section class="slide"><h1>B</h1></section></body></html>';
    const linked = await classifyEntries([prompt('Pack'), { name: 'deck.css', body: css }, { name: 'index.html', body: page }]);
    expect(linked).toMatchObject({ type: 'deck', ambiguous: false });
    expect(linked.signals.join('\n')).toContain('deck:canvas 1.78');
  });

  it('reads at most 40 linked files per page', async () => {
    const page = (atPage: number) => {
      const sheets = Array.from({ length: 41 }, (_, i) => ({ name: `s${String(i).padStart(2, '0')}.css`, body: i === atPage ? '@page{size:A4}' : `.c${i}{color:red}` }));
      const links = sheets.map((sheet) => `<link rel="stylesheet" href="${sheet.name}">`).join('');
      return [...sheets, { name: 'index.html', body: `<!doctype html><html><head>${links}</head><body><p>x</p></body></html>` }];
    };
    expect((await classifyEntries([prompt('Pack'), ...page(39)])).signals.join('\n')).toContain('report:@page portrait A4');
    expect((await classifyEntries([prompt('Pack'), ...page(40)])).signals.join('\n')).not.toContain('@page');
  });

  it('caps the canvas read too: a stylesheet over 2 MiB gives no canvas signal', async () => {
    const css = `.slide{width:1920px;height:1080px}/*${'x'.repeat(2 * 1024 * 1024)}*/`;
    const page = '<!doctype html><html><head><link rel="stylesheet" href="big.css"></head><body><div class="slide"><h1>One</h1></div></body></html>';
    const result = await classifyEntries([prompt('Pack'), { name: 'big.css', body: css }, { name: 'index.html', body: page }]);
    expect(result.signals.some((signal) => signal.includes('canvas'))).toBe(false);
  });

  it('does not take a fixed-size hero banner for a slide canvas', async () => {
    const prose = Array.from({ length: 6 }, (_, i) => `<h2>Part ${i}</h2><p>${'Quarterly revenue grew across all regions. '.repeat(12)}</p>`).join('');
    const page = `<!doctype html><html><head><style>body{margin:0}.hero{width:1440px;height:800px}</style></head><body><div class="hero"><h1>Annual review</h1></div>${prose}</body></html>`;
    const result = await classifyEntries([prompt('Pack'), { name: 'index.html', body: page }]);
    expect(result.type === 'deck' && !result.ambiguous).toBe(false);
    expect(result.signals.some((signal) => signal.includes('canvas'))).toBe(false);
  });

  // No wall-clock assertion: a quadratic scan would blow the test timeout instead.
  it('stays linear on pathological CSS and markup', async () => {
    const big = 1024 * 1024;
    const doc = (head: string, body = '<main class="x"><p>x</p></main>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
    const pages = [
      doc(`<style>${'.x '.repeat(big / 3)}</style>`), // no braces at all
      doc(`<style>${'/* '.repeat(big / 3)}</style>`), // unterminated comment openers
      doc('', `<p>x</p>${'<!-- '.repeat(big / 5)}`),
      doc(`<style>${'@media '.repeat(big / 7)}</style>`),
      doc(`<style>${'@page '.repeat(big / 12)}${'@page{'.repeat(big / 12)}</style>`),
      doc(`<style>.x{width:1px${' '.repeat(big)}x}</style>`), // whitespace before a missing !important
      doc(`<style>@page{size:${'1'.repeat(big)}}</style>`),
      doc('', `<a href="${'.html#'.repeat(big / 6)}&#10;x">x</a>`),
    ].map((body, i) => ({ name: `p${i}.html`, body }));
    const result = await classifyEntries([prompt('Pack'), ...pages]);
    expect(result.signals[0]).toBe(`pages:${pages.length} real:${pages.length} dropped:0`);
  }, 10_000);

  it('resolves utility CSS once per page instead of once per element', async () => {
    const rules = Array.from({ length: 250 }, (_, i) => `.w-${i}{width:${i * 4}px}.h-${i}{height:${i * 3}px}.maxw-${i}{max-width:${i * 8}px}.ring-${i}{--ring:${i}px}`).join('\n');
    const cells = Array.from({ length: 3000 }, (_, i) => `<div class="w-${i % 250} h-${(i * 7) % 250} ring-${i % 250}"><span>${i}</span></div>`);
    const rows = Array.from({ length: 60 }, (_, r) => `<section class="row">${cells.slice(r * 50, r * 50 + 50).join('')}</section>`).join('');
    const page = `<!doctype html><html><head><style>${rules}</style></head><body><main>${rows}</main></body></html>`;
    // Compound selectors with a class subject, then selectors only the full matcher can answer.
    const many = Array.from({ length: 5000 }, (_, i) => `<div class="a${i}"><i>${i}</i></div>`).join('');
    const compound = `<!doctype html><html><head><style>${Array.from({ length: 5000 }, (_, i) => `.r .a${i}{width:${i}px}`).join('\n')}</style></head><body><main class="r">${many}</main></body></html>`;
    const tagged = `<!doctype html><html><head><style>${Array.from({ length: 5000 }, (_, i) => `.r div:nth-child(${i}){width:${i}px}`).join('\n')}</style></head><body><main class="r">${many}</main></body></html>`;
    const result = await classifyEntries([prompt('Pack'), ...[page, compound, tagged].map((body, i) => ({ name: `p${i}.html`, body }))]);
    expect(result.signals[0]).toBe('pages:3 real:3 dropped:0');
  }, 3_000);

  it('bounds var() fan-out and large :root variable sets', async () => {
    // Each level references the next ten times: a million-fold expansion within the allowed passes.
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const fanout = names.slice(0, -1).map((name, i) => `--${name}:${`var(--${names[i + 1]})`.repeat(10)}`).join(';');
    const nested = `<!doctype html><html><head><style>:root{${fanout};--g:1px}div,section{width:var(--a);height:var(--a)}</style></head><body><main>${'<div>x</div><section>y</section>'.repeat(1500)}</main></body></html>`;
    const vars = Array.from({ length: 20_000 }, (_, i) => `--v${i}:${i}px`).join(';');
    const wide = `<!doctype html><html><head><style>:root{${vars}}div{width:10px}</style></head><body>${'<div>x</div>'.repeat(2000)}</body></html>`;
    const result = await classifyEntries([prompt('Pack'), { name: 'nested.html', body: nested }, { name: 'wide.html', body: wide }]);
    expect(result.signals[0]).toBe('pages:2 real:2 dropped:0');
  }, 5_000);

  it('caps the linked CSS each page reads and the selectors it compiles', async () => {
    // Pages sharing four large stylesheets of cheap selectors that each need compiling.
    const sheet = (seed: number) => {
      const rules: string[] = [];
      for (let i = 0, size = 0; size < 2 * 1024 * 1024 - 64; i++) { const rule = `main div#i${seed}x${i}{width:1px}`; rules.push(rule); size += rule.length; }
      return rules.join('');
    };
    const sheets = Array.from({ length: 4 }, (_, i) => ({ name: `s${i}.css`, body: sheet(i) }));
    const links = sheets.map((entry) => `<link rel="stylesheet" href="${entry.name}">`).join('');
    const pages = Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.html`, body: `<!doctype html><html><head>${links}</head><body><main><div>${i}</div></main></body></html>` }));
    // Each page's 2 MiB of linked CSS holds ~80k rules, past MAX_CSS_RULES: skipped before any selector compiles.
    expect((await classifyEntries([prompt('Pack'), ...sheets, ...pages])).signals[0]).toBe('pages:0 real:0 dropped:0');
  }, 5_000);

  it('gives scripts their own allowance, so a large bundle linked first leaves the stylesheet readable', async () => {
    const bundle = 'x'.repeat(2 * 1024 * 1024); // the whole allowance
    const page = '<!doctype html><html><head><script src="app.js"></script><link rel="stylesheet" href="deck.css"></head><body><section class="slide"><h1>A</h1></section><section class="slide"><h1>B</h1></section></body></html>';
    const result = await classifyEntries([prompt('Pack'), { name: 'app.js', body: bundle }, { name: 'deck.css', body: '.slide{width:1920px;height:1080px}' }, { name: 'index.html', body: page }]);
    expect(result.signals.join('\n')).toContain('deck:css .slide canvas');
  });

  it('skips pages nested past the depth limit instead of failing the whole template', async () => {
    const deep = `<!doctype html><html><body>${'<div class="slide">'.repeat(3000)}x${'</div>'.repeat(3000)}</body></html>`;
    const slide = (i: number) => `<!doctype html><html><head><style>.slide{width:1920px;height:1080px}</style></head><body><div class="slide"><h1>${i}</h1></div></body></html>`;
    const result = await classifyEntries([prompt('Pack'), { name: 'deep.html', body: deep }, ...[1, 2, 3].map((i) => ({ name: `s${i}.html`, body: slide(i) }))]);
    expect(result).toMatchObject({ type: 'deck', ambiguous: false });
    expect(result.signals[0]).toBe('pages:3 real:3 dropped:0');
  }, 5_000);

  // Hostile pages are skipped before cheerio parses them; the other pages still vote.
  it.each([
    ['300k-deep nesting', `<!doctype html><html><body>${'<div class="slide">'.repeat(300_000)}</body></html>`],
    ['misnested span/div end tags', `<!doctype html><html><body>${'<span><div></span>'.repeat(100_000)}</body></html>`],
    ['a huge element count', `<!doctype html><html><body>${'<p></p>'.repeat(60_000)}</body></html>`],
    ['a huge rule count', `<!doctype html><html><head><style>${'.slide{width:1px}'.repeat(25_000)}</style></head><body><div class="slide">x</div></body></html>`],
  ])('skips a page with %s in bounded time', async (_name, hostile) => {
    const slide = (i: number) => `<!doctype html><html><head><style>.slide{width:1920px;height:1080px}</style></head><body><div class="slide"><h1>${i}</h1></div></body></html>`;
    const started = performance.now();
    const result = await classifyEntries([prompt('Pack'), { name: 'hostile.html', body: hostile }, ...[1, 2, 3].map((i) => ({ name: `s${i}.html`, body: slide(i) }))]);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ type: 'deck', ambiguous: false });
    expect(result.signals[0]).toBe('pages:3 real:3 dropped:0');
  }, 30_000);

  it('caps the distinct linked files a whole template reads', async () => {
    // 6 pages, each linking its own 40 stylesheets: past the 200-file template cap the rest count as missing.
    const entries: Array<{ name: string; body: string }> = [];
    for (let p = 0; p < 6; p++) {
      const sheets = Array.from({ length: 40 }, (_, s) => ({ name: `css/p${p}-${s}.css`, body: `.c${s}{width:1px}${s === 39 ? '@page{size:A4}' : ''}` }));
      entries.push(...sheets, { name: `p${String(p).padStart(2, '0')}.html`, body: `<!doctype html><html><head>${sheets.map((sheet) => `<link rel="stylesheet" href="${sheet.name}">`).join('')}</head><body><p>x</p></body></html>` });
    }
    const started = performance.now();
    const result = await classifyEntries([prompt('Pack'), ...entries]);
    expect(performance.now() - started).toBeLessThan(5000);
    // The first five pages' last sheets (files 40, 80 … 200) are read; the sixth page's is not.
    expect(result.signals.filter((signal) => signal.includes('@page')).length).toBe(5);
  }, 60_000);

  it('never ends a truncated signal with half a surrogate pair', async () => {
    const name = `${'a'.repeat(119)}\u{1F600}.html`;
    const result = await classifyEntries([prompt('Pack'), { name, body: '<!doctype html><html><body><p>x</p></body></html>' }]);
    expect(result.signals.find((signal) => signal.startsWith('aaa'))).toBe('a'.repeat(119));
  });

  it('uses a precomputed viewport instead of re-reading the canvas', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'template-classifier-'));
    tempDirs.push(root);
    await writeFile(path.join(root, 'a.html'), '<!doctype html><html><body><main><h1>Plain</h1></main></body></html>');
    const result = await classifyDesignTemplate({ pagesDir: root, prompt: PROMPT, pages: [{ file: 'a.html', viewport: { width: 794, height: 1123, source: 'css' } }] });
    expect(result.signals.some((signal) => signal.includes('report:canvas portrait 0.71'))).toBe(true);
    const ignored = await classifyDesignTemplate({ pagesDir: root, prompt: PROMPT, pages: [{ file: 'a.html', viewport: { width: 794, height: 1123, source: 'default' } }] });
    expect(ignored.signals.some((signal) => signal.includes('canvas'))).toBe(false);
  });

  it('returns a low-confidence deck guess instead of throwing on an internal error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await classifyDesignTemplate({ pagesDir: os.tmpdir(), prompt: PROMPT, pages: null as never }))
        .toEqual({ type: 'deck', confidence: 'low', ambiguous: true, signals: ['error'] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[design-template-classifier]'));
    } finally {
      warn.mockRestore();
    }
  });
});
