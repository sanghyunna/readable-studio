/**
 * Composer footer cluster: model dropdown width, effort dropdown width, and the
 * send button's reserved place.
 *
 * DEFECTS this pins:
 *  1. The model listbox was 168px and produced a HORIZONTAL SCROLLBAR under the
 *     list. `overflow-y: auto` alone computes the other axis to `auto` too, so
 *     the list was a horizontal scroll container. This project already learned
 *     that `overflow-x: hidden` still creates a (click-swallowing) scroll
 *     container, so the axis must be `clip`.
 *  2. The trigger label was `max-width: none`, so a long model name grew the
 *     right-aligned cluster until SEND was squeezed out of the row. Send now
 *     has a reserved, non-shrinking place and the model label is the part that
 *     yields (truncate + hover/focus reveal).
 *  3. The thinking-effort panel inherited the model panel's width even though
 *     its options are short Korean words. Its width now comes from its own
 *     token.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const tokensCss = read('../../src/styles/tokens.css');
const homeHeroCssRaw = read('../../src/styles/home/home-hero.css');
const chatCssRaw = read('../../src/styles/chat.css');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const homeHeroCss = stripComments(homeHeroCssRaw);
const chatCss = stripComments(chatCssRaw);

function declarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function value(block: string, property: string): string {
  const matches = [
    ...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g')),
  ];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

function tokenPx(name: string): number {
  const match = tokensCss.match(new RegExp(`${name}:\\s*(\\d+)px;`));
  if (!match) throw new Error(`Missing token ${name}`);
  return Number(match[1]);
}

const MODEL_MENU_TOKEN = '--inline-switcher-model-menu-width';
const EFFORT_MENU_TOKEN = '--inline-switcher-effort-menu-width';
const LABEL_MAX_TOKEN = '--inline-switcher-trigger-label-max';

describe('model dropdown width', () => {
  it('sizes the model listbox from a token that is wider than the old 168px but far below the 320px panel', () => {
    const width = tokenPx(MODEL_MENU_TOKEN);

    expect(width).toBeGreaterThan(168);
    expect(width).toBeLessThan(224);
    expect(value(declarations(homeHeroCss, '.inline-switcher__popover--model'), 'width'))
      .toBe(`var(${MODEL_MENU_TOKEN})`);
  });

  it('opens the trigger to exactly the panel width on both surfaces', () => {
    const hubOpen = declarations(
      homeHeroCss,
      ".home-hero__execution-switcher--agent-model .inline-switcher__chip--model[aria-expanded='true']",
    );
    const workspaceOpen = declarations(
      chatCss,
      ".chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--model[aria-expanded='true']",
    );

    expect(value(hubOpen, 'width')).toBe(`var(${MODEL_MENU_TOKEN})`);
    expect(value(workspaceOpen, 'width')).toBe(`var(${MODEL_MENU_TOKEN})`);
  });

  it('never leaves a horizontal scroll container under the option list', () => {
    const list = declarations(chatCss, '.inline-switcher__model-list');

    expect(value(list, 'overflow-y')).toBe('auto');
    // `hidden` would still be a programmatically scrollable axis that swallows
    // clicks; `clip` is the only acceptable value here.
    expect(value(list, 'overflow-x')).toBe('clip');
    expect(list).not.toMatch(/overflow-x:\s*(hidden|auto|scroll)/);
    expect(list).not.toMatch(/overflow:\s*(auto|scroll)/);
  });
});

describe('thinking-effort dropdown width', () => {
  it('derives its width from its own token, narrower than the model list', () => {
    const effortWidth = tokenPx(EFFORT_MENU_TOKEN);
    const modelWidth = tokenPx(MODEL_MENU_TOKEN);

    expect(effortWidth).toBeLessThan(modelWidth);
    expect(value(declarations(homeHeroCss, '.inline-switcher__popover--reasoning'), 'width'))
      .toBe(`var(${EFFORT_MENU_TOKEN})`);
  });

  it('opens its trigger to its own width, not the model width', () => {
    const workspaceOpen = declarations(
      chatCss,
      ".chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--reasoning[aria-expanded='true']",
    );

    expect(value(workspaceOpen, 'width')).toBe(`var(${EFFORT_MENU_TOKEN})`);
  });

  it('keeps the interaction geometry identical to the model twin', () => {
    const effortChip = declarations(
      chatCss,
      '.chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--reasoning',
    );
    const modelChip = declarations(
      chatCss,
      '.chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--model',
    );

    expect(value(effortChip, 'gap')).toBe(value(modelChip, 'gap'));
    expect(value(effortChip, 'justify-content')).toBe(value(modelChip, 'justify-content'));
  });
});

describe('send button reservation', () => {
  it('never shrinks the Hub send button', () => {
    expect(value(declarations(homeHeroCss, '.home-hero__submit'), 'flex')).toBe('0 0 auto');
  });

  it('never shrinks the workspace send button', () => {
    expect(value(declarations(chatCss, '.composer-send'), 'flex')).toBe('0 0 auto');
  });

  it('makes the model label the part that yields on both surfaces', () => {
    const hubLabel = declarations(
      homeHeroCss,
      '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model .inline-switcher__chip-text',
    );
    const workspaceLabel = declarations(
      chatCss,
      '.composer-execution-switcher .inline-switcher__chip--model .inline-switcher__chip-text',
    );

    // `none` is what let the cluster grow without bound and push Send out.
    expect(value(hubLabel, 'max-width')).toBe(`var(${LABEL_MAX_TOKEN})`);
    expect(value(workspaceLabel, 'max-width')).toBe(`var(${LABEL_MAX_TOKEN})`);
    expect(tokenPx(LABEL_MAX_TOKEN)).toBeLessThan(tokenPx(MODEL_MENU_TOKEN));
  });

  it('lets the trigger cluster yield while the right-aligned leftward expansion survives', () => {
    const hubSlot = declarations(homeHeroCss, '.home-hero__execution-switcher--agent-model');
    const workspaceSlot = declarations(chatCss, '.composer-execution-switcher');

    for (const [name, slot] of [['hub', hubSlot], ['workspace', workspaceSlot]] as const) {
      expect(value(slot, 'flex'), name).toBe('0 1 auto');
      expect(value(slot, 'min-width'), name).toBe('0');
      // Right-aligned cluster; opening grows the trigger leftward.
      expect(value(slot, 'justify-content'), name).toBe('flex-end');
    }
  });
});

describe('overflowing-name reveal', () => {
  it('slides only labels marked as genuinely overflowing, on hover AND keyboard focus', () => {
    const revealRules = [
      ...chatCss.matchAll(/([^{}]*inline-switcher__model-option-label-text[^{}]*)\{([^}]*)\}/g),
    ];
    const revealing = revealRules.filter(([, , block]) => /translateX/.test(block ?? ''));
    expect(revealing.length).toBeGreaterThan(0);

    const selectors = revealing.map(([, selector]) => selector ?? '').join(',');
    // Engagement is gated on the measured overflow flag, never on hover alone.
    expect(selectors).toMatch(/\[data-overflowing='true'\]/);
    expect(selectors).toMatch(/:hover/);
    expect(selectors).toMatch(/:focus-visible/);
  });

  it('keeps a genuine 0s path under reduced motion', () => {
    const reducedMotionBlocks = [
      ...chatCssRaw.matchAll(
        /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g,
      ),
    ].map(([, body]) => body ?? '');
    const revealReduced = reducedMotionBlocks.filter((body) =>
      body.includes('inline-switcher__model-option-label-text'),
    );

    expect(revealReduced.length).toBeGreaterThan(0);
    expect(revealReduced.join('\n')).toMatch(/transition:\s*none/);
  });
});
