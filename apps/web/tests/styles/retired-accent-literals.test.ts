/**
 * Retired accent guard.
 *
 * The product's accent moved from terracotta (`#c96442` light / `#d97a56`
 * dark) to blue in `styles/tokens.css`, but the old values lingered as
 * literals in a theme swatch tuple, the fresh-install default, an
 * illustration and the pet fallbacks, so surfaces disagreed with the theme.
 * Everything theme-derived now reads the tokens. This guard fails the moment
 * either literal (in hex or rgb spelling) reappears anywhere under `src/`,
 * except for the occurrences kept on purpose below - each of which is pinned
 * to an exact count so a new one cannot hide behind an allowlisted file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ACCENT_COLOR } from '../../src/state/appearance';
import { THEME_OPTIONS } from '../../src/state/themes';

const webRoot = process.cwd();
const srcRoot = resolve(webRoot, 'src');

/** The retired values in every spelling a stylesheet or component could paint them. */
const RETIRED_LITERALS = [
  { name: '#c96442', pattern: /#c96442\b|rgba?\(\s*201[\s,]+100[\s,]+66\b/gi },
  { name: '#d97a56', pattern: /#d97a56\b|rgba?\(\s*217[\s,]+122[\s,]+86\b/gi },
] as const;

/**
 * Occurrences kept deliberately: `src`-relative path -> literal -> exact count.
 * Add an entry only with the reason beside it.
 */
const ALLOWLIST: Record<string, Record<string, number>> = {
  // `LEGACY_DEFAULT_ACCENT_COLOR`, the legacy-config migration sentinel:
  // configs saved before `accentColorMode` existed persisted this value as the
  // untouched default, and `loadConfig` reads that exact value as "never
  // customised" so old installs keep following the theme accent. It is
  // compared against stored config, never painted, and must stay the retired
  // hex forever (app/layout.tsx's pre-hydration script compares the same one).
  'src/state/config.ts': { '#c96442': 1 },
};

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md', '.html', '.svg', '.txt',
]);

function sourceFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

interface Occurrence {
  readonly file: string;
  readonly literal: string;
  readonly line: number;
}

function findOccurrences(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const path of sourceFiles()) {
    const file = relative(webRoot, path).split('\\').join('/');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const { name, pattern } of RETIRED_LITERALS) {
        for (const _match of text.matchAll(pattern)) {
          found.push({ file, literal: name, line: index + 1 });
        }
      }
    });
  }
  return found;
}

describe('retired terracotta accent', () => {
  it('appears nowhere under src/ except the allowlisted migration sentinel', () => {
    const occurrences = findOccurrences();

    // Every hit must be covered by the allowlist...
    const unexpected = occurrences.filter(
      ({ file, literal }) => ALLOWLIST[file]?.[literal] === undefined,
    );
    expect(
      unexpected.map(({ file, literal, line }) => `${file}:${line} paints retired ${literal}`),
    ).toEqual([]);

    // ...at exactly the count the allowlist pins, so an entry can neither
    // hide a new occurrence nor outlive the one it was written for.
    for (const [file, literals] of Object.entries(ALLOWLIST)) {
      for (const [literal, expectedCount] of Object.entries(literals)) {
        const count = occurrences.filter((hit) => hit.file === file && hit.literal === literal).length;
        expect(count, `${file} occurrences of ${literal}`).toBe(expectedCount);
      }
    }
  });

  it('is not the default accent: a fresh install starts on the light theme accent token', () => {
    const tokensCss = readFileSync(resolve(webRoot, 'src/styles/tokens.css'), 'utf8');
    let rootAccent: string | undefined;
    for (const node of postcss.parse(tokensCss).nodes) {
      if (node.type !== 'rule' || node.selector !== ':root') continue;
      node.walkDecls('--accent', (declaration) => {
        rootAccent = declaration.value.trim();
      });
    }

    expect(rootAccent).toBeDefined();
    expect(DEFAULT_ACCENT_COLOR).toBe(rootAccent);
  });

  it('has no theme catalogue to hide in: state/themes.ts names themes and carries no colours', () => {
    const themesTs = readFileSync(resolve(webRoot, 'src/state/themes.ts'), 'utf8');

    expect(themesTs).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const option of THEME_OPTIONS) expect(option).not.toHaveProperty('swatch');
  });
});
