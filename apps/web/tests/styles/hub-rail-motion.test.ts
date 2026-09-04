import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubCss = readFileSync(new URL('../../src/styles/home/hub.css', import.meta.url), 'utf8');

function ruleBody(selector: string, source = hubCss): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escapedSelector}\\s*\\{([^}]+)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[2] ?? '';
}

describe('Hub rail motion contract', () => {
  it('expands the grid track with the enter duration and product easing without delay', () => {
    const hub = ruleBody('.hub');

    expect(hub).toMatch(
      /transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)\s*;/,
    );
    expect(hub).not.toMatch(/transition-delay\s*:/);
  });

  it('collapses with the shorter exit duration without delaying the state change', () => {
    const collapsed = ruleBody('.hub--rail-collapsed');

    expect(collapsed).toMatch(/transition-duration:\s*var\(--dur-exit\)\s*;/);
    expect(collapsed).not.toMatch(/transition-delay\s*:/);
  });

  it('uses product motion tokens while preserving a duration with no exact token', () => {
    const chevron = ruleBody('.hub-row__chevron');
    const search = ruleBody('.hub--rail-collapsed .hub__search');

    expect(chevron).toMatch(
      /transition:\s*transform\s+var\(--dur-enter\)\s+var\(--ease-out\)\s*;/,
    );
    expect(search).toMatch(/transition:\s*width\s+160ms\s+var\(--ease-out\)\s*;/);
  });

  it('reduces the root grid transition to at most one millisecond', () => {
    const reducedHub = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.hub,\s*\.hub \*,\s*\.hub \*::before,\s*\.hub \*::after\s*\{([^}]+)\}/.exec(
      hubCss,
    )?.[1];
    expect(reducedHub).toBeDefined();

    const duration = /transition-duration:\s*([\d.]+)ms\s*!important\s*;/.exec(
      reducedHub ?? '',
    )?.[1];

    expect(Number(duration)).toBeLessThanOrEqual(1);
  });
});
