import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Drops every `@media` block so a base-cascade lookup cannot read a conditional override. */
function baseCascade(css: string): string {
  const source = stripComments(css);
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('@media', index);
    if (start < 0) {
      result += source.slice(index);
      break;
    }
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

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const source = stripComments(css);
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(source)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

/**
 * Returns the bodies of EVERY `@media <query>` block, concatenated.
 *
 * A single-match lookup is wrong here: the frameless-window restructure added a
 * second `prefers-reduced-transparency` block for `.app-window-chrome` ahead of
 * the split-region one, so `indexOf` started resolving to the chrome fallback
 * and the pane fallback below it became invisible to this contract. Collecting
 * all blocks widens what the assertions can see rather than narrowing it.
 */
function mediaBlock(css: string, query: string): string {
  const source = stripComments(css);
  const needle = `@media ${query}`;
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(needle, cursor);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`Unclosed media query ${query}`);
    let depth = 1;
    let index = open + 1;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
    }
    if (depth !== 0) throw new Error(`Unclosed media query ${query}`);
    bodies.push(source.slice(open + 1, index - 1));
    cursor = index;
  }
  if (bodies.length === 0) throw new Error(`Missing media query ${query}`);
  return bodies.join('\n');
}

/** The workspace split region: from `.split` to the end of the resize handle rules. */
function projectShellRegion(): string {
  const source = stripComments(shellCss);
  const start = source.indexOf('.split {');
  if (start < 0) throw new Error('Missing .split rule');
  return source.slice(start);
}

/** Class-count component of CSS specificity — no ids or attribute selectors are used here. */
function classCount(selector: string): number {
  return (selector.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length;
}

const WORKSPACE_WASH_BLOOMS = [
  '--hub-wash-bloom-accent',
  '--hub-wash-bloom-warm',
  '--hub-wash-bloom-cool',
] as const;

describe('project workspace shell material', () => {
  it('paints no canvas of its own - the shell owns --hub-canvas-background and the split stays transparent to it', () => {
    const split = cssDeclarations(baseCascade(shellCss), '.split');

    // The ambient canvas is painted once on `.workspace-shell` for BOTH
    // surfaces; a private gradient stack here was what made the workspace's
    // light read as a different composition from the Hub's.
    expect(ruleValue(split, 'background')).toBe('transparent');
    expect(split).not.toContain('radial-gradient');

    const shell = cssDeclarations(baseCascade(shellCss), '.workspace-shell');
    expect(ruleValue(shell, 'background')).toBe('var(--hub-canvas-background)');
  });

  it('lights the working area with the shared wash blooms, not a private canvas', () => {
    const base = baseCascade(shellCss);
    const carriers = ['.app::before', '.split::after', '.split::before'] as const;
    const consumed = new Set<string>();
    for (const carrier of carriers) {
      const background = ruleValue(cssDeclarations(base, carrier), 'background');
      for (const bloom of WORKSPACE_WASH_BLOOMS) {
        if (background.includes(`var(${bloom})`)) consumed.add(bloom);
      }
    }
    expect([...consumed].sort()).toEqual([...WORKSPACE_WASH_BLOOMS].sort());

    // The warm bloom is anchored to the chat pane's outer edge (the inline
    // `--project-chat-panel-width` custom property on `.split`), so its falloff
    // lights the pane/stage boundary band instead of the corner tails.
    const warm = cssDeclarations(base, '.split::after');
    expect(ruleValue(warm, 'background')).toBe('var(--hub-wash-bloom-warm)');
    expect(ruleValue(warm, 'inset')).toContain('var(--project-chat-panel-width');
    expect(ruleValue(warm, 'filter')).toMatch(/^blur\(/);
  });

  it('separates the panes with canvas gutters instead of a shared flat fill', () => {
    const split = cssDeclarations(baseCascade(shellCss), '.split');

    expect(ruleValue(split, 'gap')).toBe('var(--workspace-shell-gutter)');
    expect(ruleValue(split, 'padding')).toContain('var(--workspace-shell-gutter)');
  });

  it('out-specifies the legacy .app compiled-routine overrides so the shell material actually paints', () => {
    const base = baseCascade(shellCss);

    // `viewer/routines.css` is imported after shell.css and repaints these same
    // boxes flat; each shell selector must therefore outrank its override.
    const contract = [
      { shell: '.app .split.split', beats: '.app .split' },
      { shell: '.app .split > .split-chat-slot > .pane', beats: '.app .split-chat-slot > .pane' },
      { shell: '.app .split > .workspace', beats: '.app .workspace' },
    ] as const;

    for (const { shell, beats } of contract) {
      expect(() => cssDeclarations(base, shell)).not.toThrow();
      expect(classCount(shell)).toBeGreaterThan(classCount(beats));
    }
  });

  // Prefix-first order is load-bearing: Lightning CSS (Tailwind 4) drops the
  // unprefixed declaration when it is authored first, which silently resolves
  // `backdrop-filter: none` at runtime while the source still claims glass.
  it('authors the pane backdrop-filter prefix-first so Lightning CSS keeps both declarations', () => {
    const pane = cssDeclarations(baseCascade(shellCss), '.app .split > .split-chat-slot > .pane');

    expect(pane.indexOf('-webkit-backdrop-filter')).toBeGreaterThanOrEqual(0);
    expect(pane.indexOf('-webkit-backdrop-filter')).toBeLessThan(
      pane.indexOf('backdrop-filter:', pane.indexOf('-webkit-backdrop-filter') + 1),
    );
  });

  it('gives the chat pane the hub glass fill, blur and pearl-lit shadow with no border', () => {
    const pane = cssDeclarations(baseCascade(shellCss), '.app .split > .split-chat-slot > .pane');

    expect(ruleValue(pane, 'background')).toBe('var(--hub-glass-fill)');
    expect(ruleValue(pane, 'backdrop-filter')).toBe('var(--hub-glass-blur)');
    expect(ruleValue(pane, '-webkit-backdrop-filter')).toBe('var(--hub-glass-blur)');
    expect(ruleValue(pane, 'border')).toBe('0');
    expect(ruleValue(pane, 'border-radius')).toBe('var(--radius-surface)');
    expect(ruleValue(pane, 'box-shadow')).toContain('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(pane, 'box-shadow')).toContain('var(--hub-glass-shadow)');
  });

  it('keeps the workspace stage opaque and neutral so ambient colour never sits behind the artifact', () => {
    const stage = cssDeclarations(baseCascade(shellCss), '.app .split > .workspace');

    expect(ruleValue(stage, 'background')).toBe('var(--bg)');
    expect(stage).not.toContain('backdrop-filter');
    expect(ruleValue(stage, 'border-radius')).toBe('var(--radius-surface)');
    expect(ruleValue(stage, 'box-shadow')).toContain('var(--hub-glass-shadow)');
  });

  it('makes the resize handle near-invisible at rest while keeping hover and focus affordances', () => {
    const base = baseCascade(shellCss);
    const handle = cssDeclarations(base, '.split-resize-handle');
    const rest = cssDeclarations(base, '.split-resize-handle::after');
    const active = cssDeclarations(
      base,
      '.split.is-resizing-chat .split-resize-handle::after',
    );

    expect(ruleValue(handle, 'background')).toBe('transparent');
    expect(ruleValue(rest, 'opacity')).toBe('0');
    expect(ruleValue(rest, 'background')).toBe('var(--hub-control-surface)');
    expect(ruleValue(active, 'opacity')).toBe('1');
    expect(ruleValue(active, 'background')).toContain('var(--hub-accent');
  });

  it('falls back to opaque panels that keep hierarchy under reduced transparency', () => {
    const reduced = mediaBlock(shellCss, '(prefers-reduced-transparency: reduce)');
    const pane = cssDeclarations(reduced, '.app .split > .split-chat-slot > .pane');
    const split = cssDeclarations(reduced, '.app .split.split');

    expect(ruleValue(pane, 'backdrop-filter')).toBe('none');
    expect(ruleValue(pane, 'background')).toBe('var(--bg-panel)');
    expect(ruleValue(pane, 'box-shadow')).toContain('var(--border)');
    expect(ruleValue(split, 'background')).toBe('var(--hub-canvas)');
  });

  it('uses only design tokens for colour in the workspace shell region', () => {
    const region = projectShellRegion();
    const colourLiterals = region.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];

    expect(colourLiterals).toEqual([]);
  });
});
