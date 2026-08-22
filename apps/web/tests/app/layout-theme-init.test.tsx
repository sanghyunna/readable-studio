// @vitest-environment jsdom

import { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RootLayout from '../../app/layout';
import { I18nProvider } from '../../src/i18n';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

function findThemeInitScript(node: ReactNode): string | null {
  if (!isValidElement(node)) return null;

  const props = node.props as {
    children?: ReactNode;
    dangerouslySetInnerHTML?: { __html?: string };
  };
  if (node.type === 'script') return props.dangerouslySetInnerHTML?.__html ?? null;

  for (const child of Children.toArray(props.children)) {
    const found = findThemeInitScript(child);
    if (found) return found;
  }
  return null;
}

function containsElementType(node: ReactNode, type: unknown): boolean {
  if (!isValidElement(node)) return false;
  if (node.type === type) return true;
  const props = node.props as { children?: ReactNode };
  return Children.toArray(props.children).some((child) => containsElementType(child, type));
}

describe('RootLayout theme init script', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-scheme');
  });

  it.each(EXPLICIT_THEME_OPTIONS)(
    'prehydrates the $id theme from the registry',
    (theme) => {
      const script = findThemeInitScript(RootLayout({ children: null }));
      expect(script).toBeTruthy();

      localStorage.setItem('readable-studio:config', JSON.stringify({ theme: theme.id }));
      new Function(script ?? '')();

      expect(document.documentElement.getAttribute('data-theme')).toBe(theme.id);
      expect(document.documentElement.getAttribute('data-theme-scheme')).toBe(theme.scheme);
    },
  );

  it('serializes the hosted marker before theme initialization and never reads local app config', () => {
    const previousComposition = process.env.READABLE_WEB_COMPOSITION;
    process.env.READABLE_WEB_COMPOSITION = 'hosted';

    try {
      const layout = RootLayout({ children: null });
      expect(layout.props['data-readable-composition']).toBe('hosted');

      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const script = findThemeInitScript(layout);
      expect(script).toBeTruthy();

      document.documentElement.setAttribute('data-readable-composition', 'hosted');
      new Function(script ?? '')();

      expect(getItem).not.toHaveBeenCalledWith('readable-studio:config');
      getItem.mockRestore();
    } finally {
      if (previousComposition == null) delete process.env.READABLE_WEB_COMPOSITION;
      else process.env.READABLE_WEB_COMPOSITION = previousComposition;
      document.documentElement.removeAttribute('data-readable-composition');
    }
  });

  it('does not mount the local locale provider in hosted composition', () => {
    const previousComposition = process.env.READABLE_WEB_COMPOSITION;
    process.env.READABLE_WEB_COMPOSITION = 'hosted';
    try {
      expect(containsElementType(RootLayout({ children: null }), I18nProvider)).toBe(false);
    } finally {
      if (previousComposition == null) delete process.env.READABLE_WEB_COMPOSITION;
      else process.env.READABLE_WEB_COMPOSITION = previousComposition;
    }
    expect(containsElementType(RootLayout({ children: null }), I18nProvider)).toBe(true);
  });
});
