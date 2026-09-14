// @vitest-environment jsdom

/**
 * Theme modal preview fidelity.
 *
 * The shipped build painted the `System`, `Light` and `Dark` cards with an
 * orange accent bar left over from an older palette, while the product's light
 * theme is white with a BLUE accent: the previews lied about the choice. The
 * contract here is that every card is a miniature of its own theme, painted
 * from that theme's REAL tokens - the `:root` baseline and `[data-theme]`
 * blocks in `styles/tokens.css` and `styles/themes/*.css` - with no second
 * palette anywhere, and that this holds whatever theme the document itself is
 * showing (the light card must stay light inside a dark document).
 *
 * The assertions compare RESOLVED colours: the real token stylesheets and the
 * modal's own module are loaded into jsdom, each miniature part's painted
 * `var(--token)` is read back from its computed style, and the token is then
 * resolved on that element through the cascade (jsdom resolves custom-property
 * declarations and inheritance, not `var()` substitution) and compared with the
 * value the theme's source block declares.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HubThemeModal } from '../../src/components/hub/HubThemeModal';
import styles from '../../src/components/hub/HubThemeModal.module.css';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';
import type { AppTheme } from '../../src/types';

type ExplicitTheme = Exclude<AppTheme, 'system'>;

/** The accent the shipped build painted on System / Light / Dark. */
const STALE_ORANGE = ['#c96442', '#d97a56'];

// Under the jsdom environment `import.meta.url` is not a file: URL, so paths
// are anchored on the package root the test command runs from.
const webRoot = process.cwd();
const read = (relative: string) => readFileSync(resolve(webRoot, relative), 'utf8');
const tokensCss = read('src/styles/tokens.css');
const moduleCss = read('src/components/hub/HubThemeModal.module.css');

/** Follow the theme index's imports so the sheet order matches the app's. */
function expandImports(file: string): string {
  const root = postcss.parse(readFileSync(file, 'utf8'), { from: file });
  root.walkAtRules('import', (rule) => {
    const specifier = rule.params.replace(/^['"]|['"]$/g, '');
    rule.replaceWith(postcss.parse(expandImports(resolve(dirname(file), specifier))));
  });
  return root.toString();
}
const themesCss = expandImports(resolve(webRoot, 'src/styles/themes/index.css'));

/**
 * The module is authored with its source class names; in the test bundle the
 * component renders the mapped ones, so the injected copy is mapped the same way.
 */
function scopedModuleCss(): string {
  const mapped = styles as Record<string, string>;
  const root = postcss.parse(moduleCss);
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(/\.([A-Za-z_][\w-]*)/g, (match, name: string) =>
      mapped[name] ? `.${mapped[name]}` : match,
    );
  });
  return root.toString();
}

/** Custom-property declarations of one top-level selector block, verbatim. */
function tokenBlock(source: string, selector: string): Record<string, string> {
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

/** Every explicit theme's own source declarations, keyed by id. */
const SOURCE_TOKENS: Record<ExplicitTheme, Record<string, string>> = Object.fromEntries(
  EXPLICIT_THEME_OPTIONS.map(({ id }) => [
    id,
    id === 'light'
      ? tokenBlock(tokensCss, ':root')
      : id === 'dark'
        ? tokenBlock(tokensCss, '[data-theme="dark"]')
        : tokenBlock(read(`src/styles/themes/${id}.css`), `[data-theme='${id}']`),
  ]),
) as Record<ExplicitTheme, Record<string, string>>;

/** The parts of one miniature and the token each one paints, resolved on it. */
interface Miniature {
  readonly theme: string | null;
  readonly canvas: string;
  readonly surface: string;
  readonly accent: string;
  readonly ink: string;
  readonly inkMuted: string;
}

/**
 * The colour an element's `background: var(--token)` resolves to on that
 * element, or null when it paints nothing / not a single token.
 */
function resolvedBackground(element: Element): string | null {
  const computed = getComputedStyle(element);
  const token = /^var\((--[\w-]+)\)$/.exec(computed.getPropertyValue('background').trim())?.[1];
  return token ? computed.getPropertyValue(token).replace(/\s+/g, ' ').trim() : null;
}

/** A miniature part must paint exactly one semantic token. */
function paint(part: Element): string {
  const resolved = resolvedBackground(part);
  expect(resolved, `a miniature part must paint one semantic token (${part.className})`).not.toBeNull();
  return resolved as string;
}

function miniature(canvas: Element): Miniature {
  const part = (className: string) => {
    const found = canvas.querySelector(`.${className}`);
    expect(found, `miniature part .${className}`).not.toBeNull();
    return found as Element;
  };
  return {
    theme: canvas.getAttribute('data-theme'),
    canvas: paint(canvas),
    surface: paint(part(styles.surface as string)),
    accent: paint(part(styles.accent as string)),
    ink: paint(part(styles.ink as string)),
    inkMuted: paint(part(styles.inkMuted as string)),
  };
}

function miniaturesOf(option: AppTheme): readonly Miniature[] {
  const card = screen.getByTestId(`hub-theme-option-${option}`);
  const canvases = Array.from(card.querySelectorAll(`.${styles.canvas as string}`));
  expect(canvases.length, `${option} miniatures`).toBeGreaterThan(0);
  return canvases.map(miniature);
}

function expectedMiniature(theme: ExplicitTheme): Omit<Miniature, 'theme'> {
  const source = SOURCE_TOKENS[theme];
  return {
    canvas: source['--bg'] as string,
    surface: source['--bg-panel'] as string,
    accent: source['--accent'] as string,
    ink: source['--text'] as string,
    inkMuted: source['--text-muted'] as string,
  };
}

/** Open the modal inside a document that currently shows `documentTheme`. */
function openModal(documentTheme: ExplicitTheme) {
  document.documentElement.setAttribute('data-theme', documentTheme);
  const returnFocusRef = createRef<HTMLElement>();
  render(
    <HubThemeModal
      open
      theme={documentTheme}
      onThemeChange={vi.fn()}
      onClose={vi.fn()}
      returnFocusRef={returnFocusRef}
    />,
  );
}

beforeAll(() => {
  for (const css of [tokensCss, themesCss, scopedModuleCss()]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('HubThemeModal preview fidelity', () => {
  it('paints the light preview with the product light accent, never the stale orange, even inside a dark document', () => {
    // Given: the app is showing dark, so nothing light is on the page.
    openModal('dark');

    // When: every colour the light card's preview paints is resolved,
    // whatever its markup.
    const preview = screen.getByTestId('hub-theme-option-light').querySelector(`.${styles.preview as string}`);
    expect(preview).not.toBeNull();
    const painted = [preview as Element, ...Array.from((preview as Element).querySelectorAll('*'))]
      .map(resolvedBackground)
      .filter((value): value is string => value !== null);

    // Then: the real light accent (blue) and canvas are there, the stale
    // orange is not, and nothing leaked in from the dark document.
    expect(painted).toContain(SOURCE_TOKENS.light['--accent']);
    expect(painted).toContain(SOURCE_TOKENS.light['--bg']);
    for (const stale of STALE_ORANGE) expect(painted).not.toContain(stale);
    expect(painted).not.toContain(SOURCE_TOKENS.dark['--accent']);
    expect(painted).not.toContain(SOURCE_TOKENS.dark['--bg']);

    // And: the accent bar itself is that token.
    const [light] = miniaturesOf('light');
    expect(light?.accent).toBe(SOURCE_TOKENS.light['--accent']);
  });

  it.each(['light', 'dark'] as const)(
    'resolves every card to its own theme tokens while the document shows %s',
    (documentTheme) => {
      // Given: the modal is open in a document showing one theme.
      openModal(documentTheme);

      // Then: each explicit card paints background, surface, accent and ink
      // from ITS theme's source block - never the document's.
      for (const { id } of EXPLICIT_THEME_OPTIONS) {
        const [only, ...rest] = miniaturesOf(id);
        expect(rest, `${id} renders exactly one miniature`).toHaveLength(0);
        expect(only, id).toEqual({ theme: id, ...expectedMiniature(id) });
      }

      // And: the System card keeps its split, and both halves are the real
      // light and dark palettes.
      expect(miniaturesOf('system')).toEqual([
        { theme: 'light', ...expectedMiniature('light') },
        { theme: 'dark', ...expectedMiniature('dark') },
      ]);
    },
  );

  it('gives light, dark and a named theme visibly different miniatures', () => {
    // Given: the modal is open.
    openModal('light');

    // When: three cards that must never look alike are resolved.
    const [light] = miniaturesOf('light');
    const [dark] = miniaturesOf('dark');
    const [monokai] = miniaturesOf('monokai');

    // Then: every painted part differs between them.
    for (const key of ['canvas', 'surface', 'accent', 'ink', 'inkMuted'] as const) {
      expect(new Set([light?.[key], dark?.[key], monokai?.[key]]).size, key).toBe(3);
    }
  });

  it('carries no palette of its own: the miniature paints tokens only and the cards no longer read the catalogue swatch', () => {
    // Given: the module's miniature rules (canvas, surface, accent, ink).
    const miniatureClasses = ['canvas', 'surface', 'accent', 'ink', 'inkMuted'];
    const painted: string[] = [];
    postcss.parse(moduleCss).walkRules((rule) => {
      if (!miniatureClasses.some((name) => rule.selector.includes(`.${name}`))) return;
      rule.walkDecls(/^background/, (declaration) => {
        painted.push(declaration.value);
      });
    });

    // Then: the miniature paints something, and every paint is a single
    // semantic token reference - no literals, no private preview palette.
    expect(painted.length).toBeGreaterThanOrEqual(miniatureClasses.length);
    expect(painted.filter((value) => !/^var\(--[\w-]+\)$/.test(value))).toEqual([]);

    // And: the modal itself never consults the hand-maintained swatch tuple,
    // so it cannot drift from the stylesheets again.
    expect(read('src/components/hub/HubThemeModal.tsx')).not.toMatch(/\bswatch\b/);
  });
});
