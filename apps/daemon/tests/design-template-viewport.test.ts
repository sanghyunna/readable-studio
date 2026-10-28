import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readTemplatePageViewport } from '../src/design-template-viewport.js';
import { load } from 'cheerio';
import { MAX_DOM_DEPTH, readTemplatePageViewportWithSource, selectorMatcher } from '../src/design-template-viewport.js';
import { MAX_CSS_RULES, MAX_PAGE_BYTES, MAX_PAGE_ELEMENTS, MAX_SCANNED_DEPTH, scanMarkup } from '../src/design-template-viewport.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'template-viewport-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function viewport(css: string) {
  await writeFile(path.join(root, 'page.html'), `<style>${css}</style><main id="deck-stage" class="slide">Canvas</main>`);
  return readTemplatePageViewport(root, 'page.html');
}

it('keeps the authored canvas instead of a conditional mobile override', async () => {
  expect(await viewport('.slide{width:1280px;height:720px}@media(max-width:600px){.slide{width:375px;height:667px}}'))
    .toEqual({ width: 1280, height: 720 });
});

it('respects specificity and important dimensions instead of the last matching rule', async () => {
  expect(await viewport('#deck-stage{width:1280px;height:720px}.slide{width:1920px;height:1080px}'))
    .toEqual({ width: 1280, height: 720 });
  expect(await viewport('.slide{width:1280px!important;height:720px!important}#deck-stage{width:1920px;height:1080px}'))
    .toEqual({ width: 1280, height: 720 });
});

it('reads numeric viewport metadata when the canvas has no fixed dimensions', async () => {
  await writeFile(path.join(root, 'page.html'), '<meta name="viewport" content="width=1024,height=768"><main>Canvas</main>');
  expect(await readTemplatePageViewport(root, 'page.html')).toEqual({ width: 1024, height: 768 });
});

it('recognizes an ordinary section canvas and inherited CSS variables', async () => {
  await writeFile(path.join(root, 'page.html'), '<style>body{--pageW:1280px;--pageH:720px}section{width:var(--pageW);height:var(--pageH)}</style><section>Cover</section>');
  expect(await readTemplatePageViewport(root, 'page.html')).toEqual({ width: 1280, height: 720 });
});

it('prefers the explicit slide canvas over a fixed outer viewport', async () => {
  await writeFile(path.join(root, 'page.html'), '<style>html,body{width:1920px;height:1080px}#deck-stage{width:1280px;height:720px}</style><div id="deck-stage"><section class="slide">Canvas</section></div>');
  expect(await readTemplatePageViewport(root, 'page.html')).toEqual({ width: 1280, height: 720 });
});

it('ignores stylesheet paths outside the template and invalid canvas dimensions', async () => {
  await writeFile(path.join(root, 'page.html'), '<link rel="stylesheet" href="../outside.css"><style>main{width:999999px;height:NaN}</style><main>Canvas</main>');
  expect(await readTemplatePageViewport(root, 'page.html')).toEqual({ width: 1920, height: 1080 });
});

it('reports whether the canvas came from CSS, viewport metadata or the default', async () => {
  await writeFile(path.join(root, 'css.html'), '<style>.slide{width:1280px;height:720px}</style><div class="slide">Canvas</div>');
  await writeFile(path.join(root, 'meta.html'), '<meta name="viewport" content="width=1024,height=768"><main>Canvas</main>');
  await writeFile(path.join(root, 'fluid.html'), '<style>main{max-width:720px}</style><main>Canvas</main>');
  expect(await readTemplatePageViewportWithSource(root, 'css.html')).toEqual({ width: 1280, height: 720, source: 'css' });
  expect(await readTemplatePageViewportWithSource(root, 'meta.html')).toEqual({ width: 1024, height: 768, source: 'meta' });
  expect(await readTemplatePageViewportWithSource(root, 'fluid.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
  expect(await readTemplatePageViewportWithSource(root, '../outside.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
  // The plain variant keeps its old shape.
  expect(await readTemplatePageViewport(root, 'css.html')).toEqual({ width: 1280, height: 720 });
});

it('resolves custom properties declared on ancestors', async () => {
  const slides = Array.from({ length: 40 }, (_, i) => `<div class="card">${i}</div>`).join('');
  await writeFile(path.join(root, 'page.html'), `<style>:root{--w:1600px}html body{--h:900px}.wrap .canvas{width:var(--w);height:var(--h)}</style><div class="wrap">${slides}<section class="canvas">Canvas</section></div>`);
  expect(await readTemplatePageViewportWithSource(root, 'page.html')).toEqual({ width: 1600, height: 900, source: 'css' });
});

it('marks a top-level size as generic only when the rest of the page holds more text', async () => {
  await writeFile(path.join(root, 'hero.html'), '<style>.hero{width:1440px;height:800px}</style><div class="hero">Banner</div><p>Prose that runs longer than the banner</p><script>/* not text */</script>');
  expect(await readTemplatePageViewportWithSource(root, 'hero.html')).toEqual({ width: 1440, height: 800, source: 'css', generic: true });
  // The thumbnail size is unchanged.
  expect(await readTemplatePageViewport(root, 'hero.html')).toEqual({ width: 1440, height: 800 });
  // A slide that is the body's only element, or holds most of its text, is the canvas.
  await writeFile(path.join(root, 'only.html'), '<style>.container{width:1280px;height:720px}</style><div class="container"><h1>Slide</h1></div><script>const longScriptText = 1;</script>');
  expect(await readTemplatePageViewportWithSource(root, 'only.html')).toEqual({ width: 1280, height: 720, source: 'css' });
  await writeFile(path.join(root, 'most.html'), '<div style="width:1920px;height:1080px"><h1>Quarterly results</h1></div><footer>p. 3</footer>');
  expect(await readTemplatePageViewportWithSource(root, 'most.html')).toEqual({ width: 1920, height: 1080, source: 'css' });
});

it('reads through a supplied reader; a null read counts as missing', async () => {
  await writeFile(path.join(root, 'page.html'), '<link rel="stylesheet" href="deck.css"><div class="slide">Canvas</div>');
  await writeFile(path.join(root, 'deck.css'), '.slide{width:1280px;height:720px}');
  const reads: string[] = [];
  const skipCss = async (file: string) => { reads.push(path.basename(file)); return file.endsWith('.css') ? null : '<link rel="stylesheet" href="deck.css"><div class="slide">Canvas</div>'; };
  expect(await readTemplatePageViewportWithSource(root, 'page.html', skipCss)).toEqual({ width: 1920, height: 1080, source: 'default' });
  expect(reads).toEqual(['page.html', 'deck.css']);
  expect(await readTemplatePageViewportWithSource(root, 'page.html', async () => null)).toEqual({ width: 1920, height: 1080, source: 'default' });
});

it('matches selectors exactly like cheerio is(), also through the class shortcuts', () => {
  const $ = load('<main class="r"><div class="a b md:w-4">1</div><div class="b">2</div><p class="a">3</p></main><div class="a.b">4</div>');
  const nodes = $.root().find('*').toArray();
  const match = selectorMatcher($, nodes);
  const outcome = (run: () => unknown) => { try { return run(); } catch { return 'throws'; } };
  for (const selector of [
    '.a', '.b', '.r .a', 'div.a', '.r > .b', '.a:hover', '.md\\:w-4', '.a\\.b', 'p', 'main div', ':root', '.missing', '.r div.b.a', '<<<',
    // The subject class may sit anywhere in the last compound, never inside :not()/:is() or an attribute.
    '.r > .a[class]:nth-child(1)', '.a:not(.b)', 'div:not(.r .a)', '.r .b:first-child', '[class="a b md:w-4"]', '[class=".a x"]',
    '.b.a', '.r>.b', '.r + div', '.b ~ .a', ':is(.a, .q)', 'main :is(p, .b)', '.a.md\\:w-4', '.md\\:w-4.a', '.a .x', '.a\\ .b',
  ]) {
    expect(outcome(() => match(selector)), selector).toEqual(outcome(() => nodes.filter((node) => $(node).is(selector))));
  }
});

it('matches non-ASCII class and id names exactly like cheerio is()', () => {
  const $ = load('<main class="r"><div class="café">1</div><div class="cover-표지 a">2</div><p class="slide2슬" id="표지">3</p><i class="a b표">4</i></main>');
  const nodes = $.root().find('*').toArray();
  const match = selectorMatcher($, nodes);
  for (const selector of ['.café', '.caf', '.cover-표지', '.cover-', '.slide2슬', '.slide2', '.a.b표', '.r .café', 'div.cover-표지', '#표지', '.r > #표지', '.b표']) {
    expect(match(selector), selector).toEqual(nodes.filter((node) => $(node).is(selector)));
  }
});

it('reads a canvas sized by a non-ASCII class', async () => {
  await writeFile(path.join(root, 'cafe.html'), '<style>.café{width:1280px;height:720px}</style><div class="café">Canvas</div>');
  expect(await readTemplatePageViewportWithSource(root, 'cafe.html')).toEqual({ width: 1280, height: 720, source: 'css' });
  await writeFile(path.join(root, 'cover.html'), '<style>.cover-표지{width:1600px;height:900px}</style><section class="cover-표지">표지</section>');
  expect(await readTemplatePageViewportWithSource(root, 'cover.html')).toEqual({ width: 1600, height: 900, source: 'css' });
});

// Each cap is checked before cheerio/parse5 runs; 1.5 s leaves room for a 2 vCPU CI machine.
it.each([
  ['300k-deep nesting', () => `<style>.slide{width:1280px;height:720px}</style>${'<div class="slide">'.repeat(300_000)}`],
  ['300k self-closing divs (parse5 nests them)', () => `<style>div{width:1280px;height:720px}</style>${'<div/>'.repeat(300_000)}`],
  ['misnested span/div end tags parse5 ignores', () => `<style>div{width:1280px;height:720px}</style>${'<span><div></span>'.repeat(100_000)}`],
  ['an element count past the cap', () => `<style>p{width:1280px;height:720px}</style>${'<p></p>'.repeat(MAX_PAGE_ELEMENTS + 1)}`],
  ['a page past the byte cap', () => `<style>.slide{width:1280px;height:720px}</style><div class="slide">${'x'.repeat(MAX_PAGE_BYTES)}</div>`],
  ['a rule count past the cap', () => `<style>${'b{width:1px}'.repeat(MAX_CSS_RULES)}.slide{width:1280px;height:720px}</style><div class="slide">x</div>`],
])('skips %s before parsing, in bounded time', async (_name, page) => {
  await writeFile(path.join(root, 'capped.html'), page());
  const started = performance.now();
  expect(await readTemplatePageViewportWithSource(root, 'capped.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
  expect(performance.now() - started).toBeLessThan(1500);
}, 30_000);

it('scans markup like parse5 for the depth tricks and stays under every cap on ordinary pages', () => {
  expect(scanMarkup('<div><p>a<div>b</div></p></div>')).toEqual({ elements: 3, depth: 3 });
  expect(scanMarkup('<svg><path/><g><path/></g></svg><img><br>')).toEqual({ elements: 6, depth: 2 });
  expect(scanMarkup(`<script>${'<div>'.repeat(5000)}</script><!-- ${'<div>'.repeat(5000)} --><p>x</p>`)).toEqual({ elements: 2, depth: 1 });
  expect(scanMarkup('<span><div></span></div>'.repeat(3))!.depth).toBe(4); // parse5 keeps each span open too
  expect(scanMarkup('<span><div></span>'.repeat(MAX_SCANNED_DEPTH))).toBeNull();
  expect(scanMarkup('<div/>'.repeat(MAX_SCANNED_DEPTH + 1))).toBeNull();
});

// No wall-clock assertion: a quadratic scan or a per-element selector compile would blow the test timeout instead.
it('stays linear on pathological CSS and resolves utility CSS once per page', async () => {
  const big = 1024 * 1024;
  const attribute = '['.repeat(big / 2);
  const pathological = [
    '.x '.repeat(big / 3),
    '/* '.repeat(big / 3),
    '@media '.repeat(big / 7),
    `main{width:1px${' '.repeat(big)}x}`,
    `[data-x="${attribute}"]{width:1px}`,
  ];
  for (const [i, css] of pathological.entries()) {
    await writeFile(path.join(root, `p${i}.html`), `<style>${css}</style><main data-x="${attribute}">Canvas</main>`);
    expect(await readTemplatePageViewportWithSource(root, `p${i}.html`)).toMatchObject({ source: 'default' });
  }
  const rules = Array.from({ length: 400 }, (_, i) => `.w-${i}{width:${i}px}.h-${i}{height:${i}px}.maxw-${i}{max-width:${i}px}.ring-${i}{--ring:${i}px}`).join('\n');
  const flat = Array.from({ length: 3000 }, (_, i) => `<div class="w-${i % 400} ring-${i % 400}">x</div>`).join('');
  await writeFile(path.join(root, 'flat.html'), `<style>${rules}</style><body>${flat}</body>`);
  expect(await readTemplatePageViewportWithSource(root, 'flat.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
}, 10_000);

it('bounds var() fan-out, large variable sets and deep nesting', async () => {
  // Each level references the next ten times: a million-fold expansion within the allowed passes.
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const fanout = names.slice(0, -1).map((name, i) => `--${name}:${`var(--${names[i + 1]})`.repeat(10)}`).join(';');
  await writeFile(path.join(root, 'fanout.html'), `<style>:root{${fanout};--g:1px}main{width:var(--a);height:var(--a)}.slide{width:var(--a);height:var(--a)}</style><main>${'<div class="slide">x</div>'.repeat(2000)}</main>`);
  expect(await readTemplatePageViewportWithSource(root, 'fanout.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
  // Many root variables and many candidates: inherited variables are not copied per candidate.
  const vars = Array.from({ length: 20_000 }, (_, i) => `--v${i}:${i}px`).join(';');
  await writeFile(path.join(root, 'vars.html'), `<style>:root{${vars}}div{width:10px}</style><body>${'<div>x</div>'.repeat(2000)}</body>`);
  expect(await readTemplatePageViewportWithSource(root, 'vars.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
  // Descendant selectors over a deeply nested canvas chain, at the depth limit and past it.
  const chain = (depth: number) => `<style>${Array.from({ length: 300 }, (_, i) => `.z${i} div{width:1px}`).join('')}.slide{--w:1280px;width:var(--w);height:720px}</style><body>${'<div class="slide">'.repeat(depth - 2)}x${'</div>'.repeat(depth - 2)}</body>`;
  await writeFile(path.join(root, 'deep.html'), chain(MAX_DOM_DEPTH));
  expect(await readTemplatePageViewportWithSource(root, 'deep.html')).toEqual({ width: 1280, height: 720, source: 'css' });
  await writeFile(path.join(root, 'deeper.html'), chain(3000));
  expect(await readTemplatePageViewportWithSource(root, 'deeper.html')).toEqual({ width: 1920, height: 1080, source: 'default' });
}, 10_000);
