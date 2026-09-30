// Claude Design ZIP picker controller for the Hub composer's "+" menu.
//
// Three behaviours live here so they cannot drift apart: reset the input so
// re-picking the same file still fires `change`, refuse a second import while
// one is in flight, and surface the failure whether the callback RETURNS
// `{ok:false}` or THROWS.

import { useCallback, useRef, useState, type ChangeEvent } from 'react';

import type { ImportClaudeDesignOutcome } from './project-create';

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
          setError({
            message: result.message ? `Import failed: ${result.message}` : 'Import failed',
            ...(result.details === undefined ? {} : { details: result.details }),
          });
        }
      } catch (err) {
        setError({
          message: err instanceof Error ? `Import failed: ${err.message}` : 'Import failed',
        });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [onImportClaudeDesign],
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
