// Joins design-system palettes onto the composer's @-mention plugin rows.
//
// Design-system plugins (`plugins/_official/design-systems/<id>`) surface in the
// Hub composer's 컨텍스트 picker as ordinary plugin entries, so the list reads as
// bare brand names — "Airtable", "Anthropic" — with no hint of what each style
// actually looks like. The real palette already ships on
// `DesignSystemSummary.swatches` (the daemon derives it from each system's
// tokens.css / DESIGN.md), so the picker only needs the join key.
//
// The key is the plugin manifest's `readable.context.designSystem.ref`. The
// `design-system-<id>` id convention is a fallback for records whose manifest
// omits the ref — the two agree for every bundled system today, but the id
// prefix alone would silently mis-key a renamed plugin.
//
// These are CONTENT colors: each fill is the design system's own identity,
// exactly like the palette swatches already rendered in Settings › Library and
// the mid-chat switch picker. Everything around them stays on product tokens.

import type { DesignSystemSummary, InstalledPluginRecord } from '@readable-studio/contracts';

/** Swatches shown per row. Four reads as a palette; more turns into noise at 12px. */
export const MENTION_SWATCH_LIMIT = 4;

const DESIGN_SYSTEM_PLUGIN_PREFIX = 'design-system-';

/**
 * The design-system id a plugin record renders the palette for, or `null` when
 * the plugin is not a design-system plugin.
 */
export function designSystemRefForPlugin(record: InstalledPluginRecord): string | null {
  const readable = record.manifest?.readable as
    | { context?: { designSystem?: { ref?: unknown } } }
    | undefined;
  const ref = readable?.context?.designSystem?.ref;
  if (typeof ref === 'string' && ref.length > 0) return ref;
  if (record.id.startsWith(DESIGN_SYSTEM_PLUGIN_PREFIX)) {
    const derived = record.id.slice(DESIGN_SYSTEM_PLUGIN_PREFIX.length);
    return derived.length > 0 ? derived : null;
  }
  return null;
}

/**
 * A design system contributes swatches only when its palette has at least two
 * distinct entries: a single repeated fill reads as a broken box rather than an
 * identity, so those rows fall back to the name-only layout.
 */
function usableSwatches(swatches: readonly string[] | undefined): string[] | null {
  if (!swatches) return null;
  const cleaned: string[] = [];
  for (const raw of swatches) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length === 0) continue;
    if (cleaned.includes(value)) continue;
    cleaned.push(value);
    if (cleaned.length === MENTION_SWATCH_LIMIT) break;
  }
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * `designSystemId -> palette` for every system that ships a usable palette.
 * Systems with a missing or degenerate palette are absent, so callers render
 * the name-only row instead of an empty cluster.
 */
export function buildDesignSystemPalettes(
  designSystems: readonly DesignSystemSummary[],
): ReadonlyMap<string, readonly string[]> {
  const palettes = new Map<string, readonly string[]>();
  for (const system of designSystems) {
    const swatches = usableSwatches(system.swatches);
    if (swatches) palettes.set(system.id, swatches);
  }
  return palettes;
}

/** The palette to render beside a plugin row, or `null` for the name-only row. */
export function pluginSwatches(
  record: InstalledPluginRecord,
  palettes: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  const ref = designSystemRefForPlugin(record);
  if (ref === null) return null;
  return palettes.get(ref) ?? null;
}
