import type { InstalledPluginRecord } from '@readable-studio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin: InstalledPluginRecord = {
  id: 'example-mythic-naturecore',
  title: 'Fixture',
  version: '0.1.0',
  sourceKind: 'bundled',
  source: '/fixture',
  trust: 'bundled',
  capabilitiesGranted: ['prompt:inject'],
  manifest: { name: 'fixture', version: '0.1.0' },
  fsPath: '/fixture',
  installedAt: 0,
  updatedAt: 0,
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('curated plugin rank initialization', () => {
  it('does not build global ranks when importing chip priorities', async () => {
    // Given a call-through observer of catalogue transformations.
    const map = vi.spyOn(Array.prototype, 'map');
    // When importing the module, without scoring a gallery.
    await import('../../src/components/plugins-home/curatedPriority');
    const rankings = map.mock.contexts.filter((value) => Array.isArray(value) && value[0] === plugin.id);
    // Then the global catalogue has not been indexed.
    expect(rankings).toHaveLength(0);
  });

  it('builds the global rank once when scoring the first plugin', async () => {
    // Given an imported module and an unscored plugin.
    const { curatedPluginPriority } = await import('../../src/components/plugins-home/curatedPriority');
    const map = vi.spyOn(Array.prototype, 'map');
    // When the first global rank is requested.
    const priority = curatedPluginPriority(plugin);
    const rankings = map.mock.contexts.filter((value) => Array.isArray(value) && value[0] === plugin.id);
    // Then its canonical rank is returned after one index construction.
    expect(priority).toBe(0);
    expect(rankings).toHaveLength(1);
  });

  it('reuses global ranks when scoring another plugin', async () => {
    // Given an initialized rank index.
    const { curatedPluginPriority } = await import('../../src/components/plugins-home/curatedPriority');
    curatedPluginPriority(plugin);
    const map = vi.spyOn(Array.prototype, 'map');
    // When scoring the second pinned plugin.
    const priority = curatedPluginPriority({ ...plugin, id: 'example-dreamcore-landing' });
    const rankings = map.mock.contexts.filter((value) => Array.isArray(value) && value[0] === plugin.id);
    // Then the existing index supplies the rank.
    expect(priority).toBe(1);
    expect(rankings).toHaveLength(0);
  });

  it.each([
    ['example-mythic-naturecore', 'prototype', 0],
    ['example-html-ppt-zhangzara-creative-mode', 'deck', 0],
    ['unlisted-plugin', 'prototype', null],
    ['example-mythic-naturecore', 'unknown-chip', null],
  ] as const)('resolves %s in %s without constructing the global index', async (id, chip, expected) => {
    // Given a chip-local lookup and an untouched global index.
    const { curatedPluginPriorityForChip } = await import('../../src/components/plugins-home/curatedPriority');
    const map = vi.spyOn(Array.prototype, 'map');
    // When asking for a chip-local rank.
    const priority = curatedPluginPriorityForChip({ ...plugin, id }, chip);
    const rankings = map.mock.contexts.filter((value) => Array.isArray(value) && value[0] === plugin.id);
    // Then chip ordering and unknown fallbacks are preserved without global work.
    expect(priority).toBe(expected);
    expect(rankings).toHaveLength(0);
  });

  it('returns null when the first global lookup is not curated', async () => {
    // Given a fresh global index and a non-curated plugin.
    const { curatedPluginPriority } = await import('../../src/components/plugins-home/curatedPriority');
    // When it is the first plugin scored.
    const priority = curatedPluginPriority({ ...plugin, id: 'unlisted-plugin' });
    // Then the existing unknown-rank contract is preserved.
    expect(priority).toBeNull();
  });
});
