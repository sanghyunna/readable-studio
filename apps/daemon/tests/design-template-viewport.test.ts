import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readTemplatePageViewport } from '../src/design-template-viewport.js';

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
