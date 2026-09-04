// The Advanced / Import disclosure was reported as "clickable text with no
// animation". These assertions pin the two properties jsdom cannot observe:
// the trigger paints as a real control, and the reveal actually animates on the
// repo's canonical grid-rows pattern with the shared duration/easing tokens.
//
// SCOPE LIMIT - READ BEFORE TRUSTING THIS FILE: jsdom does not run the CSS
// cascade, does not compute transitions and never produces an intermediate
// frame. Every assertion here reads stylesheet TEXT, so it proves the declared
// CSS contract only. That a collapse is *perceived* as motion rather than as a
// snap cannot be established here and belongs to runtime verification.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../../src/styles/home/new-project-modal.css', import.meta.url),
  'utf8',
);

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[2] ?? '';
}

describe('Advanced / Import trigger reads as a control', () => {
  it('paints the Hub control material instead of bare text', () => {
    const toggle = block('.newproj-advanced__toggle');

    // Was `background: transparent` — indistinguishable from a text link.
    expect(toggle).toContain('background: var(--hub-control-surface)');
    expect(toggle).toContain('box-shadow: inset 0 1px 0 var(--hub-control-highlight)');
    // Borderless, per the Hub language: material, never a 1px divider.
    expect(toggle).toContain('border: 0');
    expect(toggle).toContain('border-radius: var(--radius-pill)');
  });

  it('lifts on hover and stays lifted while expanded', () => {
    expect(block('.newproj-advanced__toggle:hover')).toContain(
      'background: var(--hub-control-surface-hover)',
    );
    expect(block(".newproj-advanced__toggle[aria-expanded='true']")).toContain(
      'box-shadow: var(--hub-control-shadow-hover)',
    );
  });

  it('keeps a visible focus ring on the token accent', () => {
    expect(block('.newproj-advanced__toggle:focus-visible')).toContain(
      'outline: 2px solid var(--accent)',
    );
  });

  it('uses only design tokens for colour and material', () => {
    const scoped = css.slice(css.indexOf('.newproj-advanced {'));
    expect(scoped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(scoped).not.toMatch(/\brgba?\(/);
  });
});

describe('Advanced / Import disclosure animates', () => {
  it('uses the canonical grid-rows reveal with an opacity ramp', () => {
    const collapsed = block('.newproj-advanced__reveal');
    const expanded = block('.newproj-advanced.is-open .newproj-advanced__reveal');

    expect(collapsed).toContain('grid-template-rows: 0fr');
    expect(collapsed).toContain('opacity: 0');
    expect(expanded).toContain('grid-template-rows: 1fr');
    expect(expanded).toContain('opacity: 1');

    // Sized to the DISTANCE this panel travels (~906px), in BOTH terms. The
    // exit needs the large-surface duration AND the large-surface curve: at
    // 190ms with --ease-out (an ease-out-quint, 99% travelled by 17% of its
    // duration) a browser sampled 906.53 -> 98.30 -> 4.38 -> 0 and put a single
    // frame in the 10%-90% band. Swapping only the duration leaves the cliff in
    // frame one, so --ease-large-exit is load-bearing here, not cosmetic.
    // The entrance is unchanged - it already reads correctly.
    expect(collapsed).toContain(
      'grid-template-rows var(--dur-exit-large) var(--ease-large-exit)',
    );
    expect(collapsed).toContain('opacity var(--dur-exit-large) var(--ease-large-exit)');
    expect(collapsed).not.toContain('var(--dur-exit)');
    expect(collapsed).not.toContain('var(--ease-out)');
    expect(expanded).toContain('grid-template-rows var(--dur-enter) var(--ease-out)');
    expect(expanded).toContain('opacity var(--dur-enter) var(--ease-out)');

    // Height and opacity must share one duration, or the fade finishes early
    // and the last frames are an empty box collapsing.
    const exitDurations = [...collapsed.matchAll(/var\(--dur-[a-z-]+\)/g)].map((m) => m[0]);
    expect(new Set(exitDurations).size).toBe(1);
  });

  it('resolves the exit token to a duration long enough for ~890px of travel', () => {
    // jsdom does not compute transitions, so this pins the DECLARED value in
    // tokens.css rather than observed motion (see the runtime-verification
    // note in the suite header).
    const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
    const large = /--dur-exit-large:\s*(\d+)ms/.exec(tokens);
    const short = /--dur-exit:\s*(\d+)ms/.exec(tokens);
    const enter = /--dur-enter:\s*(\d+)ms/.exec(tokens);
    expect(large).not.toBeNull();
    expect(short).not.toBeNull();
    expect(enter).not.toBeNull();

    const largeMs = Number(large![1]);
    const shortMs = Number(short![1]);
    const enterMs = Number(enter![1]);

    // 190ms was already >= the naive frame-count floor and STILL measured as a
    // snap (one frame in the 10%-90% band), because the frame budget is spent
    // on an ease-out-quint's flat tail. The panel also only paints at ~15fps
    // mid-collapse - relayout of the full creation stack plus backdrop-filter -
    // so the duration has to clear the floor against the DEGRADED rate, not the
    // nominal 60fps: >=400ms is ~6 real frames rather than ~3.
    expect(largeMs).toBeGreaterThanOrEqual(400);
    expect(largeMs).toBeGreaterThan(shortMs);

    // This exit is deliberately LONGER than the entrance, which inverts the
    // product's usual enter-gentle / exit-decisive asymmetry. That asymmetry
    // exists to keep exits feeling responsive; at ~906px every value that
    // stayed under --dur-enter read as no animation at all, which is the
    // defect the user reported. A visible collapse beats the symmetry rule, so
    // the inversion is pinned deliberately rather than left to drift back.
    expect(largeMs).toBeGreaterThan(enterMs);

    // The inner wrapper owns the clip, or the collapsed rows would spill.
    const inner = block('.newproj-advanced__reveal-inner');
    expect(inner).toContain('min-height: 0');
    expect(inner).toContain('overflow: hidden');
  });

  it('rotates the chevron on the shared entrance token', () => {
    expect(block('.newproj-advanced__chevron')).toContain(
      'transition: transform var(--dur-enter) var(--ease-out)',
    );
    expect(block(".newproj-advanced__toggle[aria-expanded='true'] .newproj-advanced__chevron"))
      .toContain('transform: rotate(180deg)');
  });

  it('disables the movement entirely under prefers-reduced-motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(reduced).not.toBeNull();
    const body = reduced![1] ?? '';
    // Both reveal states must be listed: killing only the collapsed rule would
    // leave the OPEN transition running under reduced motion.
    expect(body).toContain('.newproj-advanced__reveal');
    expect(body).toContain('.newproj-advanced.is-open .newproj-advanced__reveal');
    expect(body).toContain('transition: none');
    expect(body).toContain('transform: none');
  });

  it('is backed by the product-wide reduced-motion reset', () => {
    // The app also ships a global `transition-duration: 0.01ms !important`
    // reset in entrance.css. That `!important` wins over this component's
    // `transition: none`, so the computed duration under reduced motion is
    // 0.01ms rather than 0s. Both mean "no perceptible movement"; this pins the
    // global rule so the component rule is never mistaken for the only guard.
    const entrance = readFileSync(
      new URL('../../src/styles/entrance.css', import.meta.url),
      'utf8',
    );
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(entrance);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it('falls back to an opaque surface under prefers-reduced-transparency', () => {
    const reduced = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toContain('backdrop-filter: none');
  });
});
