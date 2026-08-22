// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig, AppTheme } from '../../src/types';

const { analyticsTrackMock } = vi.hoisted(() => ({
  analyticsTrackMock: vi.fn(),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: analyticsTrackMock }) };
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: null,
    agentModels: {},
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderMenu({
  config = baseConfig(),
  onThemeChange = vi.fn(),
}: {
  config?: AppConfig;
  onThemeChange?: (theme: AppTheme) => void;
} = {}) {
  return {
    onThemeChange,
    ...render(
      <I18nProvider initial="en">
        <EntrySettingsMenu
          config={config}
          onThemeChange={onThemeChange}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    ),
  };
}

const EXPECTED_THEME_OPTIONS: Array<{ id: AppTheme; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'one-dark', label: 'One Dark' },
];

beforeEach(() => {
  analyticsTrackMock.mockReset();
  globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('EntrySettingsMenu language picker a11y', () => {
  it('keeps one consistent menu model and hides the collapsed locale list from a11y/focus', () => {
    const { container } = renderMenu();
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    // The picker trigger participates in the surrounding role="menu" popover as
    // a menuitem that opens a submenu — not a listbox combobox.
    const langTrigger = container.querySelector(
      '.entry-settings-menu__select-trigger',
    ) as HTMLElement;
    expect(langTrigger.getAttribute('role')).toBe('menuitem');
    expect(langTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(langTrigger.getAttribute('aria-expanded')).toBe('false');

    // No mixed listbox/option ARIA — locale choices are menuitemradios.
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();
    const panel = container.querySelector(
      '.entry-settings-menu__select-panel',
    ) as HTMLElement;
    expect(panel.getAttribute('role')).toBe('menu');
    const radios = panel.querySelectorAll('[role="menuitemradio"]');
    expect(radios.length).toBeGreaterThan(1);
    expect(
      Array.from(radios).filter((r) => r.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(1);

    // Collapsed: the list is inert, so the options stay out of the a11y tree
    // and the tab order even though they remain mounted for the animation.
    const list = container.querySelector(
      '.entry-settings-menu__select-list',
    ) as HTMLElement;
    expect(list.hasAttribute('inert')).toBe(true);

    // Opening flips aria-expanded and lifts inert.
    fireEvent.click(langTrigger);
    expect(langTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(list.hasAttribute('inert')).toBe(false);
  });
});

describe('EntrySettingsMenu theme picker', () => {
  it('renders every registry theme and selects a named theme', () => {
    const { container, onThemeChange } = renderMenu();
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    const themeRow = container.querySelector(
      '.entry-settings-menu__theme-row',
    ) as HTMLElement;
    for (const option of EXPECTED_THEME_OPTIONS) {
      expect(
        within(themeRow).getByRole('menuitemradio', { name: option.label }),
      ).toBeTruthy();
    }

    fireEvent.click(
      within(themeRow).getByRole('menuitemradio', { name: 'Catppuccin Latte' }),
    );

    expect(onThemeChange).toHaveBeenCalledWith('catppuccin-latte');
    expect(analyticsTrackMock).toHaveBeenCalledWith(
      'ui_click',
      expect.objectContaining({
        page_name: 'home',
        area: 'settings_popover',
        element: 'appearance',
        value: 'catppuccin_latte',
      }),
      undefined,
    );
  });

  it('uses roving focus for theme menu keyboard navigation', () => {
    const { container } = renderMenu({ config: baseConfig({ theme: 'dracula' }) });
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    const themeRow = container.querySelector(
      '.entry-settings-menu__theme-row',
    ) as HTMLElement;
    const dracula = within(themeRow).getByRole('menuitemradio', { name: 'Dracula' });
    const latte = within(themeRow).getByRole('menuitemradio', { name: 'Catppuccin Latte' });
    const system = within(themeRow).getByRole('menuitemradio', { name: 'System' });

    expect(dracula.getAttribute('tabindex')).toBe('0');
    expect(latte.getAttribute('tabindex')).toBe('-1');

    dracula.focus();
    fireEvent.keyDown(dracula, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(latte);

    fireEvent.keyDown(latte, { key: 'Home' });
    expect(document.activeElement).toBe(system);
  });
});
