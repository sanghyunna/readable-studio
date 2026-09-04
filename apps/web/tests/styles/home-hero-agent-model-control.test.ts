import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const homeHeroTsx = readFileSync(
  new URL('../../src/components/HomeHero.tsx', import.meta.url),
  'utf8',
);

const cssWithoutComments = homeHeroCss.replace(/\/\*[\s\S]*?\*\//g, '');

function cssDeclarations(selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [
    ...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g')),
  ];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('Hub composer footer: agent icon -> model name -> send', () => {
  it('renders the agent/model mount point before the send button', () => {
    const agentModel = homeHeroTsx.indexOf('home-hero-agent-model');
    const submit = homeHeroTsx.indexOf('home-hero-submit');

    expect(agentModel).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    // Send stays last in the footer's right cluster.
    expect(agentModel).toBeLessThan(submit);
  });

  it('drops the chevron so the control never reads as an inline dropdown', () => {
    const suppressed = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip-chevron',
    );

    expect(ruleValue(suppressed, 'display')).toBe('none');
  });

  it('shows the model name as the control label', () => {
    const model = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip-model',
    );

    expect(ruleValue(model, 'display')).toBe('block');
    expect(ruleValue(model, 'text-overflow')).toBe('ellipsis');
    // Colour must come from a token, never a literal.
    expect(ruleValue(model, 'color')).toBe('var(--text)');
  });

  it('gives the agent icon a round leading token', () => {
    const icon = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip-icon',
    );

    expect(ruleValue(icon, 'border-radius')).toBe('var(--radius-pill)');
  });

  it('wears the borderless hub glass pill, not a dark outline', () => {
    const chip = cssDeclarations(
      '.home-view--hub .home-hero__execution-switcher--agent-model .inline-switcher__chip',
    );

    expect(ruleValue(chip, 'background')).toBe('var(--hub-control-surface)');
    expect(ruleValue(chip, 'border')).toBe('1px solid var(--hub-control-border)');
    expect(ruleValue(chip, 'box-shadow')).toBe('var(--hub-control-shadow)');
  });

  it('falls back to an opaque surface under reduced transparency', () => {
    expect(cssWithoutComments).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });

  it('removes the template control and its dead string', () => {
    expect(homeHeroTsx).not.toContain('home-hero-template-control');
    expect(homeHeroTsx).not.toContain('hub.noTemplate');
  });
});
