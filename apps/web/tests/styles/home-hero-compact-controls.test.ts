import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);

function cssDeclarations(selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = homeHeroCss.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('HomeHero compact composer controls', () => {
  it('keeps the compact plus trigger reachable without expanding the Hub', () => {
    const plus = cssDeclarations('.home-view--hub .plus-menu');

    expect(ruleValue(plus, 'display')).toBe('inline-flex');
  });

  it('keeps the floating @ picker shell stable while result tabs change', () => {
    const floatingPicker = cssDeclarations(
      '.caret-floating-layer .home-hero__plugin-picker--floating',
    );
    const picker = cssDeclarations('.home-hero__plugin-picker');
    const results = cssDeclarations('.home-hero__plugin-picker-results');

    expect(ruleValue(floatingPicker, 'height')).toBe('var(--cfl-max-h, 60vh)');
    expect(ruleValue(floatingPicker, 'max-height')).toBe('var(--cfl-max-h, 60vh)');
    expect(ruleValue(picker, 'overflow')).toBe('hidden');
    expect(ruleValue(results, 'flex')).toBe('1 1 auto');
    expect(ruleValue(results, 'overflow-y')).toBe('auto');
  });

  it('keeps the execution buttons compact in the hero', () => {
    const switcherChip = cssDeclarations(
      '.home-hero__execution-switcher .inline-switcher__chip',
    );

    expect(ruleValue(switcherChip, 'height')).toBe('30px');
    expect(ruleValue(switcherChip, 'max-width')).toBe('48px');
  });

  it('no longer styles a session-mode trigger in the composer footer', () => {
    // The mode chip moved to the New Project flow, so the footer stylesheet
    // must not keep dead rules that would resurrect it visually.
    expect(homeHeroCss).not.toContain('.home-hero__foot-right .session-mode-toggle');
  });

  it('lays the split agent + model buttons out as a row', () => {
    const slot = cssDeclarations('.home-hero__execution-switcher--agent-model');
    const agent = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--agent',
    );

    expect(ruleValue(slot, 'display')).toBe('inline-flex');
    // Agent icon, model name, and chevron read as one tight control cluster.
    expect(ruleValue(slot, 'gap')).toBe('2px');
    // Agent is the compact icon-only button; the model button carries the name.
    expect(ruleValue(agent, 'width')).toBe('24px');
  });

  it('prevents the compact execution switcher from expanding on narrow screens', () => {
    const switcher = cssDeclarations('.home-hero__execution-switcher');
    const switcherChip = cssDeclarations(
      '.home-hero__execution-switcher .inline-switcher__chip',
    );

    expect(ruleValue(switcher, 'flex-basis')).toBe('auto');
    expect(ruleValue(switcherChip, 'width')).toBe('auto');
    expect(ruleValue(switcherChip, 'max-width')).toBe('48px');
  });
});
