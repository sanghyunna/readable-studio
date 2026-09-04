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
const hubCss = read('../../src/styles/home/hub.css');
const entryCss = read('../../src/styles/home/entry-layout.css');
const transitionCss = read('../../src/components/WorkspaceTransition.module.css');
const modalCss = read('../../src/styles/home/new-project-modal.css');

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
  it('the Advanced disclosure collapse (~890px) no longer uses the short exit token', () => {
    const collapsed = ruleBody('.newproj-advanced__reveal', modalCss);
    expect(collapsed).toContain('var(--dur-exit-large)');

    // ~890px is the measured content height of the expanded panel.
    const duration = tokenMs('dur-exit-large');
    expect(framesFor(duration)).toBeGreaterThanOrEqual(MIN_FRAMES_FOR_MOTION);

    // The regression it replaced: --dur-exit was below the frame floor.
    expect(framesFor(tokenMs('dur-exit'))).toBeLessThan(MIN_FRAMES_FOR_MOTION);
  });

  it('the Hub rail collapse travels a short distance and is fine on --dur-exit', () => {
    // Expanded track: clamp(262px, ..., 292px). Collapsed: --hub-rail-collapsed.
    const hub = ruleBody('.hub', hubCss);
    const collapsedWidth = /--hub-rail-collapsed:\s*(\d+)px/.exec(hubCss);
    const expandedMax = /grid-template-columns:\s*clamp\(\d+px,[^,]+,\s*(\d+)px\)/.exec(hub);
    expect(collapsedWidth).not.toBeNull();
    expect(expandedMax).not.toBeNull();

    const distance = Number(expandedMax![1]) - Number(collapsedWidth![1]);
    expect(distance).toBeLessThanOrEqual(260);

    // At <=260px the 140ms exit runs ~1.9px/ms - an order of magnitude calmer
    // per pixel than the disclosure's failing 6.4px/ms. Left as-is deliberately.
    expect(ruleBody('.hub--rail-collapsed', hubCss)).toContain('var(--dur-exit)');
    expect(distance / tokenMs('dur-exit')).toBeLessThan(2);
  });

  it('the entry rail strip transition covers a tiny distance and needs no change', () => {
    const strip = /--entry-rail-strip-width:\s*(\d+)px/.exec(entryCss);
    const full = /--entry-rail-width:\s*(\d+)px/.exec(entryCss);
    expect(strip).not.toBeNull();
    expect(full).not.toBeNull();

    // 56px -> 44px is 12px of travel; any duration in the scale is ample.
    const distance = Number(full![1]) - Number(strip![1]);
    expect(distance).toBeLessThan(40);
    expect(distance).toBeGreaterThan(0);
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
  it('the disclosure kills both reveal states', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(modalCss);
    expect(reduced).not.toBeNull();
    const body = reduced![1] ?? '';
    expect(body).toContain('.newproj-advanced__reveal');
    expect(body).toContain('.newproj-advanced.is-open .newproj-advanced__reveal');
    expect(body).toContain('transition: none');
  });

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
    expect(entryCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(transitionCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(hubCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
