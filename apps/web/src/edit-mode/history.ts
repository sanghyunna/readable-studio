import type { ManualEditHistoryEntry } from './types';

// Keep 100 ordinary actions undoable, while limiting large-document sessions to
// 128 MiB of UTF-16 source payload (about 30 revisions of a 2 MiB document).
// Exact snapshots preserve serialization and whole-source conflict checks;
// replaying inverse DOM patches would not restore the original source bytes.
export const MANUAL_EDIT_HISTORY_MAX_DEPTH = 100;
export const MANUAL_EDIT_HISTORY_MAX_BYTES = 128 * 1024 * 1024;

export function appendManualEditHistory(
  history: readonly ManualEditHistoryEntry[],
  entry: ManualEditHistoryEntry,
): ManualEditHistoryEntry[] {
  const retained: ManualEditHistoryEntry[] = [];
  // Each commit's beforeSource is the preceding commit's afterSource. Count
  // that shared snapshot once, without hashing/scanning multi-megabyte strings.
  let bytes = entry.afterSource.length * 2;
  for (const revision of [entry, ...history]) {
    if (retained.length === MANUAL_EDIT_HISTORY_MAX_DEPTH) break;
    bytes += revision.beforeSource.length * 2;
    if (bytes > MANUAL_EDIT_HISTORY_MAX_BYTES) break;
    retained.push(revision);
  }
  return retained;
}
