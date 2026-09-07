// Cross-surface motion audit: is any newly-animated surface using a duration
// that is too SHORT for the distance it travels?
//
// The Advanced disclosure shipped with --dur-exit (140ms) for a ~890px collapse
// and read as a snap despite technically animating. This file pins the same
// distance-vs-duration relationship for the other surfaces that landed in the
// same batch, so the next one cannot regress silently.
//
// SCOPE LIMIT: jsdom does not compute transitions or produce intermediate
// frames. These assertions read stylesheet TEXT and therefore prove the
// declared CSS contract, NOT observed motion. Perceptual smoothness is a
// runtime-verification item.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const tokens = read('../../src/styles/tokens.css');
const shellCss = read('../../src/styles/shell.css');
const projectRailCss = read('../../src/styles/home/project-rail.css');
const transitionCss = read('../../src/components/WorkspaceTransition.module.css');

function tokenMs(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)ms`).exec(tokens);
  if (!match) throw new Error(`Missing duration token --${name}`);
  return Number(match[1]);
}

function ruleBody(selector: string, source: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[2] ?? '';
}

function customPropertyPx(
  name: string,
  sources: readonly string[],
  resolving: readonly string[] = [],
): number {
  if (resolving.includes(name)) {
    throw new Error(`Cyclic CSS custom-property alias: ${[...resolving, name].join(' -> ')}`);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = sources
    .map((source) => new RegExp(`${escaped}\\s*:\\s*([^;}]+)`).exec(source)?.[1]?.trim())
    .find((value): value is string => value !== undefined);
  if (!declaration) throw new Error(`Missing CSS custom property ${name}`);

  const pixels = /^(\d+(?:\.\d+)?)px$/.exec(declaration);
  if (pixels) return Number(pixels[1]);

  const alias = /^var\((--[^),\s]+)\)$/.exec(declaration);
  if (alias?.[1]) return customPropertyPx(alias[1], sources, [...resolving, name]);

  throw new Error(`CSS custom property ${name} does not resolve to pixels: ${declaration}`);
}

// A collapse/expand only reads as motion if the browser gets enough frames to
// paint distinct intermediate positions. At 60fps, ~10 frames is the practical
// floor; below that the eye integrates it as a jump. The browser lane confirmed
// the failure mode empirically: 890px in 140ms produced 7-8 heights and was
// judged "close to a snap".
const FRAME_MS = 1000 / 60;
const MIN_FRAMES_FOR_MOTION = 10;

function framesFor(durationMs: number): number {
  return durationMs / FRAME_MS;
}

describe('motion duration is proportionate to distance travelled', () => {
  it('the Hub rail collapse travels a short distance and is fine on --dur-exit', () => {
    // Expanded track defaults to the persisted-width baseline. Collapsed stays
    // on the shared 44px strip regardless of the saved expanded width.
    const shell = ruleBody('.workspace-shell__body', shellCss);
    const collapsedWidth = customPropertyPx('--project-rail-collapsed', [projectRailCss]);
    const expandedDefault = customPropertyPx('--project-rail-expanded', [projectRailCss]);
    expect(shell).toContain('var(--hub-rail-expanded, var(--project-rail-expanded))');

    const distance = expandedDefault - collapsedWidth;
    expect(distance).toBeLessThanOrEqual(260);

    // At <=260px the 140ms exit runs ~1.9px/ms - an order of magnitude calmer
    // per pixel than the disclosure's failing 6.4px/ms. Left as-is deliberately.
    expect(ruleBody(".workspace-shell__body:has(> [data-project-rail-state='collapsed'])", shellCss)).toContain('var(--dur-exit)');
    expect(distance / tokenMs('dur-exit')).toBeLessThan(2);
  });

  it('the workspace rail uses the full shared transition distance', () => {
    const strip = customPropertyPx('--project-rail-collapsed', [projectRailCss]);
    const full = customPropertyPx('--project-rail-expanded', [projectRailCss]);

    // The legacy 56px icon width made "expand" travel only 12px. Both surfaces
    // now use the full 292px panel baseline while the parent grid interpolates.
    const distance = full - strip;
    expect(distance).toBe(248);
    expect(ruleBody('.workspace-shell__body', shellCss)).toContain('var(--dur-enter)');
  });

  it('the Hub <-> workspace transition moves <=10px and sits well above the frame floor', () => {
    const durations = [...transitionCss.matchAll(/animation:\s*\w+\s+(\d+)ms/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(0);

    const translations = [...transitionCss.matchAll(/translate3d\(0,\s*(-?\d+)px,\s*0\)/g)].map(
      (m) => Math.abs(Number(m[1])),
    );
    expect(translations.length).toBeGreaterThan(0);

    // Largest travel is 10px over >=260ms - the opposite failure mode from the
    // disclosure, and comfortably smooth. No change warranted.
    expect(Math.max(...translations)).toBeLessThanOrEqual(10);
    for (const duration of durations) {
      expect(framesFor(duration)).toBeGreaterThanOrEqual(MIN_FRAMES_FOR_MOTION);
    }
  });
});

describe('reduced motion still snaps on every audited surface', () => {
  it('the longer exit token is not exempt from the global reduced-motion reset', () => {
    // entrance.css forces `transition-duration: 0.01ms !important`, which wins
    // over any component duration - including --dur-exit-large. Lengthening the
    // token therefore cannot introduce a visible frame under reduced motion.
    const entrance = read('../../src/styles/entrance.css');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(entrance);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it('the rail and surface transition keep their own reduced-motion guards', () => {
    expect(shellCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(transitionCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(read('../../src/styles/home/hub.css')).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
