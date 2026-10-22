import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DECK_FRAMEWORK_DIRECTIVE,
  DECK_SKELETON_HTML,
} from '../src/prompts/deck-framework.js';
import { OFFICIAL_DESIGNER_PROMPT } from '../src/prompts/official-system.js';
import { composeSystemPrompt } from '../src/prompts/system.js';

describe('template canvas resolution parity', () => {
  it('preserves the supplied canvas in both BYOK deck instruction layers', () => {
    for (const directive of [OFFICIAL_DESIGNER_PROMPT, DECK_FRAMEWORK_DIRECTIVE]) {
      expect(directive).toContain("Preserve a supplied template's explicit canvas resolution, aspect ratio, and layout");
      expect(directive).toContain('1920×1080 is only the default when no template defines a canvas size');
    }
    expect(DECK_FRAMEWORK_DIRECTIVE).toContain('takes precedence over all copy-verbatim rules and numeric examples below');
    expect(DECK_FRAMEWORK_DIRECTIVE).toContain('vertical decks without an explicitly sized supplied template');
    const prompt = composeSystemPrompt({ skillMode: 'deck', skillBody: 'Use a 1280×720 canvas.' });
    expect(prompt).toContain('1280×720');
    expect(prompt).toContain("Preserve a supplied template's explicit canvas resolution, aspect ratio, and layout");
  });
});

describe('deck framework chrome byte synchronization', () => {
  const template = readFileSync(new URL('../../../templates/deck-framework.html', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../../../apps/daemon/src/prompts/deck-framework.ts', import.meta.url), 'utf8');
  const blocks = [
    /    \/\* Chrome[\s\S]*?(?=    \/\* Print \/ PDF)/,
    /  <nav class="deck-counter"[\s\S]*?<\/nav>/,
    /      \.deck-counter[^\n]*display: none !important; \}/,
    /      \/\/ ---- auto-hide nav[\s\S]*?(?=      \/\/ Auto-focus body)/,
  ];

  for (const [name, source] of [['daemon', daemon], ['contracts', DECK_SKELETON_HTML]] as const) {
    it(`${name} ships the template chrome verbatim without the retired hint`, () => {
      for (const pattern of blocks) {
        const expected = template.match(pattern)?.[0];
        expect(expected).toBeDefined();
        expect(source.match(pattern)?.[0]).toBe(expected);
      }
      expect(source).not.toContain('deck-hint');
    });
  }
});

/**
 * BYOK/API-mode deck parity (PR6 follow-up).
 *
 * BYOK/API mode composes its system prompt through `packages/contracts`
 * (`composeSystemPrompt`), which injects THIS mirror of the deck framework —
 * not the daemon's `apps/daemon/src/prompts/deck-framework.ts`. The mirror
 * drifted: it shipped without PR1's CSS centering (`justify-content: center`
 * on the active slide + base `.slide` padding) and still carried PR5's
 * pre-revision "don't let flow content extend into the bottom 200px" hard-gap
 * directive. The net effect was BYOK-generated decks pooling empty space at
 * the bottom of every slide.
 *
 * These assertions lock the mirror to the daemon's post-PR1/PR5 state for the
 * deck-fix sections. The daemon side is covered independently by
 * `apps/daemon/tests/prompts/system.test.ts`; we intentionally do not import
 * across the package boundary.
 */
describe('contracts deck-framework mirror — parity with daemon (PR1 + PR5)', () => {
  describe('DECK_SKELETON_HTML — PR1 CSS centering', () => {
    it('centers the active slide vertically via justify-content: center', () => {
      expect(DECK_SKELETON_HTML).toContain(
        ':where(.slide.active) { display: flex; flex-direction: column; justify-content: center; }',
      );
    });

    it('gives the base .slide rule the canonical 80px 120px padding', () => {
      expect(DECK_SKELETON_HTML).toContain('padding: 80px 120px;');
    });
  });

  describe('DECK_FRAMEWORK_DIRECTIVE — PR5 vertical-fill directive', () => {
    it('carries the new "fill the vertical canvas" rule', () => {
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('Fill the vertical canvas');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('justify-content: center');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('justify-content: space-between');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('margin-top: auto');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('flex: 1');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('*:last-child { margin-bottom: 0; }');
    });

    it('softens the footer safe-zone into a no-collision margin that must still FILL', () => {
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('Reserve a footer safe-zone');
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('never collide');
      expect(DECK_FRAMEWORK_DIRECTIVE).toMatch(
        /not\*?\*?\s+a directive to leave the bottom of the slide empty/,
      );
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('must still FILL its band');
    });

    it('no longer carries the old hard "bottom 200px" gap phrasing', () => {
      expect(DECK_FRAMEWORK_DIRECTIVE).not.toContain(
        "don't let flow content extend into the bottom 200px",
      );
    });

    it('adds the ">15% empty band at the bottom" pre-emit self-check item', () => {
      expect(DECK_FRAMEWORK_DIRECTIVE).toMatch(
        /large empty band \(> ~15% of slide height/,
      );
      expect(DECK_FRAMEWORK_DIRECTIVE).toContain('do not leave pooled empty space');
    });
  });
});
