// Facet derivation contract for the plugins-home filter row. The
// home section is driven by artifact-kind primary tabs that mirror the
// artifact creation surface, plus scene buckets derived from the
// user-query taxonomy for the crowded template types.

import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';
import {
  applyFacetSelection,
  buildFacetCatalog,
  extractCategories,
  extractSubcategories,
  isFeaturedPlugin,
  resolveDefaultSelection,
} from '../../src/components/plugins-home/facets';

function fixture(overrides: {
  id: string;
  title?: string;
  tags?: string[];
  readable?: Record<string, unknown>;
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
      ...(overrides.tags ? { tags: overrides.tags } : {}),
      ...(overrides.readable ? { readable: overrides.readable } : {}),
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

describe('extractCategories', () => {
  it('maps generation modes to artifact-kind primary tabs', () => {
    expect(extractCategories(fixture({ id: 'prototype', readable: { mode: 'prototype' } }))).toEqual(['prototype']);
    expect(extractCategories(fixture({ id: 'deck', readable: { mode: 'deck' } }))).toEqual(['deck']);
  });

  it('keeps non-artifact workflow and design-system plugins out of primary tabs', () => {
    expect(extractCategories(fixture({ id: 'design-system', readable: { mode: 'design-system' } }))).toEqual([]);
    expect(extractCategories(fixture({ id: 'import', readable: { taskKind: 'figma-migration', mode: 'scenario' } }))).toEqual([]);
    expect(extractCategories(fixture({ id: 'export', tags: ['export', 'react'], readable: { mode: 'export' } }))).toEqual([]);
    expect(extractCategories(fixture({ id: 'utility', readable: { mode: 'utility' } }))).toEqual([]);
  });

  it('normalises mode casing / formatting via slugify before matching', () => {
    expect(extractCategories(fixture({ id: 'a', readable: { mode: 'Prototype' } }))).toEqual(['prototype']);
    expect(extractCategories(fixture({ id: 'b', readable: { mode: 'slide_deck' } }))).toEqual([]);
    expect(extractCategories(fixture({ id: 'c', readable: { mode: 'deck' } }))).toEqual(['deck']);
  });
});

describe('extractSubcategories', () => {
  it('maps prototype templates to prompt-taxonomy scene buckets', () => {
    expect(extractSubcategories(fixture({ id: 'dashboard', tags: ['dashboard'], readable: { mode: 'prototype' } }))).toEqual(['business-dashboards']);
    expect(extractSubcategories(fixture({ id: 'app', tags: ['mobile-app'], readable: { mode: 'prototype' } }))).toEqual(['app-prototypes']);
    expect(extractSubcategories(fixture({ id: 'landing', tags: ['saas-landing'], readable: { mode: 'prototype' } }))).toEqual(['landing-marketing']);
    expect(extractSubcategories(fixture({ id: 'dev', tags: ['engineering'], readable: { mode: 'prototype' } }))).toEqual(['developer-tools']);
    expect(extractSubcategories(fixture({ id: 'clinical', tags: ['case-report'], readable: { mode: 'prototype' } }))).toEqual(['docs-reports']);
    expect(extractSubcategories(fixture({ id: 'brand', tags: ['wireframe'], readable: { mode: 'prototype' } }))).toEqual(['brand-design']);
  });

  it('maps deck templates to pitch, course, report, product, engineering, and creative scenes', () => {
    expect(extractSubcategories(fixture({ id: 'pitch', tags: ['pitch-deck'], readable: { mode: 'deck' } }))).toEqual(['pitch-business']);
    expect(extractSubcategories(fixture({ id: 'course', tags: ['course-module'], readable: { mode: 'deck' } }))).toEqual(['course-training']);
    expect(extractSubcategories(fixture({ id: 'report', tags: ['weekly-report'], readable: { mode: 'deck' } }))).toEqual(['reports-briefings']);
    expect(extractSubcategories(fixture({ id: 'launch', tags: ['product-launch'], readable: { mode: 'deck' } }))).toEqual(['product-sales']);
    expect(extractSubcategories(fixture({ id: 'tech', tags: ['tech-sharing'], readable: { mode: 'deck' } }))).toEqual(['engineering-talks']);
    expect(extractSubcategories(fixture({ id: 'creative', tags: ['zhangzara'], readable: { mode: 'deck' } }))).toEqual(['creative-decks']);
  });

  // Regression: the rail/catalog display order (SUBCATEGORY_DISPLAY_ORDER) must
  // NOT change which bucket an overlapping-tag plugin lands in. Bucketing is
  // decided by SUBCATEGORIES matching precedence, which stays stable even
  // though Brand / design and Creative decks render first in the rails.
  it('keeps bucket membership stable for overlapping-tag plugins regardless of display order', () => {
    // `dashboard` + `design`: stays in Dashboards (not Brand / design).
    expect(
      extractSubcategories(fixture({ id: 'dash-glass', tags: ['dashboard', 'design'], readable: { mode: 'prototype' } })),
    ).toEqual(['business-dashboards']);
    // mobile app + `design`: stays in Apps (not Brand / design).
    expect(
      extractSubcategories(fixture({ id: 'mobile', tags: ['mobile-app', 'design'], readable: { mode: 'prototype' } })),
    ).toEqual(['app-prototypes']);
    // landing + `brand`: stays in Landing / marketing (not Brand / design).
    expect(
      extractSubcategories(fixture({ id: 'landing-brand', tags: ['saas-landing', 'brand'], readable: { mode: 'prototype' } })),
    ).toEqual(['landing-marketing']);
    // launch deck + `marketing`: stays in Product / sales (not Creative decks).
    expect(
      extractSubcategories(fixture({ id: 'launch', tags: ['product-launch', 'marketing'], readable: { mode: 'deck' } })),
    ).toEqual(['product-sales']);
    // pitch deck + `marketing`: stays in Pitch / business (not Creative decks).
    expect(
      extractSubcategories(fixture({ id: 'pitch-mkt', tags: ['pitch-deck', 'marketing'], readable: { mode: 'deck' } })),
    ).toEqual(['pitch-business']);
  });
});

describe('buildFacetCatalog', () => {
  it('produces artifact-kind primary tabs in product order', () => {
    const catalog = buildFacetCatalog([
      fixture({ id: 'prototype', tags: ['dashboard'], readable: { mode: 'prototype' } }),
      fixture({ id: 'deck', tags: ['pitch-deck'], readable: { mode: 'deck' } }),
      fixture({ id: 'design-system', readable: { mode: 'design-system' } }),
    ]);

    expect(catalog.category.map((o) => [o.slug, o.count])).toEqual([
      ['prototype', 1],
      ['deck', 1],
    ]);
    // Display order (SUBCATEGORY_DISPLAY_ORDER) — distinct from the matching
    // precedence encoded by the SUBCATEGORIES array order.
    expect((catalog.subcategory.prototype ?? []).map((o) => o.slug)).toEqual([
      'landing-marketing',
      'brand-design',
      'business-dashboards',
      'app-prototypes',
      'developer-tools',
      'docs-reports',
    ]);
    expect((catalog.subcategory.deck ?? []).map((o) => o.slug)).toEqual([
      'creative-decks',
      'engineering-talks',
      'pitch-business',
      'course-training',
      'reports-briefings',
      'product-sales',
    ]);
    expect(catalog.subcategory['live-artifact']).toBeUndefined();
  });
});

describe('applyFacetSelection', () => {
  const plugins = [
    fixture({ id: 'prototype-dashboard', tags: ['dashboard'], readable: { mode: 'prototype' } }),
    fixture({ id: 'prototype-app', tags: ['mobile-app'], readable: { mode: 'prototype' } }),
    fixture({ id: 'deck', tags: ['pitch-deck'], readable: { mode: 'deck' } }),
  ];

  it('returns everything when no category is selected', () => {
    expect(
      applyFacetSelection(plugins, { category: null, subcategory: null }).map((p) => p.id),
    ).toEqual([
      'prototype-dashboard',
      'prototype-app',
      'deck',
    ]);
  });

  it('filters by the selected artifact-kind category slug', () => {
    expect(
      applyFacetSelection(plugins, { category: 'prototype', subcategory: null }).map((p) => p.id),
    ).toEqual(['prototype-dashboard', 'prototype-app']);
    expect(
      applyFacetSelection(plugins, { category: 'deck', subcategory: null }).map((p) => p.id),
    ).toEqual(['deck']);
  });

  it('filters by the selected scene bucket inside the selected artifact kind', () => {
    expect(
      applyFacetSelection(plugins, { category: 'prototype', subcategory: 'business-dashboards' }).map((p) => p.id),
    ).toEqual(['prototype-dashboard']);
    expect(
      applyFacetSelection(plugins, { category: 'prototype', subcategory: 'app-prototypes' }).map((p) => p.id),
    ).toEqual(['prototype-app']);
  });
});

describe('isFeaturedPlugin', () => {
  it('returns true for boolean featured picks and numeric curator ranks', () => {
    expect(isFeaturedPlugin(fixture({ id: 'a', readable: { featured: true } }))).toBe(true);
    expect(isFeaturedPlugin(fixture({ id: 'ranked', readable: { featured: 4 } }))).toBe(true);
    expect(isFeaturedPlugin(fixture({ id: 'b', readable: { featured: 'true' } }))).toBe(false);
    expect(isFeaturedPlugin(fixture({ id: 'c' }))).toBe(false);
  });
});

describe('resolveDefaultSelection', () => {
  it('defaults the home catalog to Prototype when that bucket exists', () => {
    const catalog = buildFacetCatalog([
      fixture({ id: 'slides', readable: { mode: 'deck' } }),
      fixture({ id: 'prototype', readable: { mode: 'prototype' } }),
    ]);

    expect(resolveDefaultSelection(catalog)).toEqual({
      category: 'prototype',
      subcategory: null,
    });
  });

  it('falls back to the first populated artifact kind when Prototype is unavailable', () => {
    const catalog = buildFacetCatalog([
      fixture({ id: 'slides', readable: { mode: 'deck' } }),
    ]);

    expect(resolveDefaultSelection(catalog)).toEqual({
      category: 'deck',
      subcategory: null,
    });
  });
});
