// Claude Design ZIP picker controller for the Hub composer's "+" menu.
//
// Three behaviours live here so they cannot drift apart: reset the input so
// re-picking the same file still fires `change`, refuse a second import while
// one is in flight, and surface the failure whether the callback RETURNS
// `{ok:false}` or THROWS.

import { useCallback, useRef, useState, type ChangeEvent } from 'react';

import type { ImportClaudeDesignOutcome } from './project-create';
import { useT } from '../i18n';

export interface ClaudeZipImportError {
  message: string;
  details?: string;
}

interface UseClaudeZipImportArgs {
  onImportClaudeDesign?: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
}

export function useClaudeZipImport({ onImportClaudeDesign }: UseClaudeZipImportArgs) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<ClaudeZipImportError | null>(null);
  // State is async, so the ref is what actually blocks a second pick inside
  // the same tick.
  const importingRef = useRef(false);

  const available = Boolean(onImportClaudeDesign);

  const pickFile = useCallback(() => {
    if (importingRef.current) return;
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset before any await so picking the same file again still fires.
      event.target.value = '';
      if (!file || !onImportClaudeDesign) return;
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      setError(null);
      try {
        const result = await onImportClaudeDesign(file);
        if (result?.ok === false) {
          const details = [result.message, result.details].filter(Boolean).join('\n');
          setError({
            message: t(/invalid zip|not a (?:valid )?zip|missing central directory/i.test(details)
              ? 'hubImport.claudeZipInvalid' : 'hubImport.claudeZipFailed'),
            ...(details ? { details } : {}),
          });
        }
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        setError({
          message: t(/invalid zip|not a (?:valid )?zip|missing central directory/i.test(details)
            ? 'hubImport.claudeZipInvalid' : 'hubImport.claudeZipFailed'),
          details,
        });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [onImportClaudeDesign, t],
  );

  return {
    available,
    clearError: useCallback(() => setError(null), []),
    error,
    handleChange,
    importing,
    inputRef,
    pickFile,
  };
}
