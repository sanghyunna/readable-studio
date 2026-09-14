// A theme's colour chips for the settings surfaces (the entry gear popover and
// Settings > Appearance): canvas, accent and ink, painted from that theme's OWN
// tokens the same way the Theme modal's cards are.
//
// There is no palette here and none in `state/themes.ts`: the chips paint
// `var(--bg)`, `var(--accent)` and `var(--text)`, the wrapper carries the
// theme's `data-theme` so the stylesheets' theme block scopes those tokens to
// it through the cascade, and light (the `:root` baseline, which has no block)
// is read off the sheets and painted inline. A token change in
// `styles/tokens.css` or `styles/themes/*.css` shows up here untouched.

import { useMemo, type CSSProperties } from 'react';

import type { AppTheme } from '../types';
import { rootTokenValues } from './theme-tokens';
import styles from './ThemeSwatch.module.css';

/** The tokens one chip strip paints: the theme's canvas, its accent, its ink. */
const SWATCH_TOKENS = ['--bg', '--accent', '--text'] as const;

type ExplicitTheme = Exclude<AppTheme, 'system'>;

interface Props {
  theme: AppTheme;
  /** The surface's own chip-strip class: it owns the size, grid, border and radius. */
  className?: string;
}

export function ThemeSwatch({ theme, className }: Props) {
  // Only the light chips need the baseline; read it once per strip that paints them.
  const paintsLight = theme === 'light' || theme === 'system';
  const lightBaseline = useMemo(
    () => (paintsLight ? rootTokenValues(SWATCH_TOKENS) : undefined),
    [paintsLight],
  );
  return (
    <span className={className} aria-hidden="true">
      {theme === 'system' ? (
        // Both palettes the setting can resolve to, each the real one: the
        // light strip over the dark strip in the surface's three-column grid.
        <>
          <Palette theme="light" baseline={lightBaseline} />
          <Palette theme="dark" />
        </>
      ) : (
        <Palette theme={theme} baseline={theme === 'light' ? lightBaseline : undefined} />
      )}
    </span>
  );
}

/**
 * One theme's three chips. The wrapper scopes the theme's tokens and generates
 * no box of its own (`display: contents`), so the chips sit directly in the
 * surface's grid.
 */
function Palette({ theme, baseline }: { theme: ExplicitTheme; baseline?: CSSProperties }) {
  return (
    <span className={styles.palette} data-theme={theme} style={baseline}>
      <span className={styles.canvas} />
      <span className={styles.accent} />
      <span className={styles.ink} />
    </span>
  );
}
