// @vitest-environment jsdom

/**
 * Settings theme chips.
 *
 * The entry gear popover and Settings > Appearance used to paint their theme
 * chips from a hand-maintained tuple in `state/themes.ts`, which still carried
 * the retired terracotta accent for System / Light / Dark long after
 * `styles/tokens.css` had moved to blue. The contract here is the Theme modal's:
 * every chip strip is a miniature of its own theme painted from that theme's
 * REAL tokens through the cascade, with no second palette anywhere, and it
 * holds whatever theme the document itself is showing.
 */

import { cleanup, render } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ThemeSwatch } from '../../src/components/ThemeSwatch';
import styles from '../../src/components/ThemeSwatch.module.css';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';
import type { AppTheme } from '../../src/types';
import {
  readWebFile,
  resolvedBackground,
  scopedModuleCss,
  themeSourceSheets,
  themeSourceTokens,
} from '../helpers/theme-source-css';

type ExplicitTheme = Exclude<AppTheme, 'system'>;

/** The accent the retired tuple painted on System / Light / Dark. */
const STALE_ORANGE = ['#c96442', '#d97a56'];

const moduleCss = readWebFile('src/components/ThemeSwatch.module.css');

const SOURCE_TOKENS = Object.fromEntries(
  EXPLICIT_THEME_OPTIONS.map(({ id }) => [id, themeSourceTokens(id)]),
) as Record<ExplicitTheme, Record<string, string>>;

interface Strip {
  readonly theme: string | null;
  readonly canvas: string;
  readonly accent: string;
  readonly ink: string;
}

function paint(part: Element | null, name: string): string {
  expect(part, `chip .${name}`).not.toBeNull();
  const resolved = resolvedBackground(part as Element);
  expect(resolved, `chip .${name} must paint one semantic token`).not.toBeNull();
  return resolved as string;
}

/** Every palette strip a rendered swatch contains, in order, with its chips resolved. */
function strips(container: HTMLElement): readonly Strip[] {
  const palettes = Array.from(container.querySelectorAll(`.${styles.palette as string}`));
  expect(palettes.length, 'palette strips').toBeGreaterThan(0);
  return palettes.map((palette) => ({
    theme: palette.getAttribute('data-theme'),
    canvas: paint(palette.querySelector(`.${styles.canvas as string}`), 'canvas'),
    accent: paint(palette.querySelector(`.${styles.accent as string}`), 'accent'),
    ink: paint(palette.querySelector(`.${styles.ink as string}`), 'ink'),
  }));
}

function expectedStrip(theme: ExplicitTheme): Strip {
  const source = SOURCE_TOKENS[theme];
  return {
    theme,
    canvas: source['--bg'] as string,
    accent: source['--accent'] as string,
    ink: source['--text'] as string,
  };
}

/** Render one swatch inside a document that currently shows `documentTheme`. */
function renderSwatch(theme: AppTheme, documentTheme: ExplicitTheme) {
  document.documentElement.setAttribute('data-theme', documentTheme);
  return render(<ThemeSwatch theme={theme} className="strip" />);
}

beforeAll(() => {
  for (const css of [...themeSourceSheets(), scopedModuleCss(moduleCss, styles as Record<string, string>)]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeSwatch', () => {
  it('paints the light chips with the product light accent, never the stale orange, inside a dark document', () => {
    // Given: the app is showing dark, so nothing light is on the page.
    const { container } = renderSwatch('light', 'dark');

    // When: everything the strip paints is resolved.
    const painted = Array.from(container.querySelectorAll('*'))
      .map(resolvedBackground)
      .filter((value): value is string => value !== null);

    // Then: the real light accent (blue) and canvas are there, the stale
    // orange is not, and nothing leaked in from the dark document.
    expect(painted).toContain(SOURCE_TOKENS.light['--accent']);
    expect(painted).toContain(SOURCE_TOKENS.light['--bg']);
    for (const stale of STALE_ORANGE) expect(painted).not.toContain(stale);
    expect(painted).not.toContain(SOURCE_TOKENS.dark['--accent']);
    expect(painted).not.toContain(SOURCE_TOKENS.dark['--bg']);
    expect(strips(container)).toEqual([expectedStrip('light')]);
  });

  it.each(['light', 'dark'] as const)(
    'resolves every explicit theme to its own source block while the document shows %s',
    (documentTheme) => {
      for (const { id } of EXPLICIT_THEME_OPTIONS) {
        // Given: one theme's chips in a document showing another (or the same) theme.
        const { container, unmount } = renderSwatch(id, documentTheme);

        // Then: canvas, accent and ink come from ITS theme's source block - never the document's.
        expect(strips(container), id).toEqual([expectedStrip(id)]);
        unmount();
      }
    },
  );

  it('shows both real palettes for System, light over dark', () => {
    const { container } = renderSwatch('system', 'light');

    expect(strips(container)).toEqual([expectedStrip('light'), expectedStrip('dark')]);
  });

  it('gives light, dark and a named theme visibly different chips', () => {
    const [light] = strips(renderSwatch('light', 'light').container);
    const [dark] = strips(renderSwatch('dark', 'light').container);
    const [monokai] = strips(renderSwatch('monokai', 'light').container);

    for (const key of ['canvas', 'accent', 'ink'] as const) {
      expect(new Set([light?.[key], dark?.[key], monokai?.[key]]).size, key).toBe(3);
    }
  });

  it('carries no palette of its own: every chip paints a single semantic token', () => {
    const painted: string[] = [];
    postcss.parse(moduleCss).walkDecls(/^background/, (declaration) => {
      painted.push(declaration.value);
    });

    expect(painted).toHaveLength(3);
    expect(painted.filter((value) => !/^var\(--[\w-]+\)$/.test(value))).toEqual([]);
    expect(readWebFile('src/components/ThemeSwatch.tsx')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
