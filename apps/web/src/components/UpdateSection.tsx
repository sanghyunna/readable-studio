import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, Switch } from '@readable-studio/components';
import { compareUpdateVersions, type AutoUpdateConfig, type UpdateCheckAvailable, type UpdateCheckResult, type UpdateConnectionFailure, type UpdateConnectionReport, type UpdateStatus } from '@readable-studio/contracts';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/types';
import { DatabricksLoginButton } from './databricks/DatabricksLoginButton';
import styles from './UpdateSection.module.css';

let lastCheck: UpdateCheckResult | null = null;
let lastCheckedAt: string | null = null;
const listeners = new Set<() => void>();
const statusListeners = new Set<(status: UpdateStatus) => void>();
let lastStatus: UpdateStatus | null = null;
function publishStatus(status: UpdateStatus) {
  lastStatus = status;
  statusListeners.forEach((listener) => listener(status));
}
type ReasonKey = Extract<keyof Dict, `update.reason.${string}`> | 'update.serverHint';
function reasonKey(reason: string): ReasonKey {
  const keys: Record<string, ReasonKey> = {
    unreachable: 'update.reason.offline', 'invalid-response': 'update.reason.malformed',
    'not-logged-in': 'update.reason.not-logged-in', forbidden: 'update.reason.forbidden',
    'no-release': 'update.reason.no-release', 'not-configured': 'update.serverHint',
    disabled: 'update.reason.disabled', timeout: 'update.reason.timeout',
    'checksum-mismatch': 'update.reason.checksum-mismatch', 'size-mismatch': 'update.reason.size-mismatch',
    'download-failed': 'update.reason.download-failed', 'unsupported-layout': 'update.reason.unsupported-layout',
    'already-current': 'update.reason.already-current',
    'disk-extract-failed': 'update.reason.disk-extract-failed', 'helper-not-acknowledged': 'update.reason.helper-not-acknowledged',
    'invalid-url': 'update.reason.invalid-url', 'app-not-accessible': 'update.reason.app-not-accessible',
    'update-in-progress': 'update.reason.update-in-progress', 'version-mismatch': 'update.reason.version-mismatch',
    'source-changed': 'update.reason.source-changed', cancelled: 'update.reason.cancelled',
    'not-ready': 'update.reason.not-ready',
    'release-withdrawn': 'update.reason.release-withdrawn', 'invalid-package': 'update.reason.invalid-package',
  };
  return keys[reason] ?? 'update.reason.unknown';
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as (Record<string, unknown> & { error?: string; unavailable?: string; host?: string }) | null;
  if (!response.ok) throw Object.assign(new Error(value?.error ?? value?.unavailable ?? 'unreachable'), { host: value?.host });
  if (value === null || typeof value !== 'object') throw new Error('invalid-response');
  return value as T;
}
async function checkUpdate(automatic = false): Promise<UpdateCheckResult> {
  let result: UpdateCheckResult;
  try { result = await request<UpdateCheckResult>(`/api/update/check${automatic ? '?automatic=1' : ''}`); }
  catch { result = { unavailable: 'unreachable' }; }
  // Malformed payloads (null, {}) are treated as a neutral no-op, never rendered.
  if (!result || typeof result !== 'object' || !('unavailable' in result || 'isNewer' in result)) result = { unavailable: 'disabled' };
  if (!('unavailable' in result && result.unavailable === 'disabled')) {
    try { publishStatus(await request<UpdateStatus>('/api/update/status')); } catch {}
    lastCheck = result;
    lastCheckedAt = 'checkedAt' in result ? result.checkedAt : new Date().toISOString();
    listeners.forEach((listener) => listener());
  }
  return result;
}
interface LoginSlot {
  renderDatabricksLogin?: (host: string | undefined, onSuccess: () => void) => ReactNode;
}
/** The daemon bounds the check; the extra slack only guards a stalled daemon. */
const CONNECTION_TIMEOUT_MS = 25_000;
type ConnectionReport = Omit<UpdateConnectionReport, 'failure'> & { failure?: UpdateConnectionFailure | 'daemon-unreachable' };
type ConnectionView = { state: 'checking' } | { state: 'done'; report: ConnectionReport };
function normalizeServerUrl(input: string): string | null {
  if (!input.trim()) return null;
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new Error('invalid-url'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid-url');
  return parsed.href.replace(/\/+$/, '');
}
async function requestConnection(serverUrl: string): Promise<ConnectionReport> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS + 5_000);
  const local = (failure: ConnectionReport['failure']): ConnectionReport =>
    ({ ok: false, serverUrl, failure, timeoutMs: CONNECTION_TIMEOUT_MS, elapsedMs: Date.now() - started, steps: [] });
  try {
    const response = await fetch('/api/update/connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl }), signal: controller.signal,
    });
    const value = await response.json().catch(() => null) as ConnectionReport | null;
    return response.ok && value && typeof value === 'object' && Array.isArray(value.steps) ? value : local('invalid-response');
  } catch {
    return local(controller.signal.aborted ? 'timeout' : 'daemon-unreachable');
  } finally { clearTimeout(timer); }
}
function ConnectionLog({ report }: { report: ConnectionReport }) {
  const { t } = useI18n();
  return <details className={styles.log}>
    <summary>{t('update.connection.details')}</summary>
    <ol>{report.steps.map((step, index) => <li key={index} data-ok={step.ok}>
      <span className={styles.logStep}>{t(`update.connection.step.${step.step}`)}</span>
      <span className={styles.logOutcome}>{t(step.ok ? 'update.connection.stepOk' : 'update.connection.stepFailed')}</span>
      {step.httpStatus ? <span>HTTP {step.httpStatus}</span> : null}
      <span>{step.elapsedMs} ms</span>
      <code>{step.detail}</code>
    </li>)}</ol>
    <p>{t('update.connection.total', { ms: report.elapsedMs, seconds: Math.round(report.timeoutMs / 1000) })}</p>
  </details>;
}
function ConnectionResult({ view, retry, renderDatabricksLogin }: LoginSlot & { view: ConnectionView; retry: () => void }) {
  const { t } = useI18n();
  if (view.state === 'checking') return <div className={styles.connection} data-update-connection="checking" role="status">
    <div className={styles.progress} aria-busy="true" data-working="true">
      <progress aria-label={t('update.connecting')} />
      <span>{t('update.connectingHint', { seconds: CONNECTION_TIMEOUT_MS / 1000 })}</span>
    </div>
  </div>;
  const { report } = view;
  if (report.ok) return <div className={styles.connection} data-update-connection="ok" role="status">
    <strong>{t('update.connection.ok')}</strong>
    <ul className={styles.facts}>
      <li>{t('update.connection.okServer')}</li>
      {report.host && report.profile ? <li>{t('update.connection.okWorkspace', { host: report.host, profile: report.profile })}</li> : null}
      {report.latest !== undefined ? <li>{report.latest ? t('update.connection.okLatest', { version: report.latest }) : t('update.connection.okNoRelease')}</li> : null}
    </ul>
    <ConnectionLog report={report} />
  </div>;
  const failure = report.failure ?? 'invalid-response';
  return <div className={styles.connection} data-update-connection="failed">
    <div role="alert" className={styles.connectionError}>
      <span data-update-message>{t(`update.connection.failure.${failure}`, { seconds: Math.round(report.timeoutMs / 1000) })}</span>
      {failure === 'not-logged-in' ? renderDatabricksLogin?.(report.host, retry) ?? <DatabricksLoginButton host={report.host} onSuccess={retry} /> : null}
    </div>
    <ConnectionLog report={report} />
  </div>;
}
function UpdateError({ error, host, retry, renderDatabricksLogin }: LoginSlot & { error: string; host?: string; retry: () => void }) {
  const { t } = useI18n();
  return <div role="alert" className={styles.result}>
    <span data-update-message>{t(reasonKey(error))}</span>
    {error === 'not-logged-in' ? renderDatabricksLogin?.(host, retry) ?? <DatabricksLoginButton host={host} onSuccess={retry} /> : null}
  </div>;
}
function useRecoveredUpdate(enabled = true) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let streamed = false;
    const events = typeof EventSource === 'undefined' ? null : new EventSource('/api/update/events');
    if (events) {
      events.onmessage = (event) => {
        let next: UpdateStatus | null;
        try { next = JSON.parse(event.data) as UpdateStatus | null; } catch { return; }
        if (!next || typeof next !== 'object') return;
        streamed = true;
        publishStatus(next);
        setStatus((previous) => next.failedApply || next.discardedDownload || next.version && next.releaseUrl && (!previous?.version || previous.version !== next.version) ? next : previous?.failedApply ? null : previous);
      };
    }
    void request<UpdateStatus>('/api/update/status').then((next) => {
      if (!disposed && !streamed && next) publishStatus(next);
      if (!disposed && !streamed && (next?.failedApply || next?.discardedDownload || next?.version && next.releaseUrl && (next.state === 'ready' || next.state === 'failed' || next.received > 0 || next.state === 'downloading'))) setStatus(next);
    }).catch(() => {});
    const sync = () => { setStatus(lastStatus?.failedApply || lastStatus?.discardedDownload || lastStatus?.version && lastStatus.releaseUrl ? lastStatus : null); };
    listeners.add(sync);
    return () => { disposed = true; listeners.delete(sync); events?.close(); };
  }, [enabled]);
  return status;
}
function DownloadAction({ update, recovered, onApply, onStatus, renderDatabricksLogin, secondaryAction }: LoginSlot & { update?: UpdateCheckAvailable; recovered?: UpdateStatus; onApply?: (update: UpdateCheckAvailable) => void; onStatus?: (status: UpdateStatus) => void; secondaryAction?: (active: boolean) => ReactNode }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<UpdateStatus | null>(recovered ?? null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(!!recovered?.extraction);
  const applyingRef = useRef(!!recovered?.extraction);
  const extractionStarted = useRef(!!recovered?.extraction);
  const completedExtraction = useRef<UpdateStatus['extraction']>(recovered?.extraction?.total && recovered.extraction.completed >= recovered.extraction.total ? recovered.extraction : undefined);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const [cancelled, setCancelled] = useState(false);
  const version = update?.latest ?? recovered?.version;
  const [host, setHost] = useState<string>();
  const report = (next: UpdateStatus) => { publishStatus(next); };
  useEffect(() => {
    const sync = (next: UpdateStatus) => {
      if (next.extraction) {
        applyingRef.current = true; setApplying(true);
        extractionStarted.current = true;
        completedExtraction.current = next.extraction.total > 0 && next.extraction.completed >= next.extraction.total ? next.extraction : undefined;
      }
      if (next.error || next.state !== 'ready') {
        extractionStarted.current = false;
        completedExtraction.current = undefined;
        applyingRef.current = false; setApplying(false);
      }
      setStatus(next); setError(null); onStatus?.(next);
    };
    statusListeners.add(sync);
    return () => { statusListeners.delete(sync); };
  }, []);
  const begin = async () => {
    if (preparingRef.current) return;
    preparingRef.current = true; setPreparing(true); setCancelled(false);
    setError(null);
    try {
      const next = await request<UpdateStatus>('/api/update/download', {});
      if (!next || typeof next !== 'object') throw new Error('invalid-response');
      setStatus((previous) => previous?.version === next.version
        && (['ready', 'failed', 'verifying'].includes(previous.state) || previous.received > next.received) ? previous : next);
    }
    catch (fault) { setError(fault instanceof Error ? fault.message : 'unreachable'); setHost((fault as { host?: string }).host); }
    finally { preparingRef.current = false; setPreparing(false); }
  };
  const apply = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true); setError(null);
    try { if (onApply && update) await onApply(update); else await request('/api/update/apply', {}); }
    catch (fault) {
      const reason = fault instanceof Error ? fault.message : 'unreachable';
      try { publishStatus(await request<UpdateStatus>('/api/update/status')); } catch {}
      // HTTP rejection belongs to this request, not to every observer's apply.
      setError(reason);
      if (reason !== 'update-in-progress' || !extractionStarted.current) {
        extractionStarted.current = false;
        completedExtraction.current = undefined;
        applyingRef.current = false; setApplying(false);
      }
    }
  };
  const cancel = async () => {
    try { const next = await request<UpdateStatus>('/api/update/cancel', {}); setCancelled(true); report(next); }
    catch (fault) { setError(fault instanceof Error ? fault.message : 'unreachable'); }
  };
  const active = status !== null && status.version === version && (status.state === 'downloading' || status.state === 'verifying');
  const failure = error ?? (status?.error === 'apply-rolled-back' ? null : status?.error);
  const retry = status?.state === 'failed';
  const isApplying = applying || !!status?.extraction;
  const extraction = status?.extraction ?? completedExtraction.current;
  const finishing = isApplying && (status?.extraction?.total ? status.extraction.completed >= status.extraction.total : !status?.extraction && extractionStarted.current);
  const extractionMax = extraction?.totalBytes || extraction?.total || 1;
  const extractionValue = extraction?.totalBytes
    ? Math.min(extraction.completedBytes ?? 0, extractionMax * (finishing ? 1 : 0.999))
    : extraction?.total ? extraction.completed : undefined;
  const extractionPercent = extraction?.totalBytes ? `${(100 * extractionValue! / extractionMax).toLocaleString(locale, { maximumFractionDigits: 1 })}%` : null;
  const extractionLabel = finishing
    ? `${t('update.finishing')}${extraction?.total ? ` ${t('update.extractedFiles', { total: extraction.total.toLocaleString(locale) })}` : ''}`
    : extractionPercent ? `${t('update.extracting')} ${extractionPercent}`
      : extraction?.total ? t('update.extractingFiles', { completed: extraction.completed.toLocaleString(locale), total: extraction.total.toLocaleString(locale) })
        : t(status?.extraction ? 'update.extracting' : 'update.applying');
  const extractionProgress = isApplying ? <div className={styles.progress} aria-busy="true" data-working={finishing || undefined} data-phase={finishing ? 'finishing' : status?.extraction ? 'extracting' : 'preparing'}>
    <progress aria-label={extractionLabel} value={extractionValue} max={extractionMax} />
    <span>{extractionLabel}</span>
  </div> : null;
  const waitingForBytes = !isApplying && (preparing || active) && !status?.received;
  const waitingProgress = waitingForBytes ? <div className={styles.progress} aria-busy="true" data-working="true">
    <progress aria-label={t('update.preparing')} />
    <span>{t('update.preparing')}</span>
  </div> : null;
  const unit = (status?.total ?? 0) < 1048576 ? 'KB' : 'MB';
  const divisor = unit === 'KB' ? 1024 : 1048576;
  const progressText = status ? `${(status.received / divisor).toFixed(1)} / ${(status.total / divisor).toFixed(1)} ${unit} · ${Math.min(100, Math.floor(status.received / (status.total || 1) * 100))}%` : '';
  const discarded = status?.state === 'idle' && !status.version;
  const partial = status !== null && status.version === version && status.received > 0 && status.state !== 'ready';
  if (secondaryAction) return <div className={styles.download}>
    <div className={styles.summary}>
      <span className={styles.title} data-applying={isApplying || undefined}>{t(isApplying ? 'update.applyingVersion' : discarded && failure ? 'update.title' : status !== null && status.version === version && status.state === 'ready' ? 'update.ready' : partial && !active && !failure ? cancelled ? 'update.kept' : 'update.interrupted' : 'update.newVersion', { version: version! })}</span>
      {(status?.notes ?? update?.notes) ? <p className={styles.notes} title={status?.notes ?? update?.notes}>{status?.notes ?? update?.notes}</p> : null}
      {extractionProgress}
      {waitingProgress}
      {status !== null && status.version === version && status.received > 0 && status.state !== 'ready' ? <div className={styles.progress}>
        <progress aria-label={t('update.download')} value={status.received} max={status.total || 1} />
        <span>{progressText}</span>
      </div> : null}
      {failure ? <div role="alert" className={styles.result}><span data-update-message>{t(reasonKey(failure))}</span></div> : null}
    </div>
    <div className={styles.actions}>
      {discarded && failure ? <Button variant="primary" onClick={() => void checkUpdate()}>{t('update.check')}</Button>
        : failure === 'not-logged-in' ? renderDatabricksLogin?.(host ?? status?.host, () => void begin()) ?? <DatabricksLoginButton host={host ?? status?.host} onSuccess={() => void begin()} />
        : active ? <Button variant="primary" onClick={() => void cancel()}>{t('update.cancel')}</Button>
        : status?.state === 'ready' && status.version === version
          ? <Button variant="primary" disabled={isApplying} aria-busy={isApplying} onClick={() => void apply()}>{t(isApplying ? 'update.applyingAction' : 'update.restart')}</Button>
          : <Button variant="primary" disabled={preparing} aria-busy={preparing} onClick={() => void begin()}>{t(preparing ? 'update.preparing' : partial ? 'update.resume' : retry ? 'update.retry' : 'update.download')}</Button>}
      {!isApplying && secondaryAction(active)}
    </div>
  </div>;
  return <div className={styles.download}>
    <span data-applying={isApplying || undefined}>{t(isApplying ? 'update.applyingVersion' : discarded && failure ? 'update.title' : status !== null && status.version === version && status.state === 'ready' ? 'update.ready' : partial && !active && !failure ? cancelled ? 'update.kept' : 'update.interrupted' : 'update.newVersion', { version: version! })}</span>
    {(status?.notes ?? update?.notes) ? <p className={styles.notes} title={status?.notes ?? update?.notes}>{status?.notes ?? update?.notes}</p> : null}
    {extractionProgress}
    {waitingProgress}
    <div className={styles.actions}>
    {discarded && failure ? <Button onClick={() => void checkUpdate()}>{t('update.check')}</Button> : active || partial ? <div className={styles.progress}>
      {!waitingForBytes ? <><progress aria-label={t('update.download')} value={status!.received} max={status!.total || 1} />
      <span>{progressText}</span></> : null}
      {active ?
      <Button onClick={() => void cancel()}>{t('update.cancel')}</Button>
      : <Button disabled={preparing} aria-busy={preparing} onClick={() => void begin()}>{t(preparing ? 'update.preparing' : 'update.resume')}</Button>}
    </div> : status?.state === 'ready' && status.version === version
      ? <Button disabled={isApplying} aria-busy={isApplying} onClick={() => void apply()}>{t(isApplying ? 'update.applyingAction' : 'update.restart')}</Button>
      : <Button disabled={preparing} aria-busy={preparing} onClick={() => void begin()}>{t(preparing ? 'update.preparing' : retry ? 'update.retry' : 'update.download')}</Button>}
    {failure ? <UpdateError error={failure} host={host ?? status?.host} retry={() => void begin()} renderDatabricksLogin={renderDatabricksLogin} /> : null}
  </div></div>;
}
export interface UpdateSectionProps extends LoginSlot {
  currentVersion: string | null;
  onApply?: (update: UpdateCheckAvailable) => void;
}
export function UpdateSection({ currentVersion, onApply, renderDatabricksLogin }: UpdateSectionProps) {
  const { t, locale } = useI18n();
  const candidate = useRecoveredUpdate();
  const recovered = candidate?.version && (!currentVersion || compareUpdateVersions(candidate.version, currentVersion) === 1) ? candidate : null;
  const [config, setConfig] = useState<AutoUpdateConfig>({ enabled: false, serverUrl: null });
  const [configLoaded, setConfigLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const urlEdited = useRef(false);
  const [result, setResult] = useState(lastCheck);
  const runningVersion = currentVersion ?? (result && 'current' in result ? result.current : null);
  const failedRetry = candidate?.failedApply && runningVersion && compareUpdateVersions(candidate.failedApply.version, runningVersion) === 1;
  const replacementOffer = result && 'isNewer' in result && result.isNewer
    && (!candidate?.discardedDownload || !!candidate.version)
    && (result.latest !== candidate?.failedApply?.version || result.sha256 !== candidate.failedApply.sha256);
  const [checkedAt, setCheckedAt] = useState(lastCheckedAt);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<'toggle' | 'connection' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string>();
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const inputErrorId = useId();
  const inputError = error === 'invalid-url' || error === 'not-configured';
  const clearPrevious = () => {
    setSuperseded(true); setResult(null); setError(null); setConnection(null);
  };
  useEffect(() => {
    void request<{ config: { autoUpdate?: AutoUpdateConfig } }>('/api/app-config').then((value) => {
      const next = value?.config?.autoUpdate ?? { enabled: false, serverUrl: null };
      setConfig(next); setConfigLoaded(true); if (!urlEdited.current) setUrl(next.serverUrl ?? '');
    }).catch(() => setError('unreachable'));
    const sync = () => { setResult(lastCheck); setCheckedAt(lastCheckedAt); };
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);
  const save = async (enabled: boolean, validate: boolean, serverInput = url, optimistic = false) => {
    const previous = config;
    if (optimistic) setConfig({ ...config, enabled });
    clearPrevious(); setSaving(optimistic ? 'toggle' : 'connection');
    try {
      const serverUrl = normalizeServerUrl(serverInput);
      if ((enabled || validate) && !serverUrl) throw new Error('not-configured');
      if (validate) await request('/api/update/health', { serverUrl });
      const response = await fetch('/api/app-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoUpdate: { enabled, serverUrl } }) });
      if (!response.ok) throw new Error('invalid-response');
      setConfig({ enabled, serverUrl }); setUrl(serverUrl ?? '');
      if (optimistic && enabled) setResult(await checkUpdate());
    } catch (fault) {
      if (optimistic) setConfig(previous);
      setError(fault instanceof Error ? fault.message : 'unreachable'); setHost((fault as { host?: string }).host);
    }
    finally { setSaving(null); }
  };
  const check = async () => { clearPrevious(); setBusy(true); try { setResult(await checkUpdate()); } finally { setBusy(false); } };
  // Connect is an explicit diagnosis: progress shows at once and the bounded report always lands beside the button.
  const connect = async () => {
    clearPrevious();
    let serverUrl: string | null;
    try { serverUrl = normalizeServerUrl(url); } catch (fault) { setError(fault instanceof Error ? fault.message : 'invalid-url'); return; }
    if (!serverUrl) { setError('not-configured'); return; }
    setSaving('connection'); setConnection({ state: 'checking' });
    const report = await requestConnection(serverUrl);
    try {
      if (report.ok) {
        const response = await fetch('/api/app-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoUpdate: { enabled: config.enabled, serverUrl } }) });
        if (!response.ok) throw new Error('invalid-response');
        setConfig({ enabled: config.enabled, serverUrl }); setUrl(serverUrl);
      }
    } catch (fault) { setError(fault instanceof Error ? fault.message : 'invalid-response'); }
    finally { setConnection({ state: 'done', report }); setSaving(null); }
  };
  return <section className={`settings-section ${styles.section}`} aria-label={t('update.title')}>
    <Switch checked={config.enabled} pending={saving === 'toggle'} disabled={busy || saving === 'connection' || (!url.trim() && !config.enabled)} onCheckedChange={(enabled) => void save(enabled, enabled, enabled ? url : config.serverUrl ?? '', true)}>{t('update.automatic')}</Switch>
    {saving === 'toggle' && config.enabled ? <p role="status" className={styles.result} data-update-automatic-status>{t('update.automaticChecking')}</p> : null}
    <label className={styles.server}>{t('update.serverUrl')}<Input type="url" value={url} aria-invalid={inputError || undefined} aria-describedby={inputError ? inputErrorId : undefined} placeholder="https://…databricksapps.com" onChange={(event) => { urlEdited.current = true; setUrl(event.target.value); clearPrevious(); }} />
      {inputError ? <span id={inputErrorId} role="alert" className={styles.fieldError}>{t(reasonKey(error!))}</span> : null}
    </label>
    <Button disabled={busy || !!saving || !url.trim()} aria-busy={saving === 'connection' || undefined} onClick={() => void connect()}>{t(saving === 'connection' ? 'update.connecting' : 'update.connect')}</Button>
    {connection ? <ConnectionResult view={connection} retry={() => void connect()} renderDatabricksLogin={renderDatabricksLogin} /> : null}
    <dl className={styles.metadata}>
      <div><dt>{t('update.current')}</dt><dd>{currentVersion ?? t('settings.versionUnavailable')}</dd></div>
      <div><dt>{t('update.lastChecked')}</dt><dd>{checkedAt ? <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString(locale)}</time> : t('update.neverChecked')}</dd></div>
    </dl>
    <Button disabled={busy || !!saving || !config.serverUrl} onClick={() => void check()}>{t(busy ? 'update.checking' : 'update.check')}</Button>
    {configLoaded && !url.trim() && !config.serverUrl && !inputError ? <p>{t('update.serverHint')}</p> : null}
    {candidate?.discardedDownload && !replacementOffer ? <p role="status" className={styles.result}>{t('update.discarded', { version: candidate.discardedDownload.version })}</p> : null}
    {candidate?.failedApply && failedRetry && !candidate.discardedDownload && !replacementOffer && candidate.state !== 'ready' && candidate.state !== 'downloading' && candidate.state !== 'verifying' ? <p role="status" className={styles.result}>{t('update.rolledBack', { version: candidate.failedApply.version })}</p> : null}
    {error && !inputError ? <UpdateError error={error} host={host} retry={() => void save(config.enabled, true)} renderDatabricksLogin={renderDatabricksLogin} />
      : error ? null
      : recovered && !superseded ? <div role="status" className={styles.result}>
      <DownloadAction key={`${recovered.releaseUrl}:${recovered.version}`} recovered={recovered} renderDatabricksLogin={renderDatabricksLogin} /></div>
      : candidate?.failedApply && failedRetry
        && !candidate.discardedDownload && !recovered && (!result || 'unavailable' in result && result.unavailable !== 'no-release' || 'isNewer' in result && result.isNewer && result.latest === candidate.failedApply.version && result.sha256 === candidate.failedApply.sha256) ? <DownloadAction key={candidate.failedApply.id} recovered={{ ...candidate, version: candidate.failedApply.version, releaseUrl: candidate.failedApply.releaseUrl }} renderDatabricksLogin={renderDatabricksLogin} />
      : result && 'unavailable' in result ? result.unavailable === 'no-release'
        ? <p role="status" className={styles.result}>{t('update.upToDate', { version: runningVersion ?? t('settings.versionUnavailable') })}</p>
        : <UpdateError error={result.unavailable} host={result.host} retry={() => void check()} renderDatabricksLogin={renderDatabricksLogin} />
      : result ? <div role="status" className={styles.result}>
        {result.isNewer && (!candidate?.discardedDownload || !!candidate.version) && (!currentVersion || compareUpdateVersions(result.latest, currentVersion) === 1) ? <DownloadAction key={`${result.releaseUrl}:${result.latest}`} update={result} recovered={candidate?.version === result.latest && candidate.releaseUrl === result.releaseUrl ? candidate : undefined} onApply={onApply} renderDatabricksLogin={renderDatabricksLogin} /> : candidate?.discardedDownload ? null : t('update.upToDate', { version: runningVersion ?? t('settings.versionUnavailable') })}</div> : null}
  </section>;
}
export function UpdateLaunchBanner({ ready, renderDatabricksLogin }: LoginSlot & { ready: boolean }) {
  const { t } = useI18n();
  const candidate = useRecoveredUpdate(ready);
  const started = useRef(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  const runningVersion = result && 'current' in result ? result.current : currentVersion;
  const recovered = candidate?.version && (!runningVersion || compareUpdateVersions(candidate.version, runningVersion) === 1) ? candidate : null;
  const [dismissedNotice, setDismissedNotice] = useState(() => typeof window === 'undefined' ? null : localStorage.getItem('update.dismissedDiscard'));
  const failedApply = candidate?.failedApply && (!runningVersion || compareUpdateVersions(candidate.failedApply.version, runningVersion) === 1) ? candidate.failedApply : null;
  const notice = candidate?.discardedDownload ?? failedApply;
  const eligibleOffer = result && 'isNewer' in result && result.isNewer
    && (!runningVersion || compareUpdateVersions(result.latest, runningVersion) === 1)
    && (!candidate?.discardedDownload || !!candidate.version)
    && (result.latest !== failedApply?.version || result.sha256 !== failedApply.sha256);
  const showNotice = initialCheckDone && notice && notice.id !== dismissedNotice && !eligibleOffer
    && !(recovered && (recovered.state === 'ready' || recovered.state === 'downloading' || recovered.received > 0));
  const [dismissed, setDismissed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const onStatus = (status: UpdateStatus) => { if (status.state === 'ready' || status.state === 'idle' || status.state === 'failed') setHidden(false); };
  const check = () => { void checkUpdate(true).then(setResult).catch(() => {}); };
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    let disposed = false;
    let attempts = 0;
    let pending = false;
    let known = false;
    const acceptCurrent = (value: unknown) => {
      if (disposed || typeof value !== 'string') return;
      known = true; setCurrentVersion(value);
    };
    const readVersion = () => {
      if (disposed || known || pending || attempts >= 2) return;
      attempts++; pending = true;
      void request<{ version: { version: string } }>('/api/version').then((value) => {
        if (!known) acceptCurrent(value.version?.version);
      }).catch(() => {}).finally(() => { pending = false; });
    };
    const syncStatus = (status: UpdateStatus) => {
      if ('current' in status) acceptCurrent(status.current);
      readVersion();
    };
    const syncCheck = () => {
      if (lastCheck && 'current' in lastCheck) acceptCurrent(lastCheck.current);
    };
    statusListeners.add(syncStatus);
    listeners.add(syncCheck);
    readVersion();
    void checkUpdate(true).then((next) => {
      if (disposed) return;
      if ('current' in next) acceptCurrent(next.current);
      setResult(next);
    }).finally(() => { if (!disposed) setInitialCheckDone(true); });
    return () => { disposed = true; started.current = false; statusListeners.delete(syncStatus); listeners.delete(syncCheck); };
  }, [ready]);
  useEffect(() => {
    const sync = () => { setResult(lastCheck); };
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, []);
  if (showNotice) return <aside role="status" className={styles.banner}>
    <div className={styles.download}>
      <div className={styles.summary}><span className={styles.discardNotice}>{t(notice === candidate?.failedApply ? 'update.rolledBack' : 'update.discarded', { version: notice.version })}</span></div>
      <div className={styles.actions}><Button onClick={() => { localStorage.setItem('update.dismissedDiscard', notice.id); setDismissedNotice(notice.id); }}>{t('update.dismiss')}</Button></div>
    </div>
  </aside>;
  if (candidate?.discardedDownload && !candidate.version && !eligibleOffer) return null;
  if (!recovered && candidate?.failedApply && result && 'latest' in result && result.latest === candidate.failedApply.version && result.sha256 === candidate.failedApply.sha256) return null;
  if (dismissed || (!recovered && (!result || ('unavailable' in result && ['disabled', 'not-configured', 'no-release'].includes(result.unavailable)) || ('isNewer' in result && !result.isNewer)))) return null;
  if (!recovered && result && 'isNewer' in result && !eligibleOffer) return null;
  const secondaryAction = (active: boolean) => <Button onClick={() => active ? setHidden(true) : setDismissed(true)}>{t(active ? 'update.hide' : 'update.later')}</Button>;
  return <aside role="status" hidden={hidden} className={styles.banner}>
    {recovered ? <DownloadAction key={`${recovered.releaseUrl}:${recovered.version}`} recovered={recovered} onStatus={onStatus} secondaryAction={secondaryAction} renderDatabricksLogin={renderDatabricksLogin} />
      : result && 'unavailable' in result ? <div className={styles.download}>
        <div className={styles.summary}><div role="alert" className={styles.result}><span data-update-message>{t(reasonKey(result.unavailable))}</span></div></div>
        <div className={styles.actions}>
          {result.unavailable === 'not-logged-in' ? renderDatabricksLogin?.(result.host, check) ?? <DatabricksLoginButton host={result.host} onSuccess={check} />
            : <Button variant="primary" onClick={check}>{t('update.check')}</Button>}
          {secondaryAction(false)}
        </div>
      </div>
      : result && 'latest' in result ? <DownloadAction update={result} onStatus={onStatus} secondaryAction={secondaryAction} renderDatabricksLogin={renderDatabricksLogin} /> : null}
  </aside>;
}
