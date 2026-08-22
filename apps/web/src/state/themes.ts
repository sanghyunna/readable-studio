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

export interface ThemeOption {
  id: AppTheme;
  labelKey: ThemeLabelKey;
  scheme: ThemeScheme | 'system';
  swatch: readonly [string, string, string];
}

export const THEME_OPTIONS = [
  { id: 'system', labelKey: 'settings.themeSystem', scheme: 'system', swatch: ['#faf9f7', '#c96442', '#1a1916'] },
  { id: 'light', labelKey: 'settings.themeLight', scheme: 'light', swatch: ['#faf9f7', '#c96442', '#1a1916'] },
  { id: 'dark', labelKey: 'settings.themeDark', scheme: 'dark', swatch: ['#1a1917', '#d97a56', '#f2ede4'] },
  { id: 'monokai', labelKey: 'settings.themeMonokai', scheme: 'dark', swatch: ['#272822', '#a6e22e', '#f8f8f2'] },
  { id: 'dracula', labelKey: 'settings.themeDracula', scheme: 'dark', swatch: ['#282a36', '#ff79c6', '#f8f8f2'] },
  { id: 'catppuccin-latte', labelKey: 'settings.themeCatppuccinLatte', scheme: 'light', swatch: ['#eff1f5', '#8839ef', '#4c4f69'] },
  { id: 'catppuccin-frappe', labelKey: 'settings.themeCatppuccinFrappe', scheme: 'dark', swatch: ['#303446', '#ca9ee6', '#c6d0f5'] },
  { id: 'catppuccin-macchiato', labelKey: 'settings.themeCatppuccinMacchiato', scheme: 'dark', swatch: ['#24273a', '#c6a0f6', '#cad3f5'] },
  { id: 'catppuccin-mocha', labelKey: 'settings.themeCatppuccinMocha', scheme: 'dark', swatch: ['#1e1e2e', '#cba6f7', '#cdd6f4'] },
  { id: 'nord', labelKey: 'settings.themeNord', scheme: 'dark', swatch: ['#2e3440', '#88c0d0', '#e5e9f0'] },
  { id: 'gruvbox', labelKey: 'settings.themeGruvbox', scheme: 'dark', swatch: ['#282828', '#fabd2f', '#ebdbb2'] },
  { id: 'solarized-dark', labelKey: 'settings.themeSolarizedDark', scheme: 'dark', swatch: ['#002b36', '#268bd2', '#839496'] },
  { id: 'one-dark', labelKey: 'settings.themeOneDark', scheme: 'dark', swatch: ['#282c34', '#61afef', '#abb2bf'] },
] as const satisfies readonly ThemeOption[];

export const EXPLICIT_THEME_OPTIONS = THEME_OPTIONS.filter((theme) => theme.id !== 'system');
export const THEME_SCHEME_BY_ID = Object.fromEntries(
  THEME_OPTIONS.flatMap((theme) => theme.scheme === 'system' ? [] : [[theme.id, theme.scheme]]),
) as Partial<Record<AppTheme, ThemeScheme>>;

const THEME_IDS = new Set<AppTheme>(THEME_OPTIONS.map((theme) => theme.id));
const THEME_BY_ID = new Map<AppTheme, ThemeOption>(THEME_OPTIONS.map((theme) => [theme.id, theme]));

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && THEME_IDS.has(value as AppTheme);
}

export function resolveThemeForStorage(value: unknown): AppTheme {
  return isAppTheme(value) ? value : 'system';
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
  const scheme = explicitThemeScheme(resolveThemeForStorage(theme));
  if (scheme) return scheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function themeLabelKey(theme: AppTheme): keyof Pick<Dict, ThemeLabelKey> {
  return THEME_BY_ID.get(theme)?.labelKey ?? 'settings.themeSystem';
}
