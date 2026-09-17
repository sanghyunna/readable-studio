import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Low-spec motion contract (`src/styles/low-spec/motion.css`).
//
// Low mode is keyed on the root stamp `html[data-performance-profile="low"]`
// (never on an absent attribute - the full profile stamps `"full"`). Motion is
// neutralized with NEAR-ZERO durations, not `animation: none`: Chromium fires
// `animationend` / `transitionend` for a positive tiny duration and fires
// nothing for `none` or `0s`, and three host paths depend on that event
// (HomeHero attention sheen, `useExitPhaseInert`, `useTransparentPhaseInert`).
// `animation: none` is reserved for an explicit allowlist of perpetual
// decorative loops that have no end-event consumer.
// ---------------------------------------------------------------------------

const LOW_ROOT = 'html[data-performance-profile="low"]';

const motionCss = readFileSync(
  new URL('../../src/styles/low-spec/motion.css', import.meta.url),
  'utf8',
);
const homeHeroTsx = readFileSync(
  new URL('../../src/components/HomeHero.tsx', import.meta.url),
  'utf8',
);

interface Rule {
  readonly selector: string;
  readonly body: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flat rule list: the sheet must not nest anything inside an at-rule. */
function parseRules(source: string): readonly Rule[] {
  const stripped = stripComments(source);
  const rules: Rule[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selector: match[1]!.replace(/\s+/g, ' ').trim(),
      body: match[2]!.trim(),
    });
  }
  return rules;
}

function selectorList(rule: Rule): readonly string[] {
  return rule.selector.split(',').map((part) => part.trim());
}

function declaration(body: string, property: string): string | null {
  const escaped = property.replace(/[-]/g, '\\-');
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`).exec(body);
  return match?.[1]?.trim() ?? null;
}

const rules = parseRules(motionCss);
/** Declarations only - comments may name the things the sheet must not do. */
const motionCode = stripComments(motionCss);

function findUniversalRule(): Rule {
  const universal = rules.filter((rule) =>
    selectorList(rule).some((part) => part === `${LOW_ROOT} *`),
  );
  expect(universal, 'exactly one universal low-mode motion rule').toHaveLength(1);
  return universal[0]!;
}

function findAnimationNoneRules(): readonly Rule[] {
  return rules.filter((rule) => /animation\s*:\s*none/.test(rule.body));
}

describe('low-spec motion contract', () => {
  it('scopes every rule to the low profile stamp and never to an absent attribute', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const part of selectorList(rule)) {
        expect(part, `selector must start with the low root: ${part}`).toMatch(
          new RegExp(`^${LOW_ROOT.replace(/[[\]"]/g, '\\$&')}(\\s|$)`),
        );
      }
    }
    expect(motionCode).not.toMatch(/data-performance-profile\s*\]/);
    expect(motionCode).not.toMatch(/data-performance-profile="full"/);
    // No media queries: `prefers-reduced-motion` stays an independent axis
    // owned by the base sheets; low mode must neither depend on nor rewrite it.
    expect(motionCode).not.toMatch(/@media/);
    expect(motionCode).not.toMatch(/prefers-reduced-motion/);
  });

  it('T1: collapses all motion to a near-zero end-event-preserving duration', () => {
    const universal = findUniversalRule();

    expect(selectorList(universal)).toEqual([
      `${LOW_ROOT} *`,
      `${LOW_ROOT} *::before`,
      `${LOW_ROOT} *::after`,
    ]);

    const expected: Record<string, RegExp> = {
      'animation-duration': /^0\.01ms\s+!important$/,
      'animation-delay': /^0m?s\s+!important$/,
      'animation-iteration-count': /^1\s+!important$/,
      'transition-duration': /^0\.01ms\s+!important$/,
      'transition-delay': /^0m?s\s+!important$/,
      'scroll-behavior': /^auto\s+!important$/,
    };
    for (const [property, pattern] of Object.entries(expected)) {
      const value = declaration(universal.body, property);
      expect(value, `${property} in the universal rule`).not.toBeNull();
      expect(value, property).toMatch(pattern);
    }

    // The reason T1 is not `none`: durations of `0ms`, `0s`, or `none` fire no
    // `animationend` / `transitionend`, which would strand the attention sheen
    // and the exit-phase inert gate.
    for (const property of ['animation-duration', 'transition-duration']) {
      const value = declaration(universal.body, property)!;
      expect(value).not.toMatch(/^0m?s\b/);
      expect(value).not.toMatch(/\bnone\b/);
    }
    expect(universal.body).not.toMatch(/(^|;)\s*animation\s*:/);
    expect(universal.body).not.toMatch(/(^|;)\s*transition\s*:/);
    expect(universal.body).not.toMatch(/animation-name|transition-property/);
  });

  it('T2: reserves `animation: none` for the explicit perpetual-loop allowlist', () => {
    const noneRules = findAnimationNoneRules();
    expect(noneRules.length).toBeGreaterThan(0);

    const noneSelectors = noneRules.flatMap(selectorList);
    for (const part of noneSelectors) {
      expect(part, `animation: none must never be universal: ${part}`).not.toMatch(
        /(^|\s)\*(::?[a-z-]+)?$/,
      );
    }

    // Loops with no end-event consumer (verified against `src/**/*.tsx`: the
    // only `animationend` listeners are HomeHero, useExitPhaseInert,
    // useTransparentPhaseInert and the edit-mode bridge - none on these).
    const allowlist = [
      `${LOW_ROOT} .icon-spin`,
      `${LOW_ROOT} .chat-loading-lines span`,
      `${LOW_ROOT} .recent-projects__deck-cover-loading`,
      `${LOW_ROOT} .skeleton-block`,
      `${LOW_ROOT} .design-card-skeleton .design-card-thumb`,
      `${LOW_ROOT} .agent-scan-card__rows em`,
      `${LOW_ROOT} .pet-codex-card:hover .pet-codex-thumb-preview`,
      `${LOW_ROOT} .pet-codex-card:focus-within .pet-codex-thumb-preview`,
      `${LOW_ROOT} .pet-image.frames`,
      `${LOW_ROOT} .pet-image.atlas`,
    ];
    for (const selector of allowlist) {
      expect(noneSelectors, `allowlist entry ${selector}`).toContain(selector);
    }
    // A new `animation: none` target has to be added to the allowlist above
    // after confirming it has no `animationend` consumer.
    expect([...noneSelectors].sort()).toEqual([...allowlist].sort());

    // Static frames where the loop set visible state: the sprite pins frame 0
    // (mirrors the `prefers-reduced-motion` block in `viewer/pets.css`).
    const petRule = rules.find((rule) =>
      selectorList(rule).includes(`${LOW_ROOT} .pet-image.atlas`),
    );
    expect(petRule).toBeDefined();
    expect(declaration(petRule!.body, 'background-position-x')).toMatch(/^0%\s+!important$/);
  });

  it('T2: never blanket-disables surfaces whose exit or attention paths consume end events', () => {
    const noneSelectors = findAnimationNoneRules().flatMap(selectorList);
    const endEventDependent = [
      'home-hero__attention-sheen',
      'home-hero__submit',
      'export-ready-nudge',
      'agent-card--amr-highlight',
      'modal',
      'overlay',
      'backdrop',
      'toast',
      'menu',
      'popover',
      'drawer',
      'sheet',
      'dialog',
      'transition',
      'accordion',
    ];
    for (const token of endEventDependent) {
      for (const part of noneSelectors) {
        expect(part, `${token} must stay on the near-zero path`).not.toContain(token);
      }
    }
    expect(motionCode).not.toMatch(/(^|;)\s*transition\s*:\s*none/m);
  });

  it('T3: pins the gallery hover auto-pan so the scaled iframe never travels', () => {
    const gallery = rules.find((rule) =>
      selectorList(rule).includes(
        `${LOW_ROOT} .plugins-home__card--gallery:hover .plugins-home__html-iframe`,
      ),
    );
    expect(gallery, 'gallery hover pin rule').toBeDefined();
    expect(declaration(gallery!.body, 'top')).toMatch(/^0\s+!important$/);
  });

  it('keeps focus-visible affordances and state rings out of the low-mode sheet', () => {
    expect(motionCode).not.toMatch(/:focus(?!-within)|aria-invalid|outline|box-shadow/);
    // Motion-only shutdown: no display/visibility/opacity/pointer-events, so a
    // closing overlay still settles and unmounts through its own exit path.
    expect(motionCode).not.toMatch(/(^|;)\s*(display|visibility|opacity|pointer-events)\s*:/m);
  });

  it('documents the end-event consumer that forbids a universal `animation: none`', () => {
    // HomeHero clears the attention sheen on `animationend`; if T1 ever became
    // `none` the `.home-hero__attention-sheen` class would never be removed.
    expect(homeHeroTsx).toMatch(/onAnimationEnd=\{\(\) => setSendAttention\(false\)\}/);
  });
});
