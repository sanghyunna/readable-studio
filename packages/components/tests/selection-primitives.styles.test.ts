import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/selection-primitives.module.css'), 'utf8');

describe('selection primitive styles', () => {
  it('provides state, focus, and adaptive-mode contracts without disallowed treatments', () => {
    // Given
    const requiredContracts = [
      '[data-state=\'on\']',
      ':hover:not(:disabled)',
      ':active:not(:disabled)',
      ':focus-visible',
      '@media (prefers-reduced-motion: reduce)',
      '@media (prefers-reduced-transparency: reduce)',
      '@media (forced-colors: active)',
    ];

    // When
    const missingContracts = requiredContracts.filter((contract) => !css.includes(contract));

    // Then
    expect(missingContracts).toEqual([]);
    expect(css).not.toMatch(/gradient|rgba?\(|#[\da-f]{3,8}|var\(--black\)/i);
  });
});
