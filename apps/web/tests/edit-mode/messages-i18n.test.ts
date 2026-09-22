import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
import type { Dict } from '../../src/i18n/types';

const MESSAGE_KEYS = [
  'manualEdit.page',
  'manualEdit.pageStyles',
  'manualEdit.baseSize',
  'manualEdit.pageStylesUnavailable',
  'manualEdit.error.previewStyleFailed',
  'manualEdit.error.selectedTargetMissing',
  'manualEdit.error.stylesReconciled',
  'manualEdit.error.duplicatePreviewFailed',
  'manualEdit.error.finishBeforeDuplicateFailed',
  'manualEdit.error.saveBeforeDuplicateFailed',
  'manualEdit.error.duplicatePreviewUnavailable',
  'manualEdit.error.duplicatePreviewChanged',
  'manualEdit.error.fileChangedBeforeSave',
  'manualEdit.error.saveFailed',
  'manualEdit.error.saveFailedWithStatus',
  'manualEdit.error.savedPreviewRefreshFailed',
  'manualEdit.error.applyFailed',
  'manualEdit.error.fileChangedBeforeUndo',
  'manualEdit.error.fileChangedBeforeRedo',
  'manualEdit.error.invalidStyleValue',
] as const satisfies ReadonlyArray<keyof Dict>;

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('manual edit message localisation', () => {
  it('provides Korean catalogue copy for every edit-mode message', () => {
    expect(MESSAGE_KEYS).toHaveLength(20);
    for (const key of MESSAGE_KEYS) {
      expect(en[key], `en.${key}`).not.toBe(key);
      expect(ko[key], `ko.${key}`).not.toBe(en[key]);
      expect(ko[key], `ko.${key}`).toMatch(/[가-힣]/);
    }
  });

  it('does not send English literals or raw bridge diagnostics to user-facing error sinks', () => {
    const fileViewer = source('../../src/components/FileViewer.tsx');
    const controls = [
      source('../../src/components/ManualEditPanel.tsx'),
      source('../../src/components/ManualEditPageSection.tsx'),
    ].join('\n');

    expect(fileViewer).not.toMatch(/setManualEditError\(\s*['"`]\s*[A-Z]/);
    expect(fileViewer).not.toMatch(/failManualEditDuplicate\([^;]*['"`]\s*[A-Z]/);
    expect(fileViewer).not.toMatch(/setManualEditError\(\s*(?:data|result|planned)\.error/);
    expect(controls).not.toMatch(/onError\(\s*['"`]\s*[A-Z]/);
  });
});
