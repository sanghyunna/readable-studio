import { useEffect, useMemo, useState } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ChatMessage } from '../types';
import type { RollbackMode } from '@readable-studio/contracts';
import {
  executeAgentRollback,
  fetchProjectCheckpointDiff,
  listProjectCheckpoints,
  rollbackConversation,
  RollbackConflictError,
  RollbackPlanChangedError,
  type ProjectCheckpointConflict,
  type ProjectCheckpointDiffResponse,
  type ProjectCheckpointFileDelta,
  type ProjectCheckpointSummary,
  type RollbackConflictPolicy,
  type RollbackResponse,
} from '../state/projects';
import { Icon } from './Icon';
import styles from './RollbackModal.module.css';

interface Props {
  projectId: string;
  conversationId: string;
  targetMessage: ChatMessage;
  onClose: () => void;
  onSuccess: (response: RollbackResponse) => Promise<void> | void;
  /** When true the modal shows the diff preview without allowing a rollback. */
  readOnly?: boolean;
  /** Pre-selected restore mode (used for agent-requested rollbacks). */
  initialMode?: RollbackMode;
  /** Pre-selected checkpoint id (used for agent-requested rollbacks). */
  initialCheckpointId?: string | null;
  /** Opaque daemon-issued handle for an agent-requested rollback. */
  agentRequestId?: string | null;
}

type DiffCounts = {
  added: number;
  modified: number;
  deleted: number;
  conflicts: number;
};

const EMPTY_COUNTS: DiffCounts = {
  added: 0,
  modified: 0,
  deleted: 0,
  conflicts: 0,
};

export function RollbackModal({
  projectId,
  conversationId,
  targetMessage,
  onClose,
  onSuccess,
  readOnly = false,
  initialMode,
  initialCheckpointId,
  agentRequestId = null,
}: Props) {
  const t = useT();
  const [checkpoints, setCheckpoints] = useState<ProjectCheckpointSummary[]>([]);
  const [checkpointsLoaded, setCheckpointsLoaded] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(initialCheckpointId ?? null);
  const [mode, setMode] = useState<RollbackMode>(initialMode ?? 'chat_only');
  const [modeTouched, setModeTouched] = useState(initialMode !== undefined);
  const [diff, setDiff] = useState<ProjectCheckpointDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffFailed, setDiffFailed] = useState(false);
  const [conflictPolicy, setConflictPolicy] = useState<RollbackConflictPolicy>('fail');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollbackConflicts, setRollbackConflicts] = useState<ProjectCheckpointConflict[]>([]);
  const isAgentRequest = Boolean(agentRequestId);
  const restoreMode: RollbackMode = isAgentRequest ? 'files_only' : mode;

  useEffect(() => {
    let cancelled = false;
    setCheckpointsLoaded(false);
    setError(null);
    void listProjectCheckpoints(projectId, conversationId).then((items) => {
      if (cancelled) return;
      setCheckpoints(items);
      setCheckpointsLoaded(true);
      const match = selectCheckpointForMessage(items, targetMessage.id);
      setSelectedCheckpointId(initialCheckpointId !== undefined ? initialCheckpointId : match?.id ?? null);
      if (!modeTouched && initialMode === undefined) {
        setMode(match ? 'files_and_chat' : 'chat_only');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, initialCheckpointId, initialMode, modeTouched, projectId, targetMessage.id]);

  useEffect(() => {
    if (!selectedCheckpointId) {
      setDiff(null);
      setDiffFailed(false);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffFailed(false);
    setRollbackConflicts([]);
    void fetchProjectCheckpointDiff(projectId, selectedCheckpointId)
      .then((next) => {
        if (cancelled) return;
        setDiff(next);
        setDiffFailed(next == null);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedCheckpointId]);

  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
      setModeTouched(true);
    }
  }, [initialMode]);

  useEffect(() => {
    if (initialCheckpointId !== undefined) {
      setSelectedCheckpointId(initialCheckpointId);
    }
  }, [initialCheckpointId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, submitting]);

  const selectedCheckpoint = useMemo(
    () => checkpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId) ?? null,
    [checkpoints, selectedCheckpointId],
  );
  const hasFileCheckpoint = Boolean(selectedCheckpoint);
  const counts = useMemo(() => diffCounts(diff), [diff]);
  const diffChanges = useMemo(() => diffChangeList(diff), [diff]);
  const diffConflictPaths = useMemo(
    () => new Set((diff?.conflicts ?? []).map((conflict) => conflict.path)),
    [diff],
  );
  const conflicts = rollbackConflicts.length > 0
    ? rollbackConflicts
    : diff?.conflicts ?? [];
  const conflictCount = Math.max(counts.conflicts, conflicts.length);
  const fileModeUnavailable = !hasFileCheckpoint && restoreMode !== 'chat_only';
  // Genuine file conflicts only matter for a restore that writes files.
  const hasFileConflicts = conflictCount > 0 && restoreMode !== 'chat_only';
  const agentConflictChoiceRequired =
    isAgentRequest && hasFileConflicts && conflictPolicy === 'fail';
  // Manual rollback keeps its existing overwrite default. An agent request
  // stays blocked until the user explicitly chooses how to resolve conflicts.
  const confirmDisabled =
    submitting ||
    !checkpointsLoaded ||
    fileModeUnavailable ||
    diffLoading ||
    agentConflictChoiceRequired;

  useEffect(() => {
    // Keep the existing manual rollback default; agent requests require an
    // explicit user choice above.
    if (!isAgentRequest && hasFileConflicts && conflictPolicy === 'fail') {
      setConflictPolicy('overwrite');
    }
  }, [isAgentRequest, hasFileConflicts, conflictPolicy]);

  const targetTime = formatMessageTime(targetMessage);
  const targetAgent = targetMessage.agentName ?? targetMessage.agentId ?? t('assistant.role');

  async function handleSubmit() {
    if (confirmDisabled) return;
    setSubmitting(true);
    setError(null);
    setRollbackConflicts([]);
    try {
      let response: RollbackResponse;
      if (agentRequestId) {
        response = await executeAgentRollback(projectId, conversationId, {
          requestId: agentRequestId,
          conflictPolicy,
        });
      } else {
        response = await rollbackConversation(projectId, conversationId, {
          targetMessageId: targetMessage.id,
          ...(restoreMode === 'chat_only' || !selectedCheckpointId ? {} : { targetCheckpointId: selectedCheckpointId }),
          mode: restoreMode,
          conflictPolicy,
          createSafetyCheckpoint: true,
        });
      }
      await onSuccess(response);
      onClose();
    } catch (err) {
      if (err instanceof RollbackPlanChangedError) {
        setError(t('rollback.planChangedRetry'));
        if (selectedCheckpointId) {
          setDiffLoading(true);
          setDiffFailed(false);
          const next = await fetchProjectCheckpointDiff(projectId, selectedCheckpointId);
          setDiff(next);
          setDiffFailed(next == null);
          setDiffLoading(false);
        }
      } else if (err instanceof RollbackConflictError) {
        setError(err.message);
        setRollbackConflicts(err.conflicts);
      } else {
        setError(err instanceof Error ? err.message : t('rollback.failed'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`modal-backdrop ${styles.backdrop}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section
        className={`modal ${styles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rollback-modal-title"
      >
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 id="rollback-modal-title">{t('rollback.title')}</h2>
            <p>{t('rollback.subtitle')}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            disabled={submitting}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.target}>
            <span className={styles.label}>{t('rollback.targetLabel')}</span>
            <strong>{targetAgent}</strong>
            {targetTime ? <span>{targetTime}</span> : null}
          </div>

          {!isAgentRequest && !readOnly ? (
            <fieldset className={styles.section}>
              <legend>{t('rollback.modeLabel')}</legend>
              <div className={styles.segmented} role="group" aria-label={t('rollback.modeLabel')}>
                <ModeButton
                  active={mode === 'files_only'}
                  disabled={!hasFileCheckpoint}
                  label={t('rollback.mode.filesOnly')}
                  onClick={() => {
                    setModeTouched(true);
                    setMode('files_only');
                  }}
                />
                <ModeButton
                  active={mode === 'chat_only'}
                  label={t('rollback.mode.chatOnly')}
                  onClick={() => {
                    setModeTouched(true);
                    setMode('chat_only');
                  }}
                />
                <ModeButton
                  active={mode === 'files_and_chat'}
                  disabled={!hasFileCheckpoint}
                  label={t('rollback.mode.filesAndChat')}
                  onClick={() => {
                    setModeTouched(true);
                    setMode('files_and_chat');
                  }}
                />
              </div>
            </fieldset>
          ) : (
            <div className={styles.status}>
              <Icon name="info" size={14} />
              <span>
                {t('rollback.modeLabel')}: {restoreMode === 'files_only'
                  ? t('rollback.mode.filesOnly')
                  : restoreMode === 'chat_only'
                    ? t('rollback.mode.chatOnly')
                    : t('rollback.mode.filesAndChat')}
              </span>
            </div>
          )}

          {!checkpointsLoaded ? (
            <StatusLine icon="spinner" text={t('rollback.loading')} />
          ) : !hasFileCheckpoint ? (
            <StatusLine
              icon="info"
              text={t(isAgentRequest ? 'rollback.noCheckpointFilesOnly' : 'rollback.noCheckpointChatOnly')}
            />
          ) : diffLoading ? (
            <StatusLine icon="spinner" text={t('rollback.loading')} />
          ) : diffFailed ? (
            <StatusLine icon="alert-triangle" text={t('rollback.loadFailed')} tone="danger" />
          ) : (
            <>
              <div className={styles.summary} aria-label={t('rollback.diffSummary')}>
                <CountPill label={t('rollback.diffAdded')} value={counts.added} />
                <CountPill label={t('rollback.diffModified')} value={counts.modified} />
                <CountPill label={t('rollback.diffDeleted')} value={counts.deleted} />
                <CountPill label={t('rollback.diffConflicts')} value={conflictCount} tone={conflictCount > 0 ? 'danger' : 'neutral'} />
              </div>
              {diffChanges.length > 0 ? (
                <details className={styles.files}>
                  <summary>{t('rollback.fileListTitle')}</summary>
                  <ul>
                    {diffChanges.slice(0, 80).map((change) => (
                      <li key={`${change.path}:${change.status}`}>
                        <span>{diffConflictPaths.has(change.path) ? 'conflict' : change.status}</span>
                        <code>{change.path}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}

          <div className={styles.notice}>
            <Icon name="history" size={14} />
            <span>{t('rollback.safetyNotice')}</span>
          </div>

          {conflictCount > 0 ? (
            <div className={styles.conflicts}>
              <div className={styles.conflictHead}>
                <strong>{t('rollback.conflictsTitle')}</strong>
                <select
                  value={
                    isAgentRequest
                      ? conflictPolicy
                      : conflictPolicy === 'fail'
                        ? 'overwrite'
                        : conflictPolicy
                  }
                  onChange={(event) => setConflictPolicy(event.currentTarget.value as RollbackConflictPolicy)}
                  disabled={readOnly || submitting || restoreMode === 'chat_only'}
                  aria-label={t('rollback.conflictPolicyLabel')}
                >
                  {isAgentRequest ? (
                    <option value="fail" disabled>{t('rollback.conflictPolicyFail')}</option>
                  ) : null}
                  <option value="overwrite">{t('rollback.conflictPolicyOverwrite')}</option>
                  <option value="keep_current">{t('rollback.conflictPolicyKeepCurrent')}</option>
                </select>
              </div>
              {hasFileConflicts ? (
                <p className={styles.conflictWarning} role="alert">
                  {t('rollback.conflictDataLossWarning')}
                </p>
              ) : null}
              {conflicts.length > 0 ? (
                <ul>
                  {conflicts.slice(0, 24).map((conflict) => (
                    <li key={`${conflict.path}:${conflict.reason ?? ''}`}>
                      <code>{conflict.path}</code>
                      {conflict.reason ? <span>{conflict.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
        </div>

        {!readOnly ? (
          <footer className={styles.foot}>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void handleSubmit()} disabled={confirmDisabled}>
              {submitting ? t('rollback.restoring') : confirmLabel(restoreMode, t)}
            </Button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}

function ModeButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? styles.modeActive : styles.mode}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function CountPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <span className={tone === 'danger' ? styles.countDanger : styles.count}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function StatusLine({
  icon,
  text,
  tone = 'neutral',
}: {
  icon: 'spinner' | 'info' | 'alert-triangle';
  text: string;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className={tone === 'danger' ? styles.statusDanger : styles.status}>
      <Icon name={icon} size={14} />
      <span>{text}</span>
    </div>
  );
}

function selectCheckpointForMessage(
  checkpoints: ProjectCheckpointSummary[],
  messageId: string,
): ProjectCheckpointSummary | null {
  const matches = checkpoints
    .filter((checkpoint) => checkpointMessageId(checkpoint) === messageId)
    .sort((a, b) => checkpointRank(b) - checkpointRank(a) || checkpointTime(b) - checkpointTime(a));
  return matches[0] ?? null;
}

function checkpointMessageId(checkpoint: ProjectCheckpointSummary): string | null {
  return checkpoint.messageId ?? null;
}

function checkpointRank(checkpoint: ProjectCheckpointSummary): number {
  if (checkpoint.kind === 'after_message') return 3;
  if (checkpoint.kind === 'after_run_unfinalized') return 2;
  if (checkpoint.kind === 'before_run') return 1;
  return 0;
}

function checkpointTime(checkpoint: ProjectCheckpointSummary): number {
  if (typeof checkpoint.createdAt === 'number') return checkpoint.createdAt;
  if (typeof checkpoint.createdAt === 'string') {
    const parsed = Date.parse(checkpoint.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function diffCounts(diff: ProjectCheckpointDiffResponse | null): DiffCounts {
  if (!diff) return EMPTY_COUNTS;
  const changes = diffChangeList(diff);
  return {
    added: changes.filter((change) => change.status === 'added').length,
    modified: changes.filter((change) => change.status === 'modified').length,
    deleted: changes.filter((change) => change.status === 'deleted').length,
    conflicts: diff.conflicts.length,
  };
}

function diffChangeList(diff: ProjectCheckpointDiffResponse | null): ProjectCheckpointFileDelta[] {
  return Array.isArray(diff?.files) ? diff.files.filter((change) => change.path) : [];
}

function formatMessageTime(message: ChatMessage): string {
  const value = message.endedAt ?? message.startedAt;
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function confirmLabel(
  mode: RollbackMode,
  t: (key: 'rollback.confirmFiles' | 'rollback.confirmChat' | 'rollback.confirmCombined') => string,
): string {
  if (mode === 'files_only') return t('rollback.confirmFiles');
  if (mode === 'chat_only') return t('rollback.confirmChat');
  return t('rollback.confirmCombined');
}
