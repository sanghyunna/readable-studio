import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `viewer/routines.css` imports after `chat.css`, but owns chat geometry only.
 * These tests resolve the actual author cascade so a later geometry rule cannot
 * silently reclaim material or force chat.css back to specificity guards.
 */

const indexCss = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
const chatCss = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');
const routinesCss = readFileSync(
  new URL('../../src/styles/viewer/routines.css', import.meta.url),
  'utf8',
);

const importOrder = [
  ...indexCss.matchAll(/@import\s+'\.\/([^']+)'/g),
].map((match) => match[1] as string);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Removes conditional blocks so a base lookup cannot read a media override. */
function baseCascade(css: string): string {
  const source = stripComments(css);
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('@media', index);
    if (start < 0) return result + source.slice(index);
    result += source.slice(index, start);
    const open = source.indexOf('{', start);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    index = cursor;
  }
  return result;
}

function splitSelectorList(head: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of head) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      selectors.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  selectors.push(current);
  return selectors.map((selector) => selector.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function ruleBodies(css: string, selector: string): string[] {
  const source = baseCascade(css);
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (splitSelectorList(match[1] ?? '').includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies;
}

function propertyValue(css: string, selector: string, property: string): string | undefined {
  const matches = [
    ...ruleBodies(css, selector)
      .join('\n')
      .matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g')),
  ];
  return matches.at(-1)?.[1]?.trim();
}

/** Class-column specificity; all material competitors use classes only. */
function specificity(selector: string): number {
  return (selector.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length;
}

interface Candidate {
  readonly css: string;
  readonly sheet: string;
  readonly selector: string;
}

/** Author cascade: specificity wins; import order breaks a tie. */
function resolvedWinner(property: string, candidates: readonly Candidate[]): {
  readonly sheet: string;
  readonly selector: string;
  readonly value: string;
} {
  const winner = [...candidates]
    .map((candidate) => {
      const value = propertyValue(candidate.css, candidate.selector, property);
      return value === undefined
        ? null
        : {
            ...candidate,
            value,
            specificity: specificity(candidate.selector),
            order: importOrder.indexOf(candidate.sheet),
          };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    .at(-1);
  if (!winner) throw new Error(`No candidates for ${property}`);
  return { sheet: winner.sheet, selector: winner.selector, value: winner.value };
}

const CHAT_SHEET = 'styles/chat.css';
const SHELL_SHEET = 'styles/shell.css';
const ROUTINES_SHEET = 'styles/viewer/routines.css';

describe('workspace chat material — resolved cascade winner', () => {
  it('models the real late-import hazard', () => {
    expect(importOrder.indexOf(ROUTINES_SHEET)).toBeGreaterThan(importOrder.indexOf(CHAT_SHEET));
    expect(importOrder.indexOf(ROUTINES_SHEET)).toBeGreaterThan(importOrder.indexOf(SHELL_SHEET));
  });

  it('lets the shell lane own the pane glass without a chat.css competitor', () => {
    const shell = '.app .split > .split-chat-slot > .pane';
    const routines = '.app .split-chat-slot > .pane';
    const winner = resolvedWinner('background', [
      { css: shellCss, sheet: SHELL_SHEET, selector: shell },
      { css: routinesCss, sheet: ROUTINES_SHEET, selector: routines },
    ]);

    expect(winner).toEqual({ sheet: SHELL_SHEET, selector: shell, value: 'var(--hub-glass-fill)' });
    expect(specificity(shell)).toBeGreaterThan(specificity(routines));
    expect(chatCss).not.toMatch(/\.app \.split-chat-slot > \.pane\s*\{/);
  });

  it('keeps the transcript transparent while routines owns only its geometry', () => {
    const chat = '.chat-log';
    const routines = '.app .chat-log';
    const winner = resolvedWinner('background', [
      { css: chatCss, sheet: CHAT_SHEET, selector: chat },
      { css: routinesCss, sheet: ROUTINES_SHEET, selector: routines },
    ]);

    expect(winner).toEqual({ sheet: CHAT_SHEET, selector: chat, value: 'transparent' });
  });

  it.each([
    ['in-pane', '.app .composer-shell'],
    ['portaled', '.chat-composer-fixed-layer .composer-shell'],
  ])('resolves the %s composer to the shared glass material', (_mount, routines) => {
    const chat = '.composer-shell';
    const candidates = [
      { css: chatCss, sheet: CHAT_SHEET, selector: chat },
      { css: routinesCss, sheet: ROUTINES_SHEET, selector: routines },
    ];

    expect(resolvedWinner('background', candidates).value).toContain('var(--hub-composer-fill)');
    expect(resolvedWinner('backdrop-filter', candidates).value).toBe('var(--hub-glass-blur)');
    expect(resolvedWinner('box-shadow', candidates).value).toContain('var(--hub-glass-shadow)');
  });

  it('resolves the portaled input wrap to the shared tonal zone', () => {
    const chat = '.composer-input-wrap';
    const routines = '.chat-composer-fixed-layer .composer-input-wrap';
    const candidates = [
      { css: chatCss, sheet: CHAT_SHEET, selector: chat },
      { css: routinesCss, sheet: ROUTINES_SHEET, selector: routines },
    ];

    expect(resolvedWinner('background', candidates).value).toBe('var(--hub-composer-body)');
    expect(resolvedWinner('border', candidates).value).toBe('0');
    expect(resolvedWinner('box-shadow', candidates).value).toBe('none');
  });

  it('resolves the portaled send button to the shared ready material', () => {
    const chat = '.composer-send';
    const routines = '.chat-composer-fixed-layer .composer-send';
    const candidates = [
      { css: chatCss, sheet: CHAT_SHEET, selector: chat },
      { css: routinesCss, sheet: ROUTINES_SHEET, selector: routines },
    ];

    expect(resolvedWinner('background', candidates).value).toBe('var(--hub-accent)');
    expect(resolvedWinner('box-shadow', candidates).value).toContain('var(--hub-ready-shadow)');
  });

  it('keeps the fixed-layer toolbar separator absent at ordinary specificity', () => {
    const selector = '.chat-composer-fixed-layer .composer-row';

    expect(propertyValue(chatCss, selector, 'box-shadow')).toBe('none');
    expect(chatCss).not.toMatch(/\.(chat-log|composer-shell|composer-input-wrap|composer-row|composer-send)\.\1/);
  });
});
