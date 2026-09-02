import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routinesCss = readFileSync(
  new URL('../../src/styles/viewer/routines.css', import.meta.url),
  'utf8',
);

function declarationBodies(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  return blocks.join('\n');
}

const MATERIAL_DECLARATION = /(?:^|[;\n])\s*(?:background|border(?:-(?:top|right|bottom|left)(?:-color)?)?|box-shadow):/;

function expectNoMaterial(selector: string): void {
  expect(declarationBodies(routinesCss, selector)).not.toMatch(MATERIAL_DECLARATION);
}

describe('compiled routines workspace ownership', () => {
  it.each([
    '.app .split',
    '.app .split-chat-slot > .pane',
    '.app .chat-log',
    '.app .composer-shell',
    '.chat-composer-fixed-layer .composer-shell',
    '.app .composer-shell:focus-within',
    '.chat-composer-fixed-layer .composer-shell:focus-within',
    '.app .composer.drag-active .composer-shell',
    '.chat-composer-fixed-layer .composer.drag-active .composer-shell',
    '.chat-composer-fixed-layer .composer-input-wrap',
    '.chat-composer-fixed-layer .composer-row',
    '.app .workspace',
    '.app .df-main',
  ])('leaves %s material to its owning stylesheet', (selector) => {
    expectNoMaterial(selector);
  });

  it('does not rebuild Design Files row dividers cell by cell', () => {
    for (const selector of [
      '.app .df-file-row + .df-file-row .df-cell-icon',
      '.app .df-file-row + .df-file-row .df-cell-name',
      '.app .df-file-row + .df-file-row .df-cell-kind',
      '.app .df-file-row + .df-file-row .df-cell-time',
      '.app .df-file-row + .df-file-row .df-cell-menu',
    ]) {
      expectNoMaterial(selector);
    }
  });

  it('keeps geometry declarations on mixed material and layout rules', () => {
    expect(declarationBodies(routinesCss, '.app .split-chat-slot > .pane')).toContain(
      'border-radius: 0;',
    );
    expect(declarationBodies(routinesCss, '.app .composer-shell')).toContain('padding: 7px;');
    expect(declarationBodies(routinesCss, '.app .workspace')).toContain('padding: 0;');
    expect(declarationBodies(routinesCss, '.chat-composer-fixed-layer .composer-row')).toContain(
      'min-height: 28px;',
    );
  });
});
