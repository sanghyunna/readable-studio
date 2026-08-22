// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
  resolveAccentColor,
} from '../../src/state/appearance';

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

describe('normalizeAccentColor', () => {
  it('accepts six-digit hex colors and normalizes casing', () => {
    expect(normalizeAccentColor('  #4F46E5  ')).toBe('#4f46e5');
  });

  it('rejects invalid accent colors', () => {
    expect(normalizeAccentColor('blue')).toBeNull();
    expect(normalizeAccentColor('#123')).toBeNull();
    expect(normalizeAccentColor('#12345g')).toBeNull();
  });
});

describe('resolveAccentColor', () => {
  it('falls back to the first appearance color for missing or invalid values', () => {
    expect(resolveAccentColor(undefined)).toBe(DEFAULT_ACCENT_COLOR);
    expect(resolveAccentColor('blue')).toBe(DEFAULT_ACCENT_COLOR);
  });
});

describe('applyAppearanceToDocument', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-scheme');
    for (const name of ACCENT_VARS) {
      document.documentElement.style.removeProperty(name);
    }
  });

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['monokai', 'dark'],
    ['catppuccin-latte', 'light'],
  ] as const)(
    'applies the %s theme and scheme to the root element',
    (theme, scheme) => {
      applyAppearanceToDocument({ theme, accentColorMode: 'theme' });

      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      expect(document.documentElement.getAttribute('data-theme-scheme')).toBe(scheme);
    },
  );

  it('does not apply appearance colors to global background variables', () => {
    document.documentElement.style.setProperty('--bg', '#faf9f7');
    document.documentElement.style.setProperty('--bg-app', '#faf9f7');

    applyAppearanceToDocument({
      theme: 'light',
      accentColor: '#059669',
      accentColorMode: 'custom',
    });

    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#faf9f7');
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#faf9f7');

    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--bg-app');
  });

  it('clears explicit theme attributes for system mode', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-scheme', 'dark');

    applyAppearanceToDocument({ theme: 'system', accentColorMode: 'theme' });

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.hasAttribute('data-theme-scheme')).toBe(false);
  });

  it('clears inline accent variables in theme accent mode', () => {
    for (const name of ACCENT_VARS) {
      document.documentElement.style.setProperty(name, '#4f46e5');
    }

    applyAppearanceToDocument({
      theme: 'dracula',
      accentColor: '#10B981',
      accentColorMode: 'theme',
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
    expect(document.documentElement.getAttribute('data-theme-scheme')).toBe('dark');
    for (const name of ACCENT_VARS) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe('');
    }
  });

  it('applies accent variables in custom accent mode', () => {
    applyAppearanceToDocument({
      theme: 'system',
      accentColor: '#10B981',
      accentColorMode: 'custom',
    });

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.hasAttribute('data-theme-scheme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-tint')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toContain('#10b981');
  });

  it('replaces existing accent variables when the saved color changes', () => {
    applyAppearanceToDocument({
      theme: 'light',
      accentColor: '#4F46E5',
      accentColorMode: 'custom',
    });

    applyAppearanceToDocument({
      theme: 'light',
      accentColor: '#EF4444',
      accentColorMode: 'custom',
    });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).not.toContain('#4f46e5');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-tint')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toContain('#ef4444');
  });

  it('falls back to the default accent when no valid accent is configured', () => {
    document.documentElement.style.setProperty('--accent', '#4f46e5');

    applyAppearanceToDocument({
      theme: 'system',
      accentColor: 'not-a-color',
      accentColorMode: 'custom',
    });

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT_COLOR);
  });
});
