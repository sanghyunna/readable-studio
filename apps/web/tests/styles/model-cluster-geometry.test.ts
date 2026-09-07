import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const chatCss = readFileSync(
  new URL('../../src/styles/chat.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

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

const hub = {
  slot: '.home-hero__execution-switcher--agent-model',
  mount: '.home-hero__execution-switcher--agent-model .inline-switcher--model',
  chip: '.home-hero__execution-switcher--agent-model .inline-switcher__chip--model',
  open: ".home-hero__execution-switcher--agent-model .inline-switcher__chip--model[aria-expanded='true']",
};
const workspace = {
  slot: '.composer-execution-switcher',
  mount: '.composer-execution-switcher .inline-switcher--model',
  chip: '.chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--model',
  open: ".chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--model[aria-expanded='true']",
};
const thinking = {
  mount: '.composer-execution-switcher .inline-switcher--reasoning',
  chip: '.chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--reasoning',
  open: ".chat-composer-fixed-layer .composer-row .composer-execution-switcher .inline-switcher__chip--reasoning[aria-expanded='true']",
};

describe('open agent/model cluster geometry', () => {
  it('keeps the icon, model label, and chevron adjacent while the Hub trigger expands left', () => {
    expect(value(declarations(homeHeroCss, hub.slot), 'gap')).toBe('2px');
    expect(value(declarations(homeHeroCss, hub.chip), 'gap')).toBe('3px');
    expect(value(declarations(homeHeroCss, hub.chip), 'justify-content')).toBe('flex-start');
    expect(value(declarations(homeHeroCss, hub.open), 'width'))
      .toBe('var(--inline-switcher-model-menu-width)');
    expect(value(declarations(homeHeroCss, hub.mount), 'flex')).toBe('0 0 auto');
  });

  it('uses the same non-shrinking open geometry in the workspace composer', () => {
    const hubOpenWidth = value(declarations(homeHeroCss, hub.open), 'width');
    const workspaceOpenWidth = value(declarations(chatCss, workspace.open), 'width');

    expect(value(declarations(chatCss, workspace.slot), 'gap')).toBe('2px');
    expect(value(declarations(chatCss, workspace.chip), 'gap')).toBe('3px');
    expect(value(declarations(chatCss, workspace.chip), 'justify-content')).toBe('flex-start');
    expect(value(declarations(chatCss, workspace.mount), 'flex')).toBe('0 1 auto');
    expect(value(declarations(chatCss, `${workspace.mount}:has(> [aria-expanded='true'])`), 'flex'))
      .toBe('0 0 auto');
    expect(workspaceOpenWidth).toBe(hubOpenWidth);
  });

  it('makes thinking effort an exact geometry twin of the workspace model picker', () => {
    expect(value(declarations(chatCss, thinking.chip), 'gap'))
      .toBe(value(declarations(chatCss, workspace.chip), 'gap'));
    expect(value(declarations(chatCss, thinking.chip), 'justify-content'))
      .toBe(value(declarations(chatCss, workspace.chip), 'justify-content'));
    expect(value(declarations(chatCss, thinking.mount), 'flex'))
      .toBe(value(declarations(chatCss, workspace.mount), 'flex'));
    // Interaction twin, deliberately NOT a width twin: the effort options are
    // short Korean words, so the panel is sized to its own content.
    expect(value(declarations(chatCss, thinking.open), 'width'))
      .toBe('var(--inline-switcher-effort-menu-width)');
    expect(value(declarations(chatCss, thinking.open), 'width'))
      .not.toBe(value(declarations(chatCss, workspace.open), 'width'));
  });

});
