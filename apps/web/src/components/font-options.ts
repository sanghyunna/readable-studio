import type { SystemFontFamily } from '@readable-studio/contracts';

export interface FontOption {
  value: string;
  label: string;
}

/**
 * Value written to `font-family` for a family name. Always double-quoted: a
 * quoted string is a valid `font-family` value for ANY name, whereas an
 * unquoted custom-ident is invalid for names CSS can't tokenize as an
 * identifier — e.g. digit-leading (`3D Font`) or a reserved keyword — which
 * the browser would silently drop. `Segoe UI` -> `"Segoe UI"`. Internal
 * quotes/backslashes are escaped so the string always closes cleanly.
 */
export function quoteFontFamily(name: string): string {
  return `"${name.replace(/[\\"]/g, '\\$&')}"`;
}

// Lowercased primary family of a font-family value: first comma-part,
// unquoted. `'"Times New Roman", Times, serif'` -> `times new roman`.
function primaryFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/**
 * System font `<option>` entries to render after the curated list,
 * excluding any family whose name (case-insensitive) already appears in
 * the curated options — by label or by primary family — so "Arial",
 * "Georgia" etc. are not listed twice.
 */
export function systemFontOptions(
  families: SystemFontFamily[],
  curated: ReadonlyArray<FontOption>,
): FontOption[] {
  const seen = new Set<string>();
  for (const option of curated) {
    seen.add(option.label.trim().toLowerCase());
    if (option.value) seen.add(primaryFamily(option.value));
  }
  return families
    .filter((family) => !seen.has(family.family.trim().toLowerCase()))
    .map((family) => ({ value: quoteFontFamily(family.family), label: family.family }));
}
