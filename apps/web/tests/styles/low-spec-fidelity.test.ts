import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';
import { readExpandedIndexCss } from '../helpers/read-expanded-css';

// Property contracts, not a prose snapshot: new geometry/hit-testing overrides
// require an explicit review rather than silently changing editing coordinates.
const paintTokens = new Set([
  '--hub-glass-blur', '--hub-control-blur', '--app-window-chrome-glass',
  '--hub-glass-fill', '--hub-glass-fill-strong', '--hub-composer-fill',
  '--hub-control-surface', '--hub-control-surface-hover', '--hub-control-engraved',
  '--hub-control-engraved-hover', '--hub-canvas-background', '--hub-glass-shadow',
  '--hub-glass-shadow-lg', '--hub-control-shadow', '--hub-control-shadow-hover',
  '--hub-control-engraved-shadow', '--hub-control-engraved-shadow-hover',
  '--shadow-md', '--shadow-lg', '--trust-fg', '--trust-bg', '--trust-border', '--trust-dot',
]);
const paintProperties = new Set([
  'animation', 'animation-duration', 'animation-delay', 'animation-iteration-count',
  'transition-duration', 'transition-delay', 'scroll-behavior',
  '-webkit-backdrop-filter', 'backdrop-filter', 'background', 'background-color',
  'background-position-x', 'color', 'border-color', 'filter', 'box-shadow',
]);

describe('low-spec geometry boundary', () => {
  it('limits profile declarations to paint without disabling controls or changing edit geometry', () => {
    // Given the actual expanded host stylesheet, including future low-spec imports.
    const css = parse(readExpandedIndexCss());
    const violations: string[] = [];
    let checked = 0;
    // When every low-profile declaration is classified by its effect.
    css.walkRules((rule) => {
      if (!rule.selector.includes('data-performance-profile')) return;
      checked += 1;
      rule.walkDecls((declaration) => {
        const property = declaration.prop;
        if (paintProperties.has(property)) return;
        if (paintTokens.has(property)) return;
        if (property === 'display' && declaration.value === 'none' && rule.selectors.every((selector) => /::(?:before|after)$| \.hub__wash$/.test(selector))) return;
        if (property === 'top' && rule.selector === 'html[data-performance-profile="low"] .plugins-home__card--gallery:hover .plugins-home__html-iframe' && declaration.value === '0') return;
        violations.push(`${rule.selector}: ${property}=${declaration.value}`);
      });
    });
    // Then layout, transforms, pointer-events, visibility and edit sizing cannot be overridden.
    expect(checked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
