import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubCss = readFileSync(new URL('../../src/styles/home/hub.css', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');

function ruleBody(selector: string, source = hubCss): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escapedSelector}\\s*\\{([^}]+)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[2] ?? '';
}

describe('Hub rail motion contract', () => {
  it('expands the grid track with the enter duration and product easing without delay', () => {
    const hub = ruleBody('.workspace-shell__body', shellCss);

    expect(hub).toMatch(
      /transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)\s*;/,
    );
    expect(hub).not.toMatch(/transition-delay\s*:/);
  });

  it('collapses with the shorter exit duration without delaying the state change', () => {
    const collapsed = ruleBody(".workspace-shell__body:has(> [data-project-rail-state='collapsed'])", shellCss);

    expect(collapsed).toMatch(/transition-duration:\s*var\(--dur-exit\)\s*;/);
    expect(collapsed).not.toMatch(/transition-delay\s*:/);
  });

  it('animates the expanded inset away while the rail stretches with its track', () => {
    const rail = ruleBody('.hub__nav');
    const collapsedRail = ruleBody(".hub__nav[data-project-rail-state='collapsed']");

    // `100%` ignores a grid item's margin and made the 10px-inset rail occupy
    // the complete 292px track. Auto stretch subtracts the live margin, giving
    // 282px expanded and 44px collapsed without a state-only width snap.
    expect(rail).toMatch(/inline-size:\s*auto\s*;/);
    expect(rail).toMatch(
      /transition:\s*margin-inline-start\s+var\(--dur-enter\)\s+var\(--ease-out\)\s*;/,
    );
    expect(collapsedRail).toMatch(/margin:\s*0\s*;/);
    expect(collapsedRail).toMatch(/transition-duration:\s*var\(--dur-exit\)\s*;/);
  });

  it('uses product motion tokens while preserving a duration with no exact token', () => {
    const chevron = ruleBody('.hub-row__chevron');
    const search = ruleBody("[data-project-rail-state='collapsed'] .hub__search");

    expect(chevron).toMatch(
      /transition:\s*transform\s+var\(--dur-enter\)\s+var\(--ease-out\)\s*;/,
    );
    expect(search).toMatch(/transition:\s*width\s+160ms\s+var\(--ease-out\)\s*;/);
  });

  it('reduces the root grid transition to at most one millisecond', () => {
    const reducedHub = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.hub \*::after\s*\{([^}]+)\}/.exec(hubCss)?.[1];
    expect(reducedHub).toBeDefined();

    const duration = /transition-duration:\s*([\d.]+)ms\s*!important\s*;/.exec(
      reducedHub ?? '',
    )?.[1];

    expect(Number(duration)).toBeLessThanOrEqual(1);
  });
});
