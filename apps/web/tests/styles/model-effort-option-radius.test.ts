/**
 * Composer dropdown rows: the selected/active row's highlight is a soft
 * ROUNDED RECTANGLE drawn from the radius token scale.
 *
 * The thinking-effort menu and the model menu are the same anchored listbox
 * (`.inline-switcher__model-option` rows, painted once in chat.css), and they
 * sit side by side in the composer cluster. The owner reported the active row
 * reading as a square slab against the menu's rounded surface; this pins the
 * radius to the canonical control-step token so a refactor cannot square it
 * (or pill it) again, and keeps the inline padding that stops the fill from
 * hugging the label.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const tokensCss = read('../../src/styles/tokens.css');
const chatCss = stripComments(read('../../src/styles/chat.css'));
const directListboxTsx = read('../../src/components/DirectListbox.tsx');
const inlineSwitcherTsx = read('../../src/components/InlineModelSwitcher.tsx');

const OPTION = '.inline-switcher__model-option';
const RADIUS_TOKEN = '--radius-control';

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

describe('composer dropdown selected-row radius', () => {
  it('rounds the shared option row from the canonical control-step token', () => {
    expect(value(declarations(chatCss, OPTION), 'border-radius')).toBe(`var(${RADIUS_TOKEN})`);
  });

  it('reads as a rounded rectangle: rounder than square, never a pill', () => {
    const radius = tokenPx(RADIUS_TOKEN);
    const rowHeight = Number.parseInt(value(declarations(chatCss, OPTION), 'min-height'), 10);

    expect(radius).toBeGreaterThan(0);
    // A radius of half the row height (or the pill token) would be a capsule.
    expect(radius).toBeLessThan(rowHeight / 2);
    expect(radius).toBeLessThan(tokenPx('--radius-pill'));
  });

  it('keeps inline padding so the highlight does not hug the label', () => {
    const padding = value(declarations(chatCss, OPTION), 'padding').split(/\s+/);
    // `0 8px`: vertical inset is the row height's job, the inline inset is not.
    const inline = padding[1] ?? padding[0]!;
    expect(Number.parseInt(inline, 10)).toBeGreaterThan(0);
  });

  it('never re-squares or pills the row in a state override', () => {
    const stateBlocks = [
      ...chatCss.matchAll(/([^{}]*inline-switcher__model-option(?:\.is-active|:hover|:focus-visible|:focus)[^{}]*)\{([^}]*)\}/g),
    ].map(([, , block]) => block ?? '');
    expect(stateBlocks.length).toBeGreaterThan(0);
    for (const block of stateBlocks) {
      expect(block).not.toMatch(/border-radius\s*:/);
    }
  });

  it('applies to both the thinking-effort menu and the model menu', () => {
    // The effort list is authored inline in InlineModelSwitcher; the model
    // list is DirectListbox. Both mount the same row class, so the single
    // rule above is what each dropdown's selected row paints.
    expect(inlineSwitcherTsx).toMatch(/inline-model-switcher-reasoning-list[\s\S]*?inline-switcher__model-option\$\{selected \? ' is-active' : ''\}/);
    expect(directListboxTsx).toMatch(/inline-switcher__model-option\$\{isSelected \? ' is-active' : ''\}/);
  });
});
