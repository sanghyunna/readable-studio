import type { Dict } from '../i18n/types';
import type { AppTheme, ThemeScheme } from '../types';

export type ThemeLabelKey =
  | 'settings.themeSystem'
  | 'settings.themeLight'
  | 'settings.themeDark'
  | 'settings.themeMonokai'
  | 'settings.themeDracula'
  | 'settings.themeCatppuccinLatte'
  | 'settings.themeCatppuccinFrappe'
  | 'settings.themeCatppuccinMacchiato'
  | 'settings.themeCatppuccinMocha'
  | 'settings.themeNord'
  | 'settings.themeGruvbox'
  | 'settings.themeSolarizedDark'
  | 'settings.themeOneDark';

export const DEFAULT_THEME: AppTheme = 'light';

// The catalogue names themes; it carries no colours. Every surface that shows
// a theme's palette (the Theme modal, the settings chips) paints the theme's
// own tokens through the cascade, so `styles/tokens.css` and
// `styles/themes/*.css` stay the only copies.
export interface ThemeOption {
  id: AppTheme;
  labelKey: ThemeLabelKey;
  scheme: ThemeScheme | 'system';
}

export const THEME_OPTIONS = [
  { id: 'system', labelKey: 'settings.themeSystem', scheme: 'system' },
  { id: 'light', labelKey: 'settings.themeLight', scheme: 'light' },
  { id: 'dark', labelKey: 'settings.themeDark', scheme: 'dark' },
  { id: 'monokai', labelKey: 'settings.themeMonokai', scheme: 'dark' },
  { id: 'dracula', labelKey: 'settings.themeDracula', scheme: 'dark' },
  { id: 'catppuccin-latte', labelKey: 'settings.themeCatppuccinLatte', scheme: 'light' },
  { id: 'catppuccin-frappe', labelKey: 'settings.themeCatppuccinFrappe', scheme: 'dark' },
  { id: 'catppuccin-macchiato', labelKey: 'settings.themeCatppuccinMacchiato', scheme: 'dark' },
  { id: 'catppuccin-mocha', labelKey: 'settings.themeCatppuccinMocha', scheme: 'dark' },
  { id: 'nord', labelKey: 'settings.themeNord', scheme: 'dark' },
  { id: 'gruvbox', labelKey: 'settings.themeGruvbox', scheme: 'dark' },
  { id: 'solarized-dark', labelKey: 'settings.themeSolarizedDark', scheme: 'dark' },
  { id: 'one-dark', labelKey: 'settings.themeOneDark', scheme: 'dark' },
] as const satisfies readonly ThemeOption[];

export const EXPLICIT_THEME_OPTIONS = THEME_OPTIONS.filter((theme) => theme.id !== 'system');
export const THEME_SCHEME_BY_ID = Object.fromEntries(
  THEME_OPTIONS.flatMap((theme) => theme.scheme === 'system' ? [] : [[theme.id, theme.scheme]]),
) as Partial<Record<AppTheme, ThemeScheme>>;

const THEME_IDS = new Set<AppTheme>(THEME_OPTIONS.map((theme) => theme.id));
let themeById: Map<AppTheme, ThemeOption> | undefined;

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && THEME_IDS.has(value as AppTheme);
}

export function resolveThemeForStorage(value: unknown): AppTheme {
  return isAppTheme(value) ? value : DEFAULT_THEME;
}

export function explicitThemeScheme(theme: AppTheme | undefined): ThemeScheme | null {
  if (!theme || theme === 'system') return null;
  return THEME_SCHEME_BY_ID[theme] ?? null;
}

export function resolveDocumentThemeScheme(): ThemeScheme {
  if (typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.getAttribute('data-theme-scheme');
  if (explicit === 'dark' || explicit === 'light') return explicit;
  const theme = document.documentElement.getAttribute('data-theme');
  const scheme = theme === null ? null : explicitThemeScheme(resolveThemeForStorage(theme));
  if (scheme) return scheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function themeLabelKey(theme: AppTheme): keyof Pick<Dict, ThemeLabelKey> {
  themeById ??= new Map(THEME_OPTIONS.map((option) => [option.id, option]));
  return themeById.get(theme)?.labelKey ?? 'settings.themeSystem';
}
