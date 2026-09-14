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
    const selectors = selectorList(match[1] ?? '');
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

/** The sheet wraps long selectors across lines; compare them collapsed. */
function selectorList(prelude: string): string[] {
  return prelude.split(',').map((item) => item.replace(/\s+/g, ' ').trim());
}

function ruleValue(block: string, property: string): string {
  const matches = [
    ...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g')),
  ];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

const chevronRuleSelectors = (() => {
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = selectorList(match[1] ?? '');
    if (
      selectors.includes(
        '.home-hero__execution-switcher--agent-model .inline-switcher__chip--agent .inline-switcher__chip-chevron',
      )
    ) {
      return selectors;
    }
  }
  throw new Error('Missing agent chevron rule');
})();

describe('Hub composer footer: agent icon -> model name -> effort -> send', () => {
  it('renders the agent/model mount point before the send button', () => {
    const agentModel = homeHeroTsx.indexOf('home-hero-agent-model');
    const submit = homeHeroTsx.indexOf('home-hero-submit');

    expect(agentModel).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    // Send stays last in the footer's right cluster.
    expect(agentModel).toBeLessThan(submit);
  });

  it('ends the agent trigger in the model trigger\'s chevron and sizes it to icon + gap + chevron', () => {
    const agent = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--agent',
    );
    const model = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model',
    );
    const agentChevron = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--agent .inline-switcher__chip-chevron',
    );
    const modelChevron = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model .inline-switcher__chip-chevron',
    );

    // The agent target is intrinsic: the icon, the model trigger's
    // label -> chevron gap, then the chevron. No fixed square, no padding.
    expect(ruleValue(agent, 'width')).toBe('auto');
    expect(ruleValue(agent, 'min-width')).toBe('0');
    expect(ruleValue(agent, 'padding')).toBe('0');
    expect(ruleValue(agent, 'gap')).toBe(ruleValue(model, 'gap'));
    expect(ruleValue(agent, 'justify-content')).toBe('flex-start');

    // One chevron rule covers every trigger in the cluster, so the agent glyph
    // can only ever be styled together with the model glyph.
    expect(chevronRuleSelectors).toContain(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model .inline-switcher__chip-chevron',
    );
    expect(chevronRuleSelectors).toContain(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning .inline-switcher__chip-chevron',
    );
    expect(agentChevron).toBe(modelChevron);
    expect(ruleValue(agentChevron, 'display')).toBe('block');
    expect(ruleValue(agentChevron, 'flex')).toBe('0 0 auto');
    // No rule in this sheet takes the chevron back out of the agent trigger.
    expect(cssWithoutComments).not.toMatch(
      /inline-switcher__chip--agent[^{]*inline-switcher__chip-chevron[^{]*\{[^}]*display:\s*none/,
    );
  });

  it('makes the effort trigger a geometry twin of the model trigger', () => {
    const modelMount = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher--model',
    );
    const effortMount = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher--reasoning',
    );
    const model = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model',
    );
    const effort = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning',
    );
    const modelLabel = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model .inline-switcher__chip-text',
    );
    const effortLabel = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning .inline-switcher__chip-text',
    );
    const openEffort = cssDeclarations(
      ".home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning[aria-expanded='true']",
    );

    // Same mount, trigger and label declarations: one rule serves both.
    expect(effortMount).toBe(modelMount);
    expect(effort).toBe(model);
    expect(effortLabel).toBe(modelLabel);
    expect(ruleValue(effortMount, 'flex')).toBe('0 0 auto');
    expect(ruleValue(effort, 'width')).toBe('auto');
    expect(ruleValue(effort, 'padding')).toBe('0');
    expect(ruleValue(effort, 'gap')).toBe('3px');
    expect(ruleValue(effort, 'justify-content')).toBe('flex-start');
    expect(ruleValue(effort, 'border')).toBe('0');
    expect(ruleValue(effort, 'border-radius')).toBe('0');
    expect(ruleValue(effort, 'background')).toBe('transparent');
    expect(ruleValue(effort, 'box-shadow')).toBe('none');
    expect(ruleValue(effort, 'transition')).toBe('width 160ms var(--ease-out)');
    expect(ruleValue(effortLabel, 'max-width')).toBe('var(--inline-switcher-trigger-label-max)');
    // Interaction twin, not a width twin: it opens to the effort menu width.
    expect(ruleValue(openEffort, 'width')).toBe('var(--inline-switcher-effort-menu-width)');

    // Hub skin and hover follow the model trigger through shared selectors.
    const hubModel = cssDeclarations(
      '.home-view--hub .home-hero__execution-switcher--agent-model .inline-switcher__chip--model',
    );
    const hubEffort = cssDeclarations(
      '.home-view--hub .home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning',
    );
    expect(hubEffort).toBe(hubModel);
    expect(ruleValue(hubEffort, 'background')).toBe('transparent');
    const hubEffortHover = cssDeclarations(
      '.home-view--hub .home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning:hover:not(:disabled)',
    );
    expect(ruleValue(hubEffortHover, 'color')).toBe('var(--hub-accent)');
  });

  it('drops the width transition for both triggers under reduced motion', () => {
    const reducedMotion = [
      ...homeHeroCss.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g),
    ].map(([, body]) => body ?? '');
    const cluster = reducedMotion.filter((body) =>
      body.includes('.home-hero__execution-switcher--agent-model .inline-switcher__chip--model'),
    );

    expect(cluster).toHaveLength(1);
    expect(cluster[0]).toContain(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--reasoning',
    );
    expect(cluster[0]).toMatch(/transition:\s*none/);
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

  it('keeps one intrinsic right-aligned cluster and widens the model leftward', () => {
    const slot = cssDeclarations('.home-hero__execution-switcher--agent-model');
    const modelMount = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher--model',
    );
    const modelChip = cssDeclarations(
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model',
    );
    const openModelChip = cssDeclarations(
      ".home-hero__execution-switcher--agent-model .inline-switcher__chip--model[aria-expanded='true']",
    );
    const modelPopover = cssDeclarations('.inline-switcher__popover--model');

    expect(ruleValue(slot, 'justify-content')).toBe('flex-end');
    expect(ruleValue(slot, 'gap')).toBe('2px');
    expect(ruleValue(slot, 'width')).toBe('auto');
    expect(ruleValue(modelMount, 'width')).toBe('auto');
    expect(ruleValue(openModelChip, 'width')).toBe('var(--inline-switcher-model-menu-width)');
    expect(ruleValue(modelPopover, 'width')).toBe('var(--inline-switcher-model-menu-width)');
    // The model affordance is intentionally text + chevron, not a nested pill.
    expect(ruleValue(modelChip, 'border')).toBe('0');
    expect(ruleValue(modelChip, 'border-radius')).toBe('0');
    expect(ruleValue(modelChip, 'background')).toBe('transparent');
    expect(ruleValue(modelChip, 'box-shadow')).toBe('none');
  });

  it('falls back to an opaque surface under reduced transparency', () => {
    expect(cssWithoutComments).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });

  it('removes the template control and its dead string', () => {
    expect(homeHeroTsx).not.toContain('home-hero-template-control');
    expect(homeHeroTsx).not.toContain('hub.noTemplate');
  });
});
