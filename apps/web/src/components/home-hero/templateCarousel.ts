// Hub template carousel: the horizontal template rail that sits under the
// Hub composer (the slot the drop-to-edit zone used to occupy).
//
// Two concerns live here so HomeHero stays declarative:
//
//  - Which creation types the rail's vertical tab column offers when NO
//    creation chip is active (deck / report / website), plus the persisted
//    selected tab. Each tab shows that type's full curated set. With a chip
//    active the hero passes that chip's own filtered presets instead, so
//    the rail never disagrees with the type the user picked.
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

// The creation types the rail's vertical tab column offers, in column order.
// Each tab shows that type's FULL curated set (no rail cap) so the user can
// scan every deck / report / website template without leaving the Hub.
export const HUB_TEMPLATE_TAB_IDS = ['deck', 'report', 'prototype'] as const;
export type HubTemplateTabId = (typeof HUB_TEMPLATE_TAB_IDS)[number];
export const DEFAULT_HUB_TEMPLATE_TAB: HubTemplateTabId = 'deck';

export function isHubTemplateTabId(value: unknown): value is HubTemplateTabId {
  return typeof value === 'string' && (HUB_TEMPLATE_TAB_IDS as readonly string[]).includes(value);
}

// Persisted next to the collapse preference so both survive a restart.
const TAB_STORAGE_KEY = 'readable-studio:hub-template-carousel-tab';

export function readTemplateCarouselTab(): HubTemplateTabId {
  if (typeof window === 'undefined') return DEFAULT_HUB_TEMPLATE_TAB;
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    return isHubTemplateTabId(stored) ? stored : DEFAULT_HUB_TEMPLATE_TAB;
  } catch {
    return DEFAULT_HUB_TEMPLATE_TAB;
  }
}

export function writeTemplateCarouselTab(tab: HubTemplateTabId): void {
  if (typeof window === 'undefined') return;
  try {
    if (tab === DEFAULT_HUB_TEMPLATE_TAB) window.localStorage.removeItem(TAB_STORAGE_KEY);
    else window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Private-mode storage failures just lose the preference for this run.
  }
}

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
