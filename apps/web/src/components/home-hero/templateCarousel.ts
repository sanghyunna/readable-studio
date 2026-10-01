// Hub template carousel: the horizontal template rail that sits under the
// Hub composer (the slot the drop-to-edit zone used to occupy).
//
// Two concerns live here so HomeHero stays declarative:
//
//  - Which templates the rail shows when NO creation type is active: one
//    bounded, round-robin mix across the creation chips (prototype, deck,
//    ...) so the first viewport reads as variety rather than 18 landing
//    pages. With a chip active the hero passes that chip's own filtered
//    presets instead, so the rail never disagrees with the type the user
//    picked.
//  - The collapsed preference. Users who never want template suggestions
//    collapse the rail once; the choice is persisted in localStorage next to
//    the first-run guide stage, so it survives restarts. Visible by default
//    - the user opts out, never in.
//  - Which preview a card paints. The rail exists so templates appear
//    VISUALLY, so a thumbnail must never depend on a remote host: the daemon
//    attaches a baked poster/clip whose URL falls back to a CDN when the bake
//    files are not on disk, and offline / locked-down machines turn that into
//    a rail of letter glyphs. `hubTemplateCardPreview` keeps the baked media
//    only when it is served by our own daemon and otherwise renders the
//    bundled example page itself (`/api/plugins/<id>/preview`, sandboxed and
//    scaled down), leaving the glyph as the rare last resort.

import type { InstalledPluginRecord } from '@readable-studio/contracts';

import { inferPluginPreview, type PluginPreviewSpec } from '../plugins-home/preview';

export interface HubTemplateCarouselItem {
  record: InstalledPluginRecord;
  // The creation chip the preset is filed under; the pick handler binds the
  // plugin AND stamps this chip, exactly as a chip-scoped preset pick does.
  chipId: string;
}

// Hard cap on rail cards. PreviewSurface already lazy-mounts each thumbnail
// through IntersectionObserver, so the cap bounds DOM + manifest work, not
// iframe count (that is bounded by the viewport).
export const HUB_TEMPLATE_CAROUSEL_LIMIT = 24;

export function mixHubTemplateCarouselItems(
  perChip: ReadonlyArray<{ chipId: string; plugins: InstalledPluginRecord[] }>,
  limit = HUB_TEMPLATE_CAROUSEL_LIMIT,
): HubTemplateCarouselItem[] {
  const items: HubTemplateCarouselItem[] = [];
  const seen = new Set<string>();
  const longest = perChip.reduce((max, entry) => Math.max(max, entry.plugins.length), 0);
  for (let index = 0; index < longest && items.length < limit; index += 1) {
    for (const entry of perChip) {
      const record = entry.plugins[index];
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      items.push({ record, chipId: entry.chipId });
      if (items.length >= limit) break;
    }
  }
  return items;
}

// Same-origin daemon path ("/api/..."), as opposed to an absolute or
// protocol-relative URL on another host.
function isDaemonServedUrl(url: string | null): boolean {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

export function hubTemplateCardPreview(record: InstalledPluginRecord): PluginPreviewSpec {
  const baked = inferPluginPreview(record, { preferBaked: true });
  if (baked.kind !== 'media') return baked;
  if (isDaemonServedUrl(baked.poster) && (baked.videoUrl === null || isDaemonServedUrl(baked.videoUrl))) {
    return baked;
  }
  // Remote poster: drop the bake and read the manifest's own `readable.preview`
  // (the example page for bundled templates). A manifest-declared remote
  // poster is still rejected the same way so the rail stays network-free.
  const local = inferPluginPreview(record);
  if (local.kind === 'media' && !isDaemonServedUrl(local.poster)) {
    return { kind: 'text' };
  }
  return local;
}

const STORAGE_KEY = 'readable-studio:hub-template-carousel';

export function readTemplateCarouselCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeTemplateCarouselCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (collapsed) window.localStorage.setItem(STORAGE_KEY, 'collapsed');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode storage failures just lose the preference for this run.
  }
}
