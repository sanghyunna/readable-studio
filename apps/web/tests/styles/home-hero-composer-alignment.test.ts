import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`).exec(homeHeroCss);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe('Hub composer text alignment', () => {
  it('shares one 16px vertical content inset between typed text and placeholder', () => {
    const card = ruleBody('.home-view--hub .home-hero__input-card');
    const editable = ruleBody('.home-view--hub .home-hero__lexical .composer-editable');
    const placeholder = ruleBody('.home-view--hub .home-hero__lexical .composer-input-placeholder');

    expect(card).toMatch(/--hub-composer-content-inset-top:\s*16px\s*;/);
    expect(editable).toMatch(
      /padding:\s*var\(--hub-composer-content-inset-top\)\s+4px\s+var\(--hub-composer-content-inset-bottom\)\s*;/,
    );
    expect(placeholder).toMatch(/top:\s*var\(--hub-composer-content-inset-top\)\s*;/);
  });
});
