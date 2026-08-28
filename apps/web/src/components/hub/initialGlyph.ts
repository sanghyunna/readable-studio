// The single glyph a row shows once the rail collapses.
//
// Iterating the string rather than indexing it is deliberate: `charAt(0)` on an
// emoji or any other astral-plane name returns half a surrogate pair, which
// renders as a replacement character in the rail.

export function initialGlyph(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0] ?? '?';
}
