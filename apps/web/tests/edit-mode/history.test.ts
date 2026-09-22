import { describe, expect, it } from 'vitest';
import { appendManualEditHistory, MANUAL_EDIT_HISTORY_MAX_BYTES, MANUAL_EDIT_HISTORY_MAX_DEPTH } from '../../src/edit-mode/history';
import type { ManualEditHistoryEntry } from '../../src/edit-mode/types';

function entry(beforeSource: string, afterSource: string): ManualEditHistoryEntry {
  return { id: afterSource, label: 'Edit', beforeSource, afterSource, createdAt: 0 };
}

describe('bounded manual edit history', () => {
  it('evicts the oldest revision when depth is exceeded and undoes to the bound', () => {
    // Given a document with more edits than the supported undo depth.
    let history: ManualEditHistoryEntry[] = [];
    for (let i = 1; i <= MANUAL_EDIT_HISTORY_MAX_DEPTH + 20; i++) {
      history = appendManualEditHistory(history, entry(String(i - 1), String(i)));
    }
    // When traversing the retained undo revisions.
    let source = String(MANUAL_EDIT_HISTORY_MAX_DEPTH + 20);
    for (const revision of history) {
      expect(revision.afterSource).toBe(source);
      source = revision.beforeSource;
    }
    // Then the newest edits, not the oldest, are undoable.
    expect(history).toHaveLength(MANUAL_EDIT_HISTORY_MAX_DEPTH);
    expect(source).toBe('20');
  });

  it('stops retaining source bytes when the memory budget is exceeded', () => {
    // Given large, distinct source revisions (UTF-16 byte accounting).
    const document = 'x'.repeat(1024 * 1024);
    let history: ManualEditHistoryEntry[] = [];
    for (let i = 1; i <= 90; i++) {
      history = appendManualEditHistory(history, entry(document + (i - 1), document + i));
    }
    // When accounting for every unique retained source.
    const sources = new Set(history.flatMap((revision) => [revision.beforeSource, revision.afterSource]));
    const bytes = [...sources].reduce((sum, source) => sum + source.length * 2, 0);
    // Then memory is bounded, with the newest source preserved.
    expect(bytes).toBeLessThanOrEqual(MANUAL_EDIT_HISTORY_MAX_BYTES);
    expect(history[0]?.afterSource).toBe(document + 90);
    expect(history.length).toBeGreaterThan(20);
  });

  it('round-trips exact source bytes through undo and redo within the bound', () => {
    // Given source containing formatting, entities and Unicode.
    const sources = ['<!DOCTYPE html>\r\n<p title="&amp;">한글 😀</p>', '<p>second\r\n</p>', '<p>third &amp;</p>'];
    const history = appendManualEditHistory(appendManualEditHistory([], entry(sources[0] ?? '', sources[1] ?? '')), entry(sources[1] ?? '', sources[2] ?? ''));
    // When undoing all revisions then redoing them.
    let source = sources[2];
    for (const revision of history) source = revision.beforeSource;
    expect(source).toBe(sources[0]);
    for (const revision of [...history].reverse()) source = revision.afterSource;
    // Then the final bytes are unchanged.
    expect(source).toBe(sources[2]);
  });

  it('drops an oversized undo entry without retaining older unreachable history', () => {
    // Given a revision larger than the complete history budget.
    const history = [entry('a', 'b')];
    const next = entry('b', 'x'.repeat(MANUAL_EDIT_HISTORY_MAX_BYTES / 2 + 1));
    // When committing it.
    const retained = appendManualEditHistory(history, next);
    // Then history cannot retain an unreachable older revision or the oversized one.
    expect(retained).toEqual([]);
    expect(next.afterSource.length).toBeGreaterThan(MANUAL_EDIT_HISTORY_MAX_BYTES / 2);
  });
});
