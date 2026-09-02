import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatCss = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');

const cssWithoutComments = chatCss.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Walks the stylesheet's braces and indexes every declaration block by its
 * normalized selector list, including blocks nested inside at-rules. Matching
 * the selector list exactly (rather than by substring) lets a test pin
 * `.composer-shell` without accidentally grabbing
 * `.composer.drag-active .composer-shell`.
 */
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
      // Preserve the authored selector list for grouped-rule assertions and
      // also index each member so callers can inspect one selector directly.
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
const SHELL_RULES = collectRules(shellCss.replace(/\/\*[\s\S]*?\*\//g, ''));

/** Declaration body of the first rule whose selector list matches exactly. */
function ruleBody(selector: string, rules = RULES): string {
  const body = rules.get(selector.replace(/\s+/g, ' ').trim())?.[0];
  if (body === undefined) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

/** The v5 workspace material is expressed only through these recipe tokens. */
const GLASS_SURFACE_TOKENS = [
  '--hub-glass-fill',
  '--hub-glass-blur',
  '--hub-pearl-highlight',
  '--hub-glass-shadow',
] as const;

describe('workspace v5 — chat pane glass surface', () => {
  it('paints the chat pane as a borderless translucent glass tier', () => {
    const body = ruleBody('.app .split > .split-chat-slot > .pane', SHELL_RULES);

    expect(body).toMatch(/border:\s*0\s*;/);
    for (const token of GLASS_SURFACE_TOKENS) {
      expect(body).toContain(`var(${token})`);
    }
    expect(body).toMatch(/-webkit-backdrop-filter:\s*var\(--hub-glass-blur\)/);
  });

  it('keeps the project header on the pane without a boxed sub-card', () => {
    const header = ruleBody('.chat-project-header');

    expect(header).toMatch(/background:\s*transparent\s*;/);
    // Separation is a pearl light ray, never a grey rule (hub-dna tier 4).
    expect(header).toMatch(/box-shadow:\s*inset 0 -1px 0 var\(--hub-pearl-highlight\)\s*;/);
    expect(header).not.toMatch(/border-bottom:\s*1px/);
  });

  it('keeps the transcript transparent so the pane glass shows through', () => {
    expect(ruleBody('.chat-log')).toMatch(/background:\s*transparent\s*;/);
  });
});

describe('workspace v5 — composer as the strongest single glass surface', () => {
  it('makes .composer-shell the one continuous glass shell', () => {
    const shell = ruleBody('.composer-shell');

    expect(shell).toMatch(/border:\s*0\s*;/);
    expect(shell).toContain('var(--hub-composer-fill)');
    expect(shell).toContain('var(--hub-composer-top)');
    expect(shell).toContain('var(--hub-composer-bottom)');
    expect(shell).toMatch(/backdrop-filter:\s*var\(--hub-glass-blur\)/);
    expect(shell).toContain('var(--hub-pearl-highlight)');
    expect(shell).toContain('var(--hub-glass-shadow)');
  });

  it('dissolves the nested input box into a tonal zone', () => {
    const wrap = ruleBody('.composer-input-wrap');

    expect(wrap).toMatch(/border:\s*0\s*;/);
    expect(wrap).toMatch(/background:\s*var\(--hub-composer-body\)\s*;/);
    // No box-in-box: the inner wrap must not carry its own elevation.
    expect(wrap).toMatch(/box-shadow:\s*none\s*;/);
  });

  it('replaces the composer-row rule with a pearl ray instead of a border', () => {
    const row = ruleBody('.composer-row');

    expect(row).toMatch(/border-top:\s*0\s*;/);
    expect(row).toMatch(/box-shadow:\s*inset 0 1px 0 var\(--hub-pearl-highlight\)\s*;/);
    // Geometry is preserved: the toolbar keeps its 8px breathing room.
    expect(row).toMatch(/padding-top:\s*8px\s*;/);
  });

  it('keeps the design-system row separated by a ray, not a hairline', () => {
    const row = ruleBody('.composer-design-system-row');

    expect(row).toMatch(/border-bottom:\s*0\s*;/);
    expect(row).toContain('var(--hub-pearl-highlight)');
  });

  it('keeps the send button a solid accent fill', () => {
    const send = ruleBody('.composer-send');

    expect(send).toMatch(/background:\s*var\(--hub-accent\)\s*;/);
    expect(send).toContain('var(--hub-accent-fg)');
    expect(send).toContain('var(--hub-ready-shadow)');
    expect(send).toContain('var(--hub-ready-highlight)');
  });
});

describe('workspace v5 — controls are transparent at rest, tonal on hover', () => {
  it.each([
    ['.chat-project-back', '.chat-project-back:hover'],
    ['.chat-session-trigger', '.chat-session-trigger:hover, .chat-session-switcher.open .chat-session-trigger'],
  ])('%s rests transparent and lifts into control glass', (restSelector, hoverSelector) => {
    expect(ruleBody(restSelector)).toMatch(/background:\s*transparent\s*;/);

    const hover = ruleBody(hoverSelector);
    expect(hover).toMatch(/background:\s*var\(--hub-control-surface-hover\)\s*;/);
    expect(hover).toContain('var(--hub-control-shadow-hover)');
  });

  it('gives composer icon buttons the same rest/hover control values', () => {
    expect(ruleBody('.composer-row .icon-btn')).toMatch(/background:\s*transparent\s*;/);

    const hover = ruleBody('.composer-row .icon-btn:hover:not(:disabled)');
    expect(hover).toMatch(/background:\s*var\(--hub-control-surface-hover\)\s*;/);
    expect(hover).toMatch(/border-color:\s*transparent\s*;/);
  });

  it('tones queued rows with control surfaces rather than opaque fills', () => {
    expect(ruleBody('.chat-queued-send-row:hover')).toMatch(
      /background:\s*var\(--hub-control-surface\)\s*;/,
    );
    expect(ruleBody('.chat-queued-send-row-active')).toMatch(
      /background:\s*var\(--hub-accent-fill\)\s*;/,
    );
  });
});

/** Later stylesheet imports must leave the canonical chat material untouched. */
describe('workspace v5 — material survives the later stylesheet imports', () => {
  it('uses the ordinary composer rule for both mounts', () => {
    const shell = ruleBody('.composer-shell');

    expect(shell).toMatch(/border:\s*0\s*;/);
    expect(shell).toContain('var(--hub-composer-fill)');
    expect(shell).toMatch(/backdrop-filter:\s*var\(--hub-glass-blur\)/);
    expect(shell).toContain('var(--hub-glass-shadow)');
  });

  it('keeps the transcript transparent without a specificity guard', () => {
    expect(ruleBody('.chat-log')).toMatch(/background:\s*transparent\s*;/);
  });

  it('dissolves the input box into a shared tonal zone', () => {
    const wrap = ruleBody('.composer-input-wrap');

    expect(wrap).toMatch(/border:\s*0\s*;/);
    expect(wrap).toMatch(/background:\s*var\(--hub-composer-body\)\s*;/);
    expect(wrap).toMatch(/box-shadow:\s*none\s*;/);
  });

  it('keeps the send button solid accent through its ordinary rule', () => {
    const send = ruleBody('.composer-send');

    expect(send).toMatch(/background:\s*var\(--hub-accent\)\s*;/);
    expect(send).toContain('var(--hub-ready-shadow)');
  });
});

describe('workspace v5 — reduced transparency fallback', () => {
  it('drops the blur and restores an opaque panel under prefers-reduced-transparency', () => {
    const guard = '@media (prefers-reduced-transparency: reduce)';
    const guardIndex = chatCss.indexOf(guard);
    expect(guardIndex, `missing reduced-transparency guard: ${guard}`).toBeGreaterThan(-1);

    const block = chatCss.slice(guardIndex);
    expect(block).toContain('.composer-shell');
    const shellFallback = shellCss.slice(
      shellCss.indexOf('@media (prefers-reduced-transparency: reduce)'),
    );
    expect(shellFallback).toContain('.app .split > .split-chat-slot > .pane');
    expect(shellFallback).toMatch(/backdrop-filter:\s*none/);
    expect(block).toMatch(/backdrop-filter:\s*none/);
    expect(block).toContain('var(--bg-panel)');
    // The glass fill and blur must not survive into the fallback.
    expect(block).not.toContain('var(--hub-glass-blur)');
  });
});

describe('workspace v5 — material regions use tokens, never color literals', () => {
  it('introduces no hex or rgb literals anywhere in chat.css', () => {
    const withoutComments = chatCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = withoutComments.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];

    expect(literals).toEqual([]);
  });
});
