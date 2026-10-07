/**
 * Hub template card preview-frame contract.
 *
 * The shipped WebP thumbnails are 16:9 (deck), 16:10 (website) and 4:5
 * (report). Letterboxing them into a taller box left every card with an empty
 * band under the image. The frame is now a 16:9 slide and every filling - the
 * image, the live-iframe fallback and the designed placeholder - covers it
 * edge to edge: decks fit exactly, websites/reports are top-anchored and
 * cropped at the foot. The arrow stays centred on that frame.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const webRoot = process.cwd();
const hero = postcss.parse(readFileSync(resolve(webRoot, 'src/styles/home/home-hero.css'), 'utf8'));
const placeholder = postcss.parse(
  readFileSync(resolve(webRoot, 'src/components/home-hero/TemplatePlaceholderThumb.module.css'), 'utf8'),
);

function rule(root: postcss.Root, selector: string): Record<string, string> {
  const match = root.nodes.find(
    (node): node is Rule => node.type === 'rule' && node.selector === selector,
  );
  expect(match, selector).toBeDefined();
  return Object.fromEntries(
    match!.nodes.flatMap((node) => (node.type === 'decl' ? [[node.prop, node.value]] : [])),
  );
}

describe('Hub template card preview frame', () => {
  it('is a 16:9 slide that clips its content', () => {
    const thumb = rule(hero, '.home-hero__template-thumb');
    expect(thumb['aspect-ratio']).toBe('16 / 9');
    expect(thumb.width).toBe('100%');
    expect(thumb.overflow).toBe('hidden');
  });

  it('fills the frame with the shipped image, top-anchored and cropped (never letterboxed)', () => {
    const image = rule(hero, '.home-hero__template-img');
    expect(image.width).toBe('100%');
    expect(image.height).toBe('100%');
    expect(image['object-fit']).toBe('cover');
    expect(image['object-position']).toBe('top center');
  });

  it('fills the frame with the live-iframe fallback: a 1440 x 810 page scaled to the 200px thumb', () => {
    const iframe = rule(hero, '.home-hero__template-thumb .plugins-home__html-iframe');
    const scale = Number(/scale\(([\d.]+)\)/.exec(iframe.transform ?? '')?.[1]);
    const height = Number.parseFloat(iframe.height ?? '');
    expect(Math.round(1440 * scale)).toBe(200);
    expect(1440 / height).toBeCloseTo(16 / 9, 5);
    expect(height * scale).toBeCloseTo(200 * 9 / 16, 1);
    const surfaces = rule(
      hero,
      [
        '.home-hero__template-thumb .plugins-home__preview',
        '.home-hero__template-thumb .plugins-home__media',
        '.home-hero__template-thumb .plugins-home__html',
        '.home-hero__template-thumb .plugins-home__text-surface',
      ].join(',\n'),
    );
    expect(surfaces.width).toBe('100%');
    expect(surfaces.height).toBe('100%');
  });

  it('fills the frame with the designed placeholder', () => {
    const root = rule(placeholder, '.root');
    expect(root.width).toBe('100%');
    expect(root.height).toBe('100%');
    expect(root.overflow).toBe('hidden');
  });

  it('centres the rail arrows on the 16:9 thumb of a 216px card', () => {
    const arrow = rule(hero, '.home-hero__templates-arrow');
    const item = rule(hero, '.home-hero__template-item');
    const card = rule(hero, '.home-hero__template-card');
    expect(item.flex).toBe('0 0 216px');
    expect(card.padding).toBe('8px');
    expect(arrow.top).toBe('calc(2px + 8px + (200px * 9 / 16) / 2)');
    expect(arrow.transform).toBe('translateY(-50%)');
  });
});
