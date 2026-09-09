// Hub drop-to-edit zone: the entry point for editing an EXISTING document.
//
// Sits below the composer as a sibling, never an ancestor, so the composer's
// own attachment drop keeps its files. The zone itself is a native button:
// pointer users drop a file on it, keyboard and screen-reader users activate
// it to open the file picker, and both paths feed the SAME handler. Every
// refusal (wrong format, several files, failed import) is spoken through the
// shared Toast so nothing fails silently.

import { useCallback, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { Toast } from '../Toast';
import {
  HUB_DROP_ACCEPT,
  classifyHubDrop,
  type HubImportFileOutcome,
} from './drop-to-edit';
import styles from './HubDropToEdit.module.css';

interface Props {
  /** Drive the existing single-document import path with the accepted file. */
  onImportFile: (file: File) => Promise<HubImportFileOutcome> | HubImportFileOutcome;
}

type ZoneState = 'idle' | 'drag-over' | 'busy';

interface Notice {
  message: string;
  details: string | null;
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

export function HubDropToEdit({ onImportFile }: Props) {
  const t = useT();
  const labelId = useId();
  const detailId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // State is async, so the ref is what actually blocks a second drop that
  // lands inside the same tick as the first.
  const busyRef = useRef(false);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (busyRef.current) return;
      const decision = classifyHubDrop(files);
      if (decision.kind === 'empty') return;
      if (decision.kind === 'multiple') {
        setNotice({ message: t('hub.dropOneAtATime', { count: decision.count }), details: null });
        return;
      }
      if (decision.kind === 'unsupported') {
        setNotice({ message: t('hub.dropUnsupported', { name: decision.name }), details: null });
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      try {
        const outcome = await onImportFile(decision.file);
        if (outcome.ok === false) {
          setNotice({ message: t('hub.dropImportFailed'), details: outcome.message ?? null });
        }
      } catch (err) {
        setNotice({
          message: t('hub.dropImportFailed'),
          details: err instanceof Error ? err.message : null,
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onImportFile, t],
  );

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragOver(false);
    void handleFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset before any await so picking the same file again still fires.
    event.target.value = '';
    void handleFiles(files);
  };

  const state: ZoneState = busy ? 'busy' : dragOver ? 'drag-over' : 'idle';
  const label =
    state === 'busy'
      ? t('hub.dropToEditBusy')
      : state === 'drag-over'
        ? t('hub.dropToEditRelease')
        : t('hub.dropToEditLabel');

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.zone}
        data-testid="hub-drop-to-edit"
        data-state={state}
        aria-labelledby={labelId}
        aria-describedby={detailId}
        aria-busy={busy ? 'true' : undefined}
        onClick={() => {
          if (busyRef.current) return;
          inputRef.current?.click();
        }}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDragOver(false);
        }}
        onDrop={handleDrop}
      >
        <span className={styles.icon} aria-hidden="true">
          <Icon name={state === 'busy' ? 'spinner' : 'import'} size={18} />
        </span>
        <span className={styles.label} id={labelId} data-testid="hub-drop-to-edit-label">
          {label}
        </span>
        <span className={styles.detail} id={detailId}>
          {t('hub.dropToEditDetail')}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={HUB_DROP_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="hub-drop-to-edit-input"
        onChange={handlePick}
      />
      {notice ? (
        <Toast
          message={notice.message}
          details={notice.details}
          role="alert"
          tone="error"
          onDismiss={() => setNotice(null)}
        />
      ) : null}
    </div>
  );
}
