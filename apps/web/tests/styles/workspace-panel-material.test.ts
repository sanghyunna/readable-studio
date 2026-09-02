import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const drawerCss = readFileSync(
  new URL('../../src/styles/workspace/drawer.css', import.meta.url),
  'utf8',
);
const designFilesCss = readFileSync(
  new URL('../../src/styles/workspace/design-files.css', import.meta.url),
  'utf8',
);
const inspectorCss = readFileSync(
  new URL('../../src/components/ManualEditLeftInspector.module.css', import.meta.url),
  'utf8',
);
const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Top-level rules only: conditional (`@media`) overrides are asserted separately. */
function baseRules(css: string): string {
  const source = stripComments(css);
  let out = '';
  let index = 0;
  while (index < source.length) {
    const at = source.indexOf('@media', index);
    if (at < 0) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, at);
    const open = source.indexOf('{', at);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    index = cursor;
  }
  return out;
}

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = stripComments(css);
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
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

function mediaBlock(css: string, query: string): string {
  const source = stripComments(css);
  const start = source.indexOf(`@media ${query}`);
  if (start < 0) throw new Error(`Missing media query ${query}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unclosed media query ${query}`);
}

/** Color literals the material contract forbids: every colour must be a token. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

describe('workspace panel material — tab island (drawer.css)', () => {
  it('paints the subtab strip as a translucent control island, not a bordered box', () => {
    const island = cssDeclarations(baseRules(drawerCss), '.subtab-pill');

    expect(ruleValue(island, 'background')).toBe('var(--hub-control-surface)');
    expect(ruleValue(island, 'border')).toBe('0');
    expect(ruleValue(island, 'box-shadow')).toBe('inset 0 1px 0 var(--hub-control-highlight)');
  });

  it('keeps tabs transparent at rest with no boxed tab border', () => {
    const tab = cssDeclarations(drawerCss, '.subtab-pill button');

    expect(ruleValue(tab, 'background')).toBe('transparent');
    expect(ruleValue(tab, 'border')).toBe('0');
    expect(ruleValue(tab, 'box-shadow')).toBe('none');
  });

  it('gives the active tab a tonal accent fill plus an accent marker instead of a card', () => {
    const active = cssDeclarations(baseRules(drawerCss), '.subtab-pill button.active');
    const marker = cssDeclarations(baseRules(drawerCss), '.subtab-pill button.active::after');

    expect(ruleValue(active, 'background')).toBe('var(--hub-accent-fill)');
    expect(ruleValue(active, 'color')).toBe('var(--hub-accent-ink)');
    expect(ruleValue(active, 'box-shadow')).toBe('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(marker, 'background')).toBe('var(--hub-accent)');
  });

  it('lifts hovered inactive tabs into glass rather than a grey fill', () => {
    const hover = cssDeclarations(baseRules(drawerCss), '.subtab-pill button:hover:not(.active)');

    expect(ruleValue(hover, 'background')).toBe('var(--hub-control-surface-hover)');
    expect(ruleValue(hover, 'box-shadow')).toBe('var(--hub-control-shadow-hover)');
  });

  it('falls back to an opaque island under reduced transparency', () => {
    const reduced = mediaBlock(drawerCss, '(prefers-reduced-transparency: reduce)');
    const island = cssDeclarations(reduced, '.subtab-pill');
    const active = cssDeclarations(reduced, '.subtab-pill button.active');

    expect(ruleValue(island, 'background')).toBe('var(--bg-panel)');
    expect(ruleValue(island, 'box-shadow')).toBe('0 0 0 1px var(--border)');
    expect(ruleValue(active, 'background')).toBe('var(--accent-tint)');
  });
});

describe('workspace panel material — design files panel', () => {
  it('puts the pane on the glass tier with no hard right rule between columns', () => {
    const main = cssDeclarations(baseRules(designFilesCss), '.df-main');
    const preview = cssDeclarations(baseRules(designFilesCss), '.df-preview');

    // Tonal, not glass: the pane's host is an opaque neutral, and hub-dna 10
    // refuses translucency over a flat canvas — it would read as grey.
    expect(ruleValue(main, 'background')).toBe('var(--hub-pearl-mid)');
    expect(main).not.toContain('backdrop-filter');
    expect(ruleValue(main, 'border-right')).toBe('0');
    expect(ruleValue(main, 'box-shadow')).toBe('inset -1px 0 0 var(--hub-pearl-highlight)');
    expect(ruleValue(preview, 'border-left')).toBe('0');
    expect(ruleValue(preview, 'background')).toBe('transparent');
  });

  it('keeps rows borderless at rest with a tonal hover', () => {
    const row = cssDeclarations(baseRules(designFilesCss), '.df-row');
    const hover = cssDeclarations(baseRules(designFilesCss), '.df-row:hover');
    const fileHover = cssDeclarations(baseRules(designFilesCss), '.df-file-row:hover');

    expect(ruleValue(row, 'border-bottom')).toBe('0');
    expect(ruleValue(hover, 'background')).toBe('var(--hub-control-surface)');
    expect(ruleValue(hover, 'box-shadow')).toBe('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(fileHover, 'background')).toBe('var(--hub-control-surface)');
  });

  it('keeps the landed inset leading edge as the selection marker', () => {
    const selected = cssDeclarations(designFilesCss, '.df-row.selected');

    expect(ruleValue(selected, 'background')).toBe('var(--selected-soft)');
    expect(ruleValue(selected, 'box-shadow')).toBe('inset 4px 0 0 var(--selected)');
  });

  it('floats folder headers and footers on the pane surface without divider grids', () => {
    const sectionLabel = cssDeclarations(baseRules(designFilesCss), '.df-section-label');
    const footer = cssDeclarations(baseRules(designFilesCss), '.df-footer-info');

    expect(ruleValue(sectionLabel, 'background')).toBe('transparent');
    expect(ruleValue(sectionLabel, 'border-bottom')).toBe('0');
    expect(ruleValue(footer, 'border-top')).toBe('0');
    expect(ruleValue(footer, 'box-shadow')).toBe('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(footer, 'background')).toBe('transparent');
  });

  it('reduces the empty-state grid contrast per the colour audit', () => {
    const empty = cssDeclarations(baseRules(designFilesCss), '.df-empty');
    const grid = ruleValue(empty, 'background-image');

    expect(grid).toContain('color-mix(in srgb, var(--border-soft) 45%, transparent)');
    expect(ruleValue(empty, 'background-size')).toBe('32px 32px');
  });

  it('keeps the material inside the app shell where routines.css repaints the panel', () => {
    const base = baseRules(designFilesCss);
    const appMain = cssDeclarations(base, '.app .df-panel .df-main');
    const appFileHover = cssDeclarations(base, '.app .df-panel .df-file-row:hover');

    expect(ruleValue(appMain, 'background')).toBe('var(--hub-pearl-mid)');
    expect(ruleValue(appMain, 'border-right-color')).toBe('transparent');
    expect(ruleValue(appFileHover, 'background')).toBe('var(--hub-control-surface)');
    // The per-cell divider grid routines.css adds is neutralised, not restyled.
    expect(base).toMatch(
      /\.app \.df-panel \.df-file-row \+ \.df-file-row \.df-cell-menu\s*\{\s*border-top:\s*0;/,
    );
  });

  it('restores opaque panel surfaces under reduced transparency', () => {
    const reduced = mediaBlock(designFilesCss, '(prefers-reduced-transparency: reduce)');
    const main = cssDeclarations(reduced, '.df-main');
    const hover = cssDeclarations(reduced, '.df-row:hover');

    const appMain = cssDeclarations(reduced, '.app .df-panel .df-main');

    expect(ruleValue(main, 'background')).toBe('var(--bg-panel)');
    expect(ruleValue(main, 'box-shadow')).toBe('inset -1px 0 0 var(--border)');
    expect(ruleValue(hover, 'background')).toBe('var(--bg-subtle)');
    expect(ruleValue(appMain, 'background')).toBe('var(--bg-panel)');
  });
});

describe('workspace panel material — manual edit inspector', () => {
  it('inherits the chat pane glass tier instead of stacking a second card on it', () => {
    const root = cssDeclarations(baseRules(inspectorCss), '.root');
    // The docked host already paints tier-1 glass (shell.css); the inspector
    // body must stay transparent or the two translucent fills compound.
    const host = cssDeclarations(
      baseRules(shellCss),
      '.split > .split-chat-slot > .manual-edit-left-host',
    );

    expect(ruleValue(host, 'background')).toBe('var(--hub-glass-fill)');
    expect(ruleValue(host, 'backdrop-filter')).toBe('var(--hub-glass-blur)');
    expect(ruleValue(root, 'background')).toBe('transparent');
    expect(ruleValue(root, 'border')).toBe('0');
    expect(baseRules(inspectorCss)).not.toContain('--hub-glass-fill');
  });

  it('keeps the fixed header and footer pinned with light-ray separators', () => {
    const header = cssDeclarations(baseRules(inspectorCss), '.header');
    const footer = cssDeclarations(baseRules(inspectorCss), '.footer');

    // Fixed chrome: header and footer never scroll with the body.
    expect(ruleValue(header, 'flex')).toBe('0 0 auto');
    expect(ruleValue(footer, 'flex')).toBe('0 0 auto');
    expect(ruleValue(header, 'border-bottom')).toBe('0');
    expect(ruleValue(header, 'box-shadow')).toBe('inset 0 -1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(footer, 'border-block-start')).toBe('0');
    expect(ruleValue(footer, 'box-shadow')).toBe('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(ruleValue(footer, 'background')).toBe('transparent');
  });

  it('keeps the Save/Discard footer geometry unchanged', () => {
    const footer = cssDeclarations(baseRules(inspectorCss), '.footer');
    const buttons = cssDeclarations(
      baseRules(inspectorCss),
      '.footer :global(.manual-edit-discard-btn)',
    );

    expect(ruleValue(footer, 'padding')).toBe('12px 16px 16px');
    expect(ruleValue(footer, 'gap')).toBe('8px');
    expect(ruleValue(buttons, 'flex')).toBe('1 0 max-content');
  });

  it('keeps error semantics tonal rather than a flat danger card', () => {
    const error = cssDeclarations(baseRules(inspectorCss), '.error');

    expect(ruleValue(error, 'color')).toBe('var(--danger, var(--text))');
    expect(ruleValue(error, 'background')).toBe(
      'color-mix(in srgb, var(--danger, var(--text)) 12%, transparent)',
    );
    expect(ruleValue(error, 'box-shadow')).toBe(
      'inset 2px 0 0 var(--danger, var(--text))',
    );
  });

  it('hardens its internal light rays into hairlines under reduced transparency', () => {
    const reduced = mediaBlock(inspectorCss, '(prefers-reduced-transparency: reduce)');
    const header = cssDeclarations(reduced, '.header');
    const footer = cssDeclarations(reduced, '.footer');

    expect(ruleValue(header, 'box-shadow')).toBe('inset 0 -1px 0 var(--border)');
    expect(ruleValue(footer, 'box-shadow')).toBe('inset 0 1px 0 var(--border)');
  });
});

describe('workspace panel material — no invented colour literals', () => {
  it.each([
    ['drawer.css', drawerCss],
    ['design-files.css', designFilesCss],
    ['ManualEditLeftInspector.module.css', inspectorCss],
  ])('%s declares colours through tokens only', (_name, css) => {
    const literals = stripComments(css).match(COLOR_LITERAL) ?? [];
    expect(literals).toEqual([]);
  });
});
