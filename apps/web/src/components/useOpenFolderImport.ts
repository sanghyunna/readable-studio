import { useCallback, useState } from 'react';
import {
  isReadableStudioHostAvailable,
  pickAndImportHostProject,
  type ReadableStudioHostProjectImportSuccess,
} from '@readable-studio/host';
import { pickLocalFolderPath } from '../state/projects';
import { useI18n } from '../i18n';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';

interface UseOpenFolderImportArgs {
  skillId?: string | null;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: ReadableStudioHostProjectImportSuccess) => Promise<void> | void;
}

export function useOpenFolderImport({
  skillId,
  onImportFolder,
  onImportFolderResponse,
}: UseOpenFolderImportArgs) {
  const { t } = useI18n();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const hasHostPickAndImport = isReadableStudioHostAvailable();
  const available = hasHostPickAndImport ? Boolean(onImportFolderResponse) : Boolean(onImportFolder);

  const openFolder = useCallback(async () => {
    if (hasHostPickAndImport) {
      if (!onImportFolderResponse) return;
      setError(null);
      setImporting(true);
      try {
        const result = await pickAndImportHostProject({
          skillId: skillId ?? null,
        });
        if (!result) return;
        if (result.ok === true) {
          await onImportFolderResponse(result);
          return;
        }
        if ('canceled' in result && result.canceled === true) return;
        const failure = formatPickAndImportFailure(result);
        setError({
          message: t('hubImport.folderFailed'),
          details: [failure.message, failure.details].filter(Boolean).join('\n'),
        });
      } catch (err) {
        setError({
          message: t('hubImport.folderFailed'),
          details: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setImporting(false);
      }
      return;
    }

    if (!onImportFolder) return;
    setError(null);
    setImporting(true);
    try {
      const selectedPath = await pickLocalFolderPath();
      if (!selectedPath) return;
      await onImportFolder(selectedPath);
    } catch (err) {
      setError({
        message: t('hubImport.folderFailed'),
        details: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setImporting(false);
    }
  }, [hasHostPickAndImport, onImportFolder, onImportFolderResponse, skillId, t]);

  return {
    available,
    clearError: () => setError(null),
    error,
    importing,
    openFolder,
  };
}
