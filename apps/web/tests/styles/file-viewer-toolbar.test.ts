import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles/viewer/core.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../../src/styles/primitives.css', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const blocks: string[] = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function conditionalBlock(condition: string): string {
  const start = css.indexOf(condition);
  if (start < 0) throw new Error(`Missing conditional block ${condition}`);
  const open = css.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unclosed conditional block ${condition}`);
}

describe('file viewer preview toolbar styles', () => {
  it('centers the tool rail in a symmetric host grid and ends utilities', () => {
    const host = declarations(css, '.viewer-toolbar');
    const rail = declarations(css, '.viewer-tool-rail');
    const utilities = declarations(css, '.viewer-toolbar-utilities');

    expect(host).toContain('display: grid;');
    expect(host).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);');
    expect(rail).toContain('grid-column: 2;');
    expect(rail).toContain('justify-self: center;');
    expect(utilities).toContain('grid-column: 3;');
    expect(utilities).toContain('justify-self: end;');
  });

  it('uses one borderless tokenized glass rail with semantic separation', () => {
    const rail = declarations(css, '.viewer-tool-rail');
    const divider = declarations(css, '.viewer-tool-divider');
    const groups = declarations(css, '.viewer-tool-group');

    expect(rail).toContain('border: 0;');
    expect(rail).toContain('background: var(--hub-control-surface-hover);');
    expect(rail).toContain('-webkit-backdrop-filter: var(--hub-control-blur);');
    expect(rail).toContain('backdrop-filter: var(--hub-control-blur);');
    expect(rail).toContain('gap: 12px;');
    expect(groups).toContain('background: transparent;');
    expect(divider).toContain('background: linear-gradient(');
  });

  it('reflows from the viewer container and preserves accessible labels at 360px', () => {
    const viewer = declarations(css, '.viewer');
    const constrained = conditionalBlock('@container viewer (max-width: 900px)');
    const compact = conditionalBlock('@container viewer (max-width: 360px)');

    expect(viewer).toContain('container-type: inline-size;');
    expect(viewer).toContain('container-name: viewer;');
    expect(declarations(constrained, '.viewer-tool-rail')).toContain('grid-row: 2;');
    expect(declarations(constrained, '.viewer-tool-rail')).toContain('grid-column: 1 / -1;');
    expect(declarations(compact, '.viewer-tool-group-label')).toContain('clip: rect(0, 0, 0, 0);');
    expect(compact).not.toContain('display: none');
  });

  it('gives the zoom utility trigger the same focus-visible ring as rail actions', () => {
    const baseButtonRing = declarations(baseCss, 'button:focus-visible');
    const zoomRing = declarations(css, '.zoom-menu.viewer-toolbar-zoom .zoom-trigger:focus-visible');

    expect(baseButtonRing).toContain('outline: 2px solid var(--accent);');
    expect(baseButtonRing).toContain('outline-offset: 2px;');
    expect(zoomRing).toContain('outline: 2px solid var(--accent);');
    expect(zoomRing).toContain('outline-offset: 2px;');
    expect(zoomRing).not.toContain('outline: none');
  });

  it('provides reduced-transparency and reduced-motion contracts', () => {
    const transparency = conditionalBlock('@media (prefers-reduced-transparency: reduce)');
    const motion = conditionalBlock('@media (prefers-reduced-motion: reduce)');

    expect(declarations(transparency, '.viewer-tool-rail')).toContain('backdrop-filter: none;');
    expect(declarations(transparency, '.viewer-tool-rail')).toContain('background: var(--bg-panel);');
    expect(declarations(motion, '.viewer-tool-rail .viewer-action:active')).toContain('transform: none;');
  });
});

describe('workspace v5 viewer material', () => {
  it('floats the toolbar as a borderless tokenized glass island', () => {
    const toolbar = declarations(css, '.viewer-toolbar');

    expect(toolbar).toContain('background: var(--hub-glass-fill);');
    expect(toolbar).toContain('backdrop-filter: var(--hub-glass-blur);');
    expect(toolbar).toContain('-webkit-backdrop-filter: var(--hub-glass-blur);');
    expect(toolbar).toContain('inset 0 1px 0 var(--hub-pearl-highlight)');
    expect(toolbar).toContain('var(--hub-glass-shadow)');
    expect(toolbar).toContain('border: 0;');
    expect(toolbar).not.toContain('border-bottom: 1px solid');
  });

  // Regression: the toolbar claimed to be a glass island while rendering a
  // flush band (radius 0, margin 0, full stage width). Either it is detached or
  // it is not glass - inset geometry is what makes the claim honest.
  it('is geometrically detached from the stage, not a flush docked band', () => {
    const toolbar = declarations(css, '.viewer-toolbar');

    expect(toolbar).toContain('border-radius: var(--radius-surface);');

    const margin = /(?:^|[;\n])\s*margin:\s*([^;]+);/.exec(toolbar)?.[1]?.trim();
    expect(margin).toBeDefined();
    // Every authored margin edge must be a real inset, never a bare `0`.
    const insets = margin!.split(/\s+/);
    expect(insets.length).toBeGreaterThan(1);
    expect(insets.some((value) => value !== '0')).toBe(true);
  });

  // Prefix-first order is load-bearing, not cosmetic: Lightning CSS (Tailwind 4)
  // drops the unprefixed declaration when it is authored first, which is exactly
  // why this subtree resolved `backdrop-filter: none` at runtime while the chat
  // pane - authored prefix-first in shell.css - resolved the same token fine.
  it('authors every backdrop-filter prefix-first so Lightning CSS keeps both declarations', () => {
    for (const selector of ['.viewer-toolbar', '.viewer-tool-rail']) {
      const block = declarations(css, selector);
      const prefixed = block.indexOf('-webkit-backdrop-filter');
      expect(prefixed, `${selector} must author -webkit-backdrop-filter`).toBeGreaterThanOrEqual(0);
      const unprefixed = block.indexOf('backdrop-filter:', prefixed + 1);
      expect(unprefixed, `${selector} must author backdrop-filter after the prefix`).toBeGreaterThan(
        prefixed,
      );
    }
  });

  it('paints the stage as a neutral matte with no ambient bloom behind the artifact', () => {
    const stage = declarations(css, '.viewer-body');
    const deviceStage = declarations(css, '.preview-viewport:not(.preview-viewport-desktop)');

    expect(stage).toContain('background: var(--bg-subtle);');
    expect(deviceStage).toContain('background: var(--bg-muted);');
    expect(deviceStage).not.toContain('radial-gradient(');
    expect(deviceStage).not.toContain('linear-gradient(');
  });

  it('frames the document paper with tokenized elevation instead of raw shadow literals', () => {
    const paper = declarations(
      css,
      '.preview-viewport:not(.preview-viewport-desktop) .preview-frame-clip',
    );

    expect(paper).toContain('box-shadow: var(--hub-glass-shadow-lg);');
    expect(paper).not.toContain('var(--black)');
  });

  it('keeps toolbar controls transparent at rest with tonal hub hover', () => {
    const action = declarations(css, '.viewer-action');
    const actionHover = declarations(css, '.viewer-action:hover:not(:disabled)');
    const iconOnly = declarations(css, '.viewer-toolbar .icon-only');
    const iconHover = declarations(css, '.viewer-toolbar .icon-only:hover:not(:disabled)');

    expect(action).toContain('background: transparent;');
    expect(iconOnly).toContain('background: transparent;');
    for (const hover of [actionHover, iconHover]) {
      expect(hover).toContain('background: var(--hub-control-surface-hover);');
      expect(hover).toContain('box-shadow: var(--hub-control-shadow-hover);');
      expect(hover).not.toContain('var(--black)');
    }
  });

  it('falls back to opaque surfaces when transparency is reduced', () => {
    const transparency = conditionalBlock('@media (prefers-reduced-transparency: reduce)');
    const toolbar = declarations(transparency, '.viewer-toolbar');

    expect(toolbar).toContain('backdrop-filter: none;');
    expect(toolbar).toContain('-webkit-backdrop-filter: none;');
    expect(toolbar).toContain('background: var(--bg-panel);');
    // The island keeps its inset geometry here, so hierarchy is restated with a
    // hairline ring like the shell's panes - a bottom rule would read as a
    // broken edge on a rounded, detached box.
    expect(toolbar).toContain('0 0 0 1px var(--border)');
    expect(toolbar).not.toContain('inset 0 -1px 0 var(--border)');
  });

  it('introduces no raw color literals in the redesigned viewer material', () => {
    const material = [
      '.viewer-toolbar',
      '.viewer-body',
      '.preview-viewport:not(.preview-viewport-desktop)',
      '.viewer-action:hover:not(:disabled)',
      '.viewer-toolbar .icon-only:hover:not(:disabled)',
    ]
      .map((selector) => declarations(css, selector))
      .join('\n');

    expect(material).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(material).not.toMatch(/\brgba?\(/);
    expect(material).not.toMatch(/\bhsla?\(/);
  });
});
