import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubCss = readFileSync(new URL('../../src/styles/home/hub.css', import.meta.url), 'utf8');

function ruleBody(selector: string, source = hubCss): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
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
