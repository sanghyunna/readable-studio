// Settings > Databricks models. Lists every registered endpoint grouped by
// workspace, removes a single registration after an inline confirm, and
// disconnects a whole workspace profile the same way. Registration itself
// stays in the composer's Add Models flow; this surface only manages what is
// already registered. Every mutation republishes the catalogue through
// `notifyDatabricksModelsChanged` so the model picker updates without a
// restart, and every failure is shown next to the row that caused it.
import { useCallback, useEffect, useState } from 'react';
import type {
  DatabricksProfile,
  DatabricksRegisteredEndpoint,
} from '@readable-studio/contracts';
import { Button } from '@readable-studio/components';
import { useI18n } from '../i18n';
import {
  disableDatabricksModel,
  disconnectDatabricksConnection,
  fetchDatabricksModels,
  fetchDatabricksStatus,
} from '../providers/databricks';
import { notifyDatabricksModelsChanged, registeredEndpointToModelOption } from './databricksModels';
import { Icon } from './Icon';
import styles from './DatabricksModelsSection.module.css';

type PendingAction =
  | { kind: 'model'; id: string }
  | { kind: 'workspace'; id: string }
  | null;

interface WorkspaceGroup {
  profileId: string;
  label: string;
  models: DatabricksRegisteredEndpoint[];
}

function workspaceLabel(profileId: string, profiles: DatabricksProfile[]): string {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile?.workspaceDisplayLabel ?? profile?.displayName ?? profile?.label ?? profileId;
}

function groupByWorkspace(
  models: DatabricksRegisteredEndpoint[],
  profiles: DatabricksProfile[],
): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const model of models) {
    let group = groups.get(model.profileId);
    if (!group) {
      group = { profileId: model.profileId, label: workspaceLabel(model.profileId, profiles), models: [] };
      groups.set(model.profileId, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
}

function modelTitle(model: DatabricksRegisteredEndpoint): string {
  return model.servedModelName ?? model.displayName ?? model.label;
}

function formatTokens(value: number | null): string | null {
  if (value == null) return null;
  return new Intl.NumberFormat().format(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function DatabricksModelsSection() {
  const { t } = useI18n();
  const [models, setModels] = useState<DatabricksRegisteredEndpoint[]>([]);
  const [profiles, setProfiles] = useState<DatabricksProfile[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [modelsResponse, status] = await Promise.all([
        fetchDatabricksModels(),
        fetchDatabricksStatus(),
      ]);
      setModels(modelsResponse.models);
      setRevision(modelsResponse.revision);
      setProfiles(status.profiles);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = (next: DatabricksRegisteredEndpoint[]) => {
    setModels(next);
    notifyDatabricksModelsChanged(next.map(registeredEndpointToModelOption));
  };

  async function removeModel(endpointId: string) {
    setBusyId(endpointId);
    setRowError(null);
    try {
      const response = await disableDatabricksModel(endpointId, { expectedRevision: revision });
      setRevision(response.revision);
      publish(response.models);
      setPending(null);
    } catch (error) {
      setRowError({ id: endpointId, message: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function disconnectWorkspace(profileId: string) {
    setBusyId(profileId);
    setRowError(null);
    try {
      const status = await disconnectDatabricksConnection(profileId);
      setProfiles(status.profiles);
      const remaining = await fetchDatabricksModels();
      setRevision(remaining.revision);
      publish(remaining.models);
      setPending(null);
    } catch (error) {
      setRowError({ id: profileId, message: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  const groups = groupByWorkspace(models, profiles);

  return (
    <section className="settings-section settings-section-card" data-testid="databricks-models-section">
      <div className="section-head">
        <div>
          <h3>{t('settings.databricksModels')}</h3>
          <p className="hint">{t('settings.databricksModelsDescription')}</p>
        </div>
      </div>

      {loadError ? (
        <p className="settings-rescan-status error" role="alert">
          {loadError}
        </p>
      ) : null}

      {!loading && !loadError && groups.length === 0 ? (
        <div className={styles.empty} data-testid="databricks-models-empty">
          <Icon name="sparkles" size={16} />
          <div>
            <strong>{t('settings.databricksModelsEmptyTitle')}</strong>
            <p className="hint">{t('settings.databricksModelsEmptyHint')}</p>
          </div>
        </div>
      ) : null}

      {groups.map((group) => {
        const workspacePending = pending?.kind === 'workspace' && pending.id === group.profileId;
        const workspaceBusy = busyId === group.profileId;
        return (
          <div key={group.profileId} className={styles.group} data-testid="databricks-workspace-group">
            <div className={styles.groupHead}>
              <div className={styles.groupTitle}>
                <strong>{group.label}</strong>
                <small>{t('settings.databricksModelsCount', { count: group.models.length })}</small>
              </div>
              {workspacePending ? (
                <span className={styles.confirm} role="group" aria-label={t('settings.databricksDisconnect')}>
                  <Button
                    className={styles.danger}
                    disabled={workspaceBusy}
                    onClick={() => void disconnectWorkspace(group.profileId)}
                    data-testid="databricks-disconnect-confirm"
                  >
                    {t('settings.databricksDisconnectConfirm')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={workspaceBusy}
                    onClick={() => setPending(null)}
                  >
                    {t('common.cancel')}
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRowError(null);
                    setPending({ kind: 'workspace', id: group.profileId });
                  }}
                  data-testid="databricks-disconnect"
                >
                  {t('settings.databricksDisconnect')}
                </Button>
              )}
            </div>
            {rowError?.id === group.profileId ? (
              <p className="settings-rescan-status error" role="alert">
                {rowError.message}
              </p>
            ) : null}

            <ul className={styles.list}>
              {group.models.map((model) => {
                const modelPending = pending?.kind === 'model' && pending.id === model.id;
                const modelBusy = busyId === model.id;
                const context = formatTokens(model.capabilities.contextWindow);
                const output = formatTokens(model.capabilities.maxTokens);
                const title = modelTitle(model);
                return (
                  <li key={model.id} className={styles.row} data-testid="databricks-model-row">
                    <div className={styles.rowMain}>
                      <strong className={styles.rowTitle}>{title}</strong>
                      {model.displayName && model.displayName !== title ? (
                        <code className={styles.rowIdentity}>{model.displayName}</code>
                      ) : null}
                      <small className={styles.rowMeta}>
                        {context
                          ? t('settings.databricksModelsContext', { value: context })
                          : t('settings.databricksModelsLimitUnknown')}
                        <span aria-hidden> · </span>
                        {output
                          ? t('settings.databricksModelsOutput', { value: output })
                          : t('settings.databricksModelsLimitUnknown')}
                      </small>
                      {rowError?.id === model.id ? (
                        <span className="settings-rescan-status-inline error" role="alert">
                          {rowError.message}
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.rowActions}>
                      {modelPending ? (
                        <span className={styles.confirm} role="group" aria-label={t('settings.databricksRemove')}>
                          <Button
                            className={styles.danger}
                            disabled={modelBusy}
                            onClick={() => void removeModel(model.id)}
                            data-testid="databricks-remove-confirm"
                          >
                            {t('settings.databricksRemoveConfirm')}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={modelBusy}
                            onClick={() => setPending(null)}
                            data-testid="databricks-remove-cancel"
                          >
                            {t('common.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setRowError(null);
                            setPending({ kind: 'model', id: model.id });
                          }}
                          aria-label={`${t('settings.databricksRemove')}: ${title}`}
                          data-testid="databricks-remove"
                        >
                          {t('settings.databricksRemove')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
