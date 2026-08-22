// @vitest-environment jsdom

// Plugins home section — UI contract.
//
// The section renders artifact-kind filters for the starter grid:
// Prototype / Slides. Both expose a second row of scene buckets. Saved
// is an orthogonal user collection override, and sparse buckets should fall
// back to the normal empty-filter state rather than rendering synthetic
// cards.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { InstalledPluginRecord } from '@readable-studio/contracts';
import type { ComponentProps } from 'react';
import { PluginsHomeSection } from '../../src/components/PluginsHomeSection';
import { I18nProvider } from '../../src/i18n';

function makePlugin(overrides: {
  id: string;
  title?: string;
  titleI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
  tags?: string[];
  featured?: boolean;
  mode?: string;
  kind?: 'scenario' | 'atom';
}): InstalledPluginRecord {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    version: '0.1.0',
    sourceKind: 'bundled',
    source: '/tmp',
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    manifest: {
      name: overrides.id,
      version: '0.1.0',
      title: overrides.title ?? overrides.id,
      ...(overrides.titleI18n ? { title_i18n: overrides.titleI18n } : {}),
      ...(overrides.description ? { description: overrides.description } : {}),
      ...(overrides.descriptionI18n ? { description_i18n: overrides.descriptionI18n } : {}),
      ...(overrides.tags ? { tags: overrides.tags } : {}),
      readable: {
        kind: overrides.kind ?? 'scenario',
        ...(overrides.mode ? { mode: overrides.mode } : {}),
        ...(overrides.featured ? { featured: true } : {}),
      },
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

function renderSection(
  plugins: InstalledPluginRecord[] = sample,
  props: Partial<ComponentProps<typeof PluginsHomeSection>> = {},
) {
  return render(
    <PluginsHomeSection
      plugins={plugins}
      loading={false}
      activePluginId={null}
      pendingApplyId={null}
      onUse={() => {}}
      onOpenDetails={() => {}}
      {...props}
    />,
  );
}

function renderSectionInKorean(
  plugins: InstalledPluginRecord[] = sample,
  props: Partial<ComponentProps<typeof PluginsHomeSection>> = {},
) {
  return render(
    <I18nProvider initial="ko">
      <PluginsHomeSection
        plugins={plugins}
        loading={false}
        activePluginId={null}
        pendingApplyId={null}
        onUse={() => {}}
        onOpenDetails={() => {}}
        {...props}
      />
    </I18nProvider>
  );
}


function pluginIds(): Array<string | null> {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((i) => i.getAttribute('data-plugin-id'));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const sample: InstalledPluginRecord[] = [
  makePlugin({ id: 'prototype-dashboard', mode: 'prototype', tags: ['dashboard'] }),
  makePlugin({ id: 'prototype-app', mode: 'prototype', tags: ['mobile-app'] }),
  makePlugin({ id: 'example-flowai-live-dashboard-template', mode: 'prototype', tags: ['dashboard'] }),
  makePlugin({ id: 'example-live-artifact', mode: 'prototype', tags: ['live-artifact'] }),
  makePlugin({ id: 'deck-pitch', mode: 'deck', tags: ['pitch-deck'], featured: true }),
  makePlugin({ id: 'hidden-atom', mode: 'prototype', tags: ['dashboard'], kind: 'atom' }),
];

describe('PluginsHomeSection (community gallery)', () => {
  it('keeps gallery tiles free of inline Use actions — Use lives in the detail modal', () => {
    renderSection(sample, { cardLayout: 'gallery' });

    // The tile itself stays a pure preview: name button opens details,
    // ↗ opens the example page. Use / Use with query are detail-modal
    // affordances only.
    expect(screen.getByTestId('plugins-home-details-prototype-dashboard')).toBeTruthy();
    expect(screen.queryByTestId('plugins-home-use-prototype-dashboard')).toBeNull();
    expect(screen.queryByTestId('plugins-home-use-menu-prototype-dashboard')).toBeNull();
    expect(screen.queryByTestId('plugins-home-use-with-query-prototype-dashboard')).toBeNull();
  });

  it('keeps the inline Use menu on the rich management layout (PluginsView)', () => {
    renderSection(sample, { cardLayout: 'rich' });

    expect(screen.getByTestId('plugins-home-use-prototype-dashboard')).toBeTruthy();
  });
});

describe('PluginsHomeSection (category bar)', () => {
  it('frames the home shelf as community and can jump to registry', () => {
    const onBrowseRegistry = vi.fn();
    renderSection(sample, { onBrowseRegistry });

    expect(screen.getByText('Community')).toBeTruthy();
    fireEvent.click(screen.getByTestId('plugins-home-browse-registry'));
    expect(onBrowseRegistry).toHaveBeenCalledTimes(1);
  });

  it('renders the artifact category row and the default Prototype scene row', () => {
    renderSection();

    expect(screen.getByTestId('plugins-home-row-category')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-chip-saved').textContent).toContain('Saved');
    expect(screen.getByTestId('plugins-home-pill-category-all')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-pill-category-prototype')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-pill-category-deck')).toBeTruthy();
    expect(screen.queryByTestId('plugins-home-pill-category-import')).toBeNull();
    expect(screen.queryByTestId('plugins-home-pill-category-create')).toBeNull();
    expect(screen.queryByTestId('plugins-home-pill-category-export')).toBeNull();

    expect(screen.getByTestId('plugins-home-row-subcategory-prototype')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-pill-subcategory-prototype-business-dashboards')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-pill-subcategory-prototype-app-prototypes')).toBeTruthy();
    expect(screen.getByTestId('plugins-home-pill-subcategory-prototype-developer-tools')).toBeTruthy();
  });

  it('keeps sparse subcategories as real filters without adding contribution cards', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-pill-category-deck'));
    fireEvent.click(screen.getByTestId('plugins-home-pill-subcategory-deck-pitch-business'));

    expect(pluginIds()).toEqual(['deck-pitch']);
    expect(screen.queryByTestId('plugins-home-contribution-card')).toBeNull();
    expect(screen.queryByText(/Contribute a/i)).toBeNull();
  });

  it('saves a plugin, updates the Saved chip, and shows a toast', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-save-prototype-dashboard'));

    expect(screen.getByTestId('plugins-home-save-prototype-dashboard').textContent).toContain('Saved');
    expect(screen.getByTestId('plugins-home-chip-saved').textContent).toContain('1');
    expect(screen.getByRole('status').textContent).toContain('Saved prototype-dashboard.');

    fireEvent.click(screen.getByTestId('plugins-home-chip-saved'));
    expect(pluginIds()).toEqual(['prototype-dashboard']);
  });

  it('localizes plugin card titles, descriptions, search, and save toast', () => {
    renderSectionInKorean([
      makePlugin({
        id: 'localized-deck',
        title: 'Swiss International Deck',
        titleI18n: { en: 'Swiss International Deck', ko: '스위스 인터내셔널 덱' },
        description: '16-column grid.',
        descriptionI18n: { en: '16-column grid.', ko: '16열 그리드.' },
        mode: 'deck',
        tags: ['grid'],
      }),
    ], { preferDefaultFacet: false });

    expect(screen.getAllByText('스위스 인터내셔널 덱').length).toBeGreaterThan(0);
    expect(screen.queryByText('Swiss International Deck')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('플러그인 검색…'), {
      target: { value: '스위스' },
    });
    expect(pluginIds()).toEqual(['localized-deck']);

    fireEvent.click(screen.getByTestId('plugins-home-save-localized-deck'));
    expect(screen.getByRole('status').textContent).toContain('Saved 스위스 인터내셔널 덱.');
  });

  it('shows the normal empty-filter state for planned empty buckets', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-pill-category-deck'));
    fireEvent.click(screen.getByTestId('plugins-home-pill-subcategory-deck-course-training'));

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(/No plugins match the current filters/i)).toBeTruthy();
    expect(screen.queryByTestId('plugins-home-contribution-card')).toBeNull();
  });

  it('All pill clears the category filter and only shows user-facing plugins', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-pill-category-all'));
    expect(pluginIds().sort()).toEqual([
      'deck-pitch',
      'example-flowai-live-dashboard-template',
      'example-live-artifact',
      'prototype-app',
      'prototype-dashboard',
    ]);
  });

  it('Saved chip overrides the category selection and shows only saved plugins', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-save-prototype-dashboard'));
    fireEvent.click(screen.getByTestId('plugins-home-pill-category-deck'));
    fireEvent.click(screen.getByTestId('plugins-home-chip-saved'));

    expect(pluginIds()).toEqual(['prototype-dashboard']);
  });

  it('Clear filters from the Saved empty state escapes Saved mode back to the full catalog', () => {
    // Fresh browser, no saved plugins yet. Clicking Saved lands the
    // user on the empty filter state — the recovery CTA must take
    // them all the way back to the catalog, not just re-render the
    // same Saved empty view.
    renderSection();

    fireEvent.click(screen.getByTestId('plugins-home-chip-saved'));
    expect(screen.queryByRole('list')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/i }));

    expect(pluginIds().sort()).toEqual([
      'deck-pitch',
      'example-flowai-live-dashboard-template',
      'example-live-artifact',
      'prototype-app',
      'prototype-dashboard',
    ]);
  });
});
