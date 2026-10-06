import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';
import { PluginManifestSchema } from '@readable-studio/contracts';

import { homeHeroExamplePluginsForChip, pluginMatchesExampleChip } from '../../src/components/HomeHero';
import { HUB_TEMPLATE_TAB_IDS, sortHubTemplateItemsByFavorite } from '../../src/components/home-hero/templateCarousel';
import { CURATED_PLUGIN_IDS_BY_CHIP } from '../../src/components/plugins-home/curatedPriority';

const manifests = import.meta.glob('../../../../plugins/_official/examples/*/readable-studio.json', {
  eager: true, import: 'default',
});
const catalogue: InstalledPluginRecord[] = Object.entries(manifests).map(([path, raw]) => {
  const manifest = PluginManifestSchema.parse(raw);
  return {
    id: manifest.name.toLowerCase(), title: manifest.title ?? manifest.name,
    version: manifest.version, sourceKind: 'bundled', source: path,
    trust: 'bundled', capabilitiesGranted: ['prompt:inject'], manifest,
    fsPath: path, installedAt: 0, updatedAt: 0,
  };
});

const typeForChip = (chip: string) => chip === 'prototype' ? 'website' : chip;

describe('Hub template membership from reviewed manifests', () => {
  it('files every bundled template in exactly its declared tab, or none', () => {
    expect(catalogue).toHaveLength(149);
    for (const locale of ['ko', 'en'] as const) {
      const tabs = HUB_TEMPLATE_TAB_IDS.map((chip) => ({
        type: typeForChip(chip),
        ids: homeHeroExamplePluginsForChip(chip, catalogue, locale, { limit: Infinity }).map(({ id }) => id),
      }));
      for (const record of catalogue) {
        const type = record.manifest.readable?.hubType;
        expect(['deck', 'report', 'website', 'none'], record.id).toContain(type);
        const memberships = tabs.filter(({ ids }) => ids.includes(record.id)).map(({ type }) => type);
        expect(memberships, record.id).toEqual(type === 'none' ? [] : [type]);
        expect(memberships.length, record.id).toBeLessThanOrEqual(1);
      }
      expect(tabs.map(({ ids }) => ids.length)).toEqual([60, 19, 45]);
    }
  });

  it('explicit types override localized titles, tags, modes and curated IDs', () => {
    const original = catalogue.find(({ id }) => id === 'example-mythic-naturecore')!;
    for (const hubType of ['deck', 'report', 'website', 'none'] as const) {
      const record = {
        ...original, title: 'report slide deck web-prototype',
        manifest: {
          ...original.manifest, tags: ['deck', 'report', 'web-prototype'],
          readable: { ...original.manifest.readable, mode: 'prototype', hubType },
        },
      };
      for (const chip of HUB_TEMPLATE_TAB_IDS) {
        const matches = hubType === typeForChip(chip);
        expect(pluginMatchesExampleChip(record, chip)).toBe(matches);
        expect(homeHeroExamplePluginsForChip(chip, [record], 'ko')).toEqual(matches ? [record] : []);
      }
    }
  });

  it('requires a usable query even for curated templates', () => {
    const original = catalogue.find(({ id }) => id === 'example-mythic-naturecore')!;
    const record = { ...original, manifest: {
      ...original.manifest, readable: { ...original.manifest.readable, useCase: { query: ' ' } },
    } };
    expect(homeHeroExamplePluginsForChip('prototype', [record], 'ko')).toEqual([]);
  });

  it('keeps the chip cap at 18, preserves curated order and sorts favorites first', () => {
    for (const chip of HUB_TEMPLATE_TAB_IDS) {
      const full = homeHeroExamplePluginsForChip(chip, catalogue, 'ko', { limit: Infinity });
      expect(homeHeroExamplePluginsForChip(chip, catalogue, 'ko')).toEqual(full.slice(0, 18));
      const curated = (CURATED_PLUGIN_IDS_BY_CHIP as Record<string, readonly string[]>)[chip] ?? [];
      expect(full.filter(({ id }) => curated.includes(id)).map(({ id }) => id))
        .toEqual(curated.filter((id) => full.some((record) => record.id === id)));
      const favorite = full.at(-1)!;
      const items = full.map((record) => ({ record, chipId: chip }));
      expect(sortHubTemplateItemsByFavorite(items, [favorite.id])).toEqual([
        items.at(-1), ...items.slice(0, -1),
      ]);
    }
  });

  it('retains legacy matching only when an external manifest has no explicit type', () => {
    const record = catalogue.find(({ id }) => id === 'example-web-prototype')!;
    const { hubType: _hubType, ...readable } = record.manifest.readable!;
    const external = { ...record, sourceKind: 'local' as const, manifest: { ...record.manifest, readable } };
    expect(pluginMatchesExampleChip(external, 'prototype')).toBe(true);
    expect(pluginMatchesExampleChip(external, 'deck')).toBe(false);
  });
});
