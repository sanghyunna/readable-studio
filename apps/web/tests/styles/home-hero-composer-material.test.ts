import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const tokensCss = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');

function ruleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

function darkBlock(source: string): string {
  // The hub material tokens live in the compound `[data-theme="dark"] .hub`
  // selector block, not the bare `[data-theme="dark"]` custom-property block.
  const match = /\[data-theme="dark"\]\s+\.hub[^{]*\{([\s\S]*?)\n\}/.exec(source);
  if (!match?.[1]) throw new Error('Missing [data-theme="dark"] .hub block in tokens.css');
  return match[1];
}

function tokenValue(body: string, token: string): string {
  const match = new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*([^;]+);`).exec(body);
  if (!match?.[1]) throw new Error(`Missing token ${token}`);
  return match[1].trim();
}

describe('Hub composer material contract', () => {
  it('keeps the dark composer fill translucent enough for backdrop-filter to refract', () => {
    // Given the dark token block
    const dark = darkBlock(tokensCss);

    // When reading the composer fill
    const fill = tokenValue(dark, '--hub-composer-fill');
    const alpha = Number(/[\d.]+\s*\)$/.exec(fill)?.[0].replace(')', ''));

    // Then it must stay translucent - an opaque fill is what made the composer read as clay
    expect(alpha).toBeLessThanOrEqual(0.6);
    expect(alpha).toBeGreaterThanOrEqual(0.3);
  });

  it('keeps dark canvas blooms distinct from the base so the glass has something to sample', () => {
    // Given
    const dark = darkBlock(tokensCss);

    // When
    const base = tokenValue(dark, '--hub-canvas-base');

    // Then every bloom stop must differ from the base - equal values paint a flat canvas
    for (const token of ['--hub-canvas-blue', '--hub-canvas-pink', '--hub-canvas-cyan', '--hub-canvas-green']) {
      expect(tokenValue(dark, token)).not.toBe(base);
    }
  });

  it('keeps a lit top edge on the dark composer via a visibly strong pearl highlight', () => {
    // Given
    const dark = darkBlock(tokensCss);

    // When
    const highlight = tokenValue(dark, '--hub-pearl-highlight');
    const alpha = Number(/[\d.]+\s*\)$/.exec(highlight)?.[0].replace(')', ''));

    // Then the inset highlight must be strong enough to read as a lit glass edge
    expect(alpha).toBeGreaterThanOrEqual(0.2);
  });

  it('renders the placeholder clearly fainter than typed text through dedicated placeholder tokens', () => {
    // Given
    const baseRule = ruleBody(homeHeroCss, '.home-hero__lexical .composer-input-placeholder');

    // Then the base rule references the light placeholder token, never the typed-text token
    expect(baseRule).toContain('var(--text-placeholder-light)');
    expect(baseRule).not.toMatch(/color:\s*var\(--text\)/);
    expect(baseRule).not.toMatch(/font-weight:\s*(5|6|7|8|9)/);

    // And dark overrides exist for both the explicit attribute and system mode
    expect(ruleBody(homeHeroCss, "[data-theme='dark'] .home-hero__lexical .composer-input-placeholder")).toContain(
      'var(--text-placeholder-dark)',
    );
    expect(homeHeroCss).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?html:not\(\[data-theme\]\)\s*\.home-hero__lexical\s*\.composer-input-placeholder\s*\{[^}]*var\(--text-placeholder-dark\)/,
    );

    // And both tokens exist in tokens.css
    expect(tokensCss).toMatch(/--text-placeholder-light:\s*#[0-9a-f]{6}/);
    expect(tokensCss).toMatch(/--text-placeholder-dark:\s*#[0-9a-f]{6}/);
  });

  it('insets the staged-attachment row from the composer edge', () => {
    // Given
    const row = ruleBody(homeHeroCss, '.home-view--hub .home-hero__active');

    // Then the row owns a 12px top/inline inset on the 4px grid (was flush at 0px)
    expect(row).toMatch(/padding:\s*12px\s+12px\s+0\s*;/);
  });

  it('keeps prefix-first backdrop-filter ordering on the composer', () => {
    // Given the hub composer card rule
    const card = ruleBody(homeHeroCss, '.home-view--hub .home-hero__input-card');

    // Then -webkit-backdrop-filter must be authored before the unprefixed one
    const prefixed = card.indexOf('-webkit-backdrop-filter');
    const unprefixed = card.indexOf('backdrop-filter:');
    expect(prefixed).toBeGreaterThanOrEqual(0);
    expect(unprefixed).toBeGreaterThan(prefixed);
  });
});
