import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('theme label index initialization', () => {
  it('does not build label entries when importing first-paint theme settings', async () => {
    // Given a call-through observer of catalogue transformations.
    const map = vi.spyOn(Array.prototype, 'map');
    // When importing the theme catalogue for appearance setup.
    const themes = await import('../../src/state/themes');
    const mappedEntries = map.mock.results.filter((_result, index) => map.mock.contexts[index] === themes.THEME_OPTIONS);
    // Then only the first-paint validation ids are mapped, not label tuples.
    expect(mappedEntries).toHaveLength(1);
    expect(mappedEntries[0]?.value).toEqual(themes.THEME_OPTIONS.map((theme) => theme.id));
  });

  it('constructs label entries when the first label is requested', async () => {
    // Given the catalogue without any label requests.
    const themes = await import('../../src/state/themes');
    const map = vi.spyOn(Array.prototype, 'map');
    // When resolving a non-default label.
    const label = themes.themeLabelKey('nord');
    const mappings = map.mock.contexts.filter((value) => value === themes.THEME_OPTIONS);
    // Then the typed translation key is resolved after one construction.
    expect(label).toBe('settings.themeNord');
    expect(mappings).toHaveLength(1);
  });

  it('reuses label entries when resolving another theme', async () => {
    // Given an initialized label index.
    const themes = await import('../../src/state/themes');
    themes.themeLabelKey('nord');
    const map = vi.spyOn(Array.prototype, 'map');
    // When another theme label is requested.
    const label = themes.themeLabelKey('catppuccin-mocha');
    const mappings = map.mock.contexts.filter((value) => value === themes.THEME_OPTIONS);
    // Then the index is reused with the correct distinct translation key.
    expect(label).toBe('settings.themeCatppuccinMocha');
    expect(mappings).toHaveLength(0);
  });

  it.each(['system', 'light', 'dark', 'dracula', 'one-dark'] as const)('preserves the catalogue label when %s is the first lookup', async (id) => {
    // Given an independent expected key from the catalogue.
    const themes = await import('../../src/state/themes');
    const expected = themes.THEME_OPTIONS.find((theme) => theme.id === id)?.labelKey;
    // When the named theme is the first label requested.
    const label = themes.themeLabelKey(id);
    // Then lazy initialization preserves its label key.
    expect(label).toBe(expected);
  });
});
