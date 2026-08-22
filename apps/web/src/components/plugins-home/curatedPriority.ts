// Shared curator ordering for Home examples and the Community shelf.
//
// These are the template styles we deliberately want in the first
// viewport. The ids are daemon plugin ids, so the ordering remains
// stable across locales and title-copy tweaks.

import type { InstalledPluginRecord } from '@readable-studio/contracts';

// Pinned-to-front template set (curator request): these premium
// prototype templates lead both the Home hero prototype chip and the
// Home plugin grid, ahead of the standing curated picks below. Order
// here is the exact display order requested.
const PINNED_TEMPLATE_PLUGIN_IDS = [
  'example-mythic-naturecore',
  'example-dreamcore-landing',
  'example-skyelite-private-jets',
  'example-layered-depth',
  'example-luxury-botanical',
  'example-aerocore',
  'example-liquid-glass-agency',
  'example-portfolio-cosmic',
  'example-innovation',
  'example-orbis-nft',
  'example-mindloop-landing',
  'example-cinematic-landing-page',
  'example-ai-designer-portfolio',
  'example-codenest-coding-platform',
  'example-nimbus-grid',
  'example-acreage-farming',
  'example-evergreen-finance',
  'example-stellar-launch',
] as const;

const CURATED_PROTOTYPE_PLUGIN_IDS = [
  ...PINNED_TEMPLATE_PLUGIN_IDS,
  'example-readable-landing',
  'example-kanban-board',
  'example-social-carousel',
  'example-blog-post',
  'example-doc-kami-parchment',
] as const;

const CURATED_DECK_PLUGIN_IDS = [
  'example-html-ppt-zhangzara-creative-mode',
  'example-html-ppt-zhangzara-scatterbrain',
  'example-guizang-ppt',
  'example-html-ppt-zhangzara-cobalt-grid',
  'example-html-ppt-zhangzara-capsule',
] as const;

export const CURATED_PLUGIN_IDS_BY_CHIP = {
  prototype: CURATED_PROTOTYPE_PLUGIN_IDS,
  deck: CURATED_DECK_PLUGIN_IDS,
};

const CURATED_GLOBAL_IDS = [
  ...CURATED_PROTOTYPE_PLUGIN_IDS,
  ...CURATED_DECK_PLUGIN_IDS,
];

const CURATED_GLOBAL_RANK = new Map<string, number>(
  CURATED_GLOBAL_IDS.map((id, index) => [id, index]),
);

export function curatedPluginPriority(record: InstalledPluginRecord): number | null {
  return CURATED_GLOBAL_RANK.get(record.id) ?? null;
}

export function curatedPluginPriorityForChip(
  record: InstalledPluginRecord,
  chipId: string,
): number | null {
  const ids = (CURATED_PLUGIN_IDS_BY_CHIP as Record<string, readonly string[] | undefined>)[chipId];
  if (!ids) return null;
  const index = ids.indexOf(record.id);
  return index >= 0 ? index : null;
}
