import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Chat pane project header — two-line title metadata must fit.
 *
 * The header carries a back button, an editable project title with a
 * secondary meta line below it (`.chat-project-title-line` stacks `.title`
 * over `.meta`), and the session-history trigger. The defect: the header was
 * sized for a single text line (fixed 38px height, 8px vertical padding →
 * 22px content box) while the title stack measures ~36px (title line-height
 * 18px + 2px vertical padding, meta line-height 16px). The wrapper keeps
 * `overflow: hidden` for the title ellipsis (pinned by
 * BriefCard.headerClipping.test.tsx), so the fixed height clips/crowds the
 * second line instead of growing.
 *
 * The fix must raise the header's vertical capacity (min-height + padding),
 * not hide overflow or shrink text: the ellipsis contract, the 28px icon hit
 * targets, and center alignment all stay.
 */

const chatCss = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8');
const cssWithoutComments = chatCss.replace(/\/\*[\s\S]*?\*\//g, '');

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

function collectRules(css: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let headStart = 0;
  let depth = 0;
  let blockStart = 0;
  let head = '';

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) {
        head = css.slice(headStart, i).replace(/\s+/g, ' ').trim();
        blockStart = i + 1;
      }
      continue;
    }
    if (ch !== '}') continue;

    depth -= 1;
    if (depth !== 0) continue;

    const block = css.slice(blockStart, i);
    if (head.startsWith('@')) {
      for (const [nestedHead, bodies] of collectRules(block)) {
        rules.set(nestedHead, [...(rules.get(nestedHead) ?? []), ...bodies]);
      }
    } else {
      const keys = new Set([head, ...splitSelectorList(head)]);
      for (const key of keys) {
        rules.set(key, [...(rules.get(key) ?? []), block]);
      }
    }
    headStart = i + 1;
  }

  return rules;
}

const RULES = collectRules(cssWithoutComments);

function ruleBody(selector: string): string {
  const body = RULES.get(selector.replace(/\s+/g, ' ').trim())?.[0];
  if (body === undefined) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

/** First declared px value for a property within a rule body. */
function pxValue(body: string, property: string): number {
  const match = body.match(new RegExp(`${property}:\\s*([0-9.]+)px`));
  if (!match) throw new Error(`Missing ${property} px declaration in: ${body}`);
  return Number.parseFloat(match[1]!);
}

/** Vertical padding total from a `padding: <y> <x>` shorthand. */
function verticalPadding(body: string): number {
  const match = body.match(/padding:\s*([0-9.]+)px\s+[0-9.]+px/);
  if (!match) throw new Error(`Missing padding shorthand in: ${body}`);
  return Number.parseFloat(match[1]!) * 2;
}

// The stacked title block the header must contain, measured from the shipped
// rules: title line-height + title vertical padding + meta line-height.
const TITLE_LINE = pxValue(ruleBody('.chat-project-header-title .title'), 'line-height');
const TITLE_PAD_Y = verticalPadding(ruleBody('.chat-project-header-title .title'));
const META_LINE = pxValue(ruleBody('.chat-project-header-title .meta'), 'line-height');
const TWO_LINE_STACK = TITLE_LINE + TITLE_PAD_Y + META_LINE; // 18 + 2 + 16 = 36

describe('chat project header — two-line title metadata fits', () => {
  it('does not pin a fixed height smaller than the stacked title + meta', () => {
    const header = ruleBody('.chat-project-header');

    // A fixed `height` is the defect: it clips the second line through the
    // wrapper's overflow:hidden. The header may declare `min-height`, never
    // a fixed `height`.
    expect(header).not.toMatch(/(^|;)\s*height:\s*[0-9.]+px/);
  });

  it('reserves at least the two-line stack plus its vertical padding', () => {
    const header = ruleBody('.chat-project-header');
    const minHeight = pxValue(header, 'min-height');
    const paddingY = verticalPadding(header);

    // Content box at min-height must hold the full two-line stack.
    expect(minHeight - paddingY).toBeGreaterThanOrEqual(TWO_LINE_STACK);
  });

  it('keeps the title ellipsis contract and the icon hit targets', () => {
    // overflow:hidden on the wrapper is what truncates long titles — it must
    // survive (also pinned structurally by BriefCard.headerClipping tests).
    expect(ruleBody('.chat-project-header-title')).toMatch(/overflow:\s*hidden/);
    expect(ruleBody('.chat-project-header-title .title')).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleBody('.chat-project-header-title .meta')).toMatch(/text-overflow:\s*ellipsis/);

    // Back button and session trigger hit areas stay at 28x28.
    expect(pxValue(ruleBody('.chat-project-back'), 'width')).toBeGreaterThanOrEqual(28);
    expect(pxValue(ruleBody('.chat-project-back'), 'height')).toBeGreaterThanOrEqual(28);
    expect(pxValue(ruleBody('.chat-session-trigger'), 'width')).toBeGreaterThanOrEqual(28);
    expect(pxValue(ruleBody('.chat-session-trigger'), 'height')).toBeGreaterThanOrEqual(28);

    // Icons stay vertically centered against the taller header.
    expect(ruleBody('.chat-project-header')).toMatch(/align-items:\s*center/);
  });
});
