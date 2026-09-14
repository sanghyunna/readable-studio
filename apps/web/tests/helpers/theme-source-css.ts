// The theme stylesheets as jsdom fixtures.
//
// Surfaces that preview a theme (the Theme modal's cards, the settings chips)
// paint that theme's REAL tokens through the cascade: the `:root` baseline and
// `[data-theme]` blocks in `styles/tokens.css` and `styles/themes/*.css`. Tests
// of those surfaces load the same sheets into jsdom and compare what a part
// paints with what the theme's source block declares; these helpers read the
// sheets and the blocks.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import postcss from 'postcss';
import { expect } from 'vitest';

// Under the jsdom environment `import.meta.url` is not a file: URL, so paths
// are anchored on the package root the test command runs from.
const webRoot = process.cwd();

export function readWebFile(relative: string): string {
  return readFileSync(resolve(webRoot, relative), 'utf8');
}

/** Follow a stylesheet's `@import`s so the sheet order matches the app's. */
export function expandCssImports(file: string): string {
  const root = postcss.parse(readFileSync(file, 'utf8'), { from: file });
  root.walkAtRules('import', (rule) => {
    const specifier = rule.params.replace(/^['"]|['"]$/g, '');
    rule.replaceWith(postcss.parse(expandCssImports(resolve(dirname(file), specifier))));
  });
  return root.toString();
}

/** `styles/tokens.css` and the named theme index, expanded, in the app's order. */
export function themeSourceSheets(): readonly string[] {
  return [readWebFile('src/styles/tokens.css'), expandCssImports(resolve(webRoot, 'src/styles/themes/index.css'))];
}

/**
 * A CSS module is authored with its source class names; in the test bundle the
 * component renders the mapped ones, so the injected copy is mapped the same way.
 */
export function scopedModuleCss(moduleCss: string, mapped: Record<string, string>): string {
  const root = postcss.parse(moduleCss);
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(/\.([A-Za-z_][\w-]*)/g, (match, name: string) =>
      mapped[name] ? `.${mapped[name]}` : match,
    );
  });
  return root.toString();
}

/** Custom-property declarations of one top-level selector block, verbatim. */
export function tokenBlock(source: string, selector: string): Record<string, string> {
  const wanted = selector.replace(/"/g, "'");
  const values: Record<string, string> = {};
  for (const node of postcss.parse(source).nodes) {
    if (node.type !== 'rule' || node.selector.replace(/"/g, "'") !== wanted) continue;
    node.walkDecls(/^--/, (declaration) => {
      values[declaration.prop] = declaration.value.replace(/\s+/g, ' ').trim();
    });
  }
  expect(Object.keys(values), `token block ${selector}`).not.toHaveLength(0);
  return values;
}

/** The source block one explicit theme is defined by, keyed by token name. */
export function themeSourceTokens(id: string): Record<string, string> {
  if (id === 'light') return tokenBlock(readWebFile('src/styles/tokens.css'), ':root');
  if (id === 'dark') return tokenBlock(readWebFile('src/styles/tokens.css'), '[data-theme="dark"]');
  return tokenBlock(readWebFile(`src/styles/themes/${id}.css`), `[data-theme='${id}']`);
}

/**
 * The colour an element's `background: var(--token)` resolves to on that
 * element, or null when it paints nothing / not a single token. jsdom resolves
 * custom-property declarations and inheritance, not `var()` substitution, so
 * the token is read back and then resolved on the element itself.
 */
export function resolvedBackground(element: Element): string | null {
  const computed = getComputedStyle(element);
  const token = /^var\((--[\w-]+)\)$/.exec(computed.getPropertyValue('background').trim())?.[1];
  return token ? computed.getPropertyValue(token).replace(/\s+/g, ' ').trim() : null;
}
