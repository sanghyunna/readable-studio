import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubCss = readFileSync(new URL('../../src/styles/home/hub.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const withoutComments = hubCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  throw new Error(`Missing CSS block for ${selector}`);
}

function declarationBlocks(selector: string): readonly string[] {
  const withoutComments = hubCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  return blocks;
}

function expectShrinkable(selector: string): void {
  expect(declarations(selector), selector).toContain('min-inline-size: 0;');
}

describe('Hub rail long-name truncation contract', () => {
  it('lets every ancestor in the rail name-width chain shrink', () => {
    for (const selector of [
      '.hub__nav',
      '.hub__nav-list',
      '.hub-tree',
      '.hub-open',
      '.hub-tree__body',
      '.hub-tree__node',
      '.hub-tree__group',
      '.hub-row',
    ]) {
      expectShrinkable(selector);
    }
  });

  it('ellipsizes the name without wrapping Korean text mid-syllable', () => {
    const title = declarations('.hub-row__title');

    expect(title).toContain('min-inline-size: 0;');
    expect(title).toContain('overflow: hidden;');
    expect(title).toContain('text-overflow: ellipsis;');
    expect(title).toContain('white-space: nowrap;');
    expect(title).toContain('word-break: keep-all;');
    expect(title).toContain('overflow-wrap: normal;');
  });

  it('constrains project names while preserving their chevron, state, and actions', () => {
    const project = declarations('.hub-row--project');

    expect(project).toContain('grid-template-columns: auto minmax(0, 1fr) auto auto;');
    expect(declarations('.hub-row--project > .hub-row__title')).toContain('grid-area: title;');
    expect(declarations('.hub-row--project > .hub-row__chevron')).toContain('grid-area: chevron;');
    expect(declarations('.hub-row--project > .hub-row__state')).toContain('grid-area: state;');
    expect(declarations('.hub-row--project > .hub-row__actions')).toContain('grid-area: actions;');
  });

  it('keeps open-work and nested-session names as the shrinking flex item', () => {
    const title = declarations('.hub-row__title');

    expect(declarations('.hub-row--open')).toContain('min-height: 32px;');
    expect(declarations('.hub-row--session')).toContain('min-height: 32px;');
    expect(title).toContain('flex: 1;');
    expect(declarations('.hub-row__actions')).toContain('flex: none;');
  });

  it('removes names rather than exposing overflow in the collapsed rail', () => {
    expect(declarations('.hub--rail-collapsed .hub-row__title')).toContain('display: none;');
    expect(declarations('.hub--rail-collapsed .hub-row')).toContain('padding: 0;');
  });
});

describe('Hub rail search affordance contract', () => {
  it('paints a recessed control at rest from existing Hub material tokens', () => {
    const search = declarationBlocks('.hub__search').join('\n');

    expect(search).toContain('background: var(--hub-control-surface);');
    expect(search).toMatch(
      /box-shadow:\s*inset 0 1px 2px var\(--hub-pearl-elevation\),\s*inset 0 -1px 0 var\(--hub-control-highlight\);/,
    );
  });

  it('keeps focus visibly stronger than the inset rest state', () => {
    const focus = declarations('.hub__search:focus-visible');

    expect(focus).toContain('outline: 2px solid var(--hub-accent);');
    expect(focus).toContain('outline-offset: -1px;');
  });

  it('preserves the inset in the opaque reduced-transparency fallback', () => {
    expect(hubCss).toMatch(
      /@media\s*\(prefers-reduced-transparency:\s*reduce\)[\s\S]*?\.hub__search\s*\{[^}]*background:\s*var\(--bg-panel\);[^}]*box-shadow:\s*inset 0 1px 2px var\(--hub-pearl-elevation\),\s*inset 0 -1px 0 var\(--hub-control-highlight\);/,
    );
  });

  it('retains the recessed field behind the collapsed-rail search glyph', () => {
    const collapsed = declarations('.hub--rail-collapsed .hub__search');
    const glyph = declarations('.hub--rail-collapsed .hub__nav-actions::after');

    expect(collapsed).not.toContain('background: transparent;');
    expect(collapsed).not.toContain('box-shadow: none;');
    expect(glyph).toContain('mask: var(--hub-search-glyph) no-repeat center / 15px 15px;');
  });
});
