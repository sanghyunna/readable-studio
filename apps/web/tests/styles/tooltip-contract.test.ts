import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const primitivesCss = readFileSync(
  new URL('../../src/styles/primitives.css', import.meta.url),
  'utf8',
);
const viewerCss = readFileSync(
  new URL('../../src/styles/viewer/core.css', import.meta.url),
  'utf8',
);
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function cssFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return extname(entry.name) === '.css' ? [path] : [];
  });
}

function pseudoTooltipSelectors(source: string): readonly string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const selectorList = match[1] ?? '';
    selectors.push(
      ...selectorList
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => /\[data-tooltip\].*::(?:before|after)/.test(selector)),
    );
  }
  return selectors;
}

function declarations(source: string, selector: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  throw new Error(`Missing CSS block for ${selector}`);
}

describe('tooltip style contract', () => {
  it('ships the portal layer as a fixed, token-colored surface', () => {
    const layer = declarations(primitivesCss, '.readable-tooltip-layer');

    expect(layer).toContain('position: fixed;');
    expect(layer).toContain('top: 0;');
    expect(layer).toContain('left: 0;');
    expect(layer).toContain('background: var(--text);');
    expect(layer).not.toMatch(/background:\s*(?:transparent|rgba\([^)]*,\s*0\))/);
  });

  it('excludes every portal-managed control from every CSS pseudo-element pill', () => {
    const fallbackSelectors = cssFiles(sourceRoot).flatMap((path) =>
      pseudoTooltipSelectors(readFileSync(path, 'utf8')).map((selector) => ({ path, selector })),
    );

    expect(fallbackSelectors.length).toBeGreaterThan(0);
    for (const fallback of fallbackSelectors) {
      expect(fallback.selector, fallback.path).toContain(':not(.readable-tooltip)');
    }
  });

  it('keeps viewer fallback behavior for controls outside the portal contract', () => {
    const baseSelector = '.viewer-action-icon:not(.readable-tooltip)[data-tooltip]::after';
    const hoverSelector = '.viewer-action-icon:not(.readable-tooltip)[data-tooltip]:hover::after';

    expect(declarations(viewerCss, baseSelector)).toContain('content: attr(data-tooltip);');
    expect(declarations(viewerCss, hoverSelector)).toContain('opacity: 1;');
  });
});
