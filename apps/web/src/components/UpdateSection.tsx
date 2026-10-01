import { useEffect, useRef, useState } from 'react';
import type { UpdateApplyResult, UpdateCheckAvailable, UpdateCheckResult, UpdateUnavailableReason } from '@readable-studio/contracts';
import { useI18n } from '../i18n';
import styles from './UpdateSection.module.css';

let lastCheck: UpdateCheckResult | null = null;
let lastCheckedAt: string | null = null;
const checkListeners = new Set<() => void>();
const reasons: UpdateUnavailableReason[] = ['offline', 'rate-limited', 'malformed', 'timeout', 'disabled'];

async function fetchUpdateCheck(automatic = false): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UpdateCheckResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ unavailable: 'timeout' }); }, 6000);
  });
  const request = async (): Promise<UpdateCheckResult> => {
    try {
      const response = await fetch(`/api/update/check${automatic ? '?automatic=1' : ''}`, { signal: controller.signal });
      if (!response.ok) return { unavailable: 'offline' };
      let value: unknown;
      try { value = await response.json(); } catch { return { unavailable: 'malformed' }; }
      if (!value || typeof value !== 'object') return { unavailable: 'malformed' };
      if ('unavailable' in value) return reasons.includes(value.unavailable as UpdateUnavailableReason)
        ? value as UpdateCheckResult : { unavailable: 'malformed' };
      const data = value as UpdateCheckAvailable;
      if (typeof data.current !== 'string' || typeof data.latest !== 'string' || typeof data.isNewer !== 'boolean'
        || typeof data.assetName !== 'string' || !Number.isSafeInteger(data.assetSize) || data.assetSize <= 0
        || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(data.sha256)
        || typeof data.notes !== 'string' || typeof data.checkedAt !== 'string' || !Number.isFinite(Date.parse(data.checkedAt))
        || typeof data.releaseUrl !== 'string' || !data.releaseUrl.startsWith('https://github.com/sanghyunna/readable-studio/releases/tag/')) return { unavailable: 'malformed' };
      return data;
    } catch { return { unavailable: controller.signal.aborted ? 'timeout' : 'offline' }; }
  };
  try {
    const result = await Promise.race([request(), timeout]);
    // Disabled launch checks are not recorded as attempts.
    if (!('unavailable' in result && result.unavailable === 'disabled')) {
      lastCheck = result;
      lastCheckedAt = 'checkedAt' in result ? result.checkedAt : new Date().toISOString();
      for (const notify of checkListeners) notify();
    }
    return result;
  } finally { clearTimeout(timer); }
}

export interface UpdateSectionProps {
  currentVersion: string | null;
  /** Optional host override; the default action calls the daemon apply route. */
  onApply?: (update: UpdateCheckAvailable) => void;
}

export function UpdateSection({ currentVersion, onApply }: UpdateSectionProps) {
  const { t } = useI18n();
  const [result, setResult] = useState(lastCheck);
  const [checkedAt, setCheckedAt] = useState(lastCheckedAt);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const apply = async () => {
    if (!result || 'unavailable' in result || !result.isNewer) return;
    setConfirming(false); setApplying(true); setApplyError(null);
    try {
      if (onApply) { await onApply(result); return; }
      const response = await fetch('/api/update/apply', { method: 'POST' });
      const body: UpdateApplyResult = await response.json();
      if (!response.ok) throw new Error('error' in body ? body.error : 'unavailable' in body ? body.unavailable : `HTTP ${response.status}`);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
      setApplying(false);
    }
  };
  useEffect(() => {
    const sync = () => { setResult(lastCheck); setCheckedAt(lastCheckedAt); };
    checkListeners.add(sync);
    return () => { checkListeners.delete(sync); };
  }, []);
  const check = async () => {
    setChecking(true);
    const next = await fetchUpdateCheck();
    setResult(next); setCheckedAt(lastCheckedAt); setChecking(false);
  };
  return <section className={`settings-section ${styles.section}`} aria-label={t('update.title')}>
    <dl className={styles.metadata}>
      <div><dt>{t('update.current')}</dt><dd>{currentVersion ?? t('settings.versionUnavailable')}</dd></div>
      <div><dt>{t('update.lastChecked')}</dt><dd>{checkedAt ? <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time> : t('update.neverChecked')}</dd></div>
    </dl>
    <div className={styles.actions}>
      <button type="button" className="btn" disabled={checking} onClick={() => void check()}>{t(checking ? 'update.checking' : 'update.check')}</button>
      <button type="button" className="btn" disabled={applying || !result || 'unavailable' in result || !result.isNewer} onClick={() => setConfirming(true)}>{t('update.apply')}</button>
    </div>
    {confirming ? <div role="dialog" aria-modal="true" aria-label={t('update.apply')}>
      <button type="button" className="btn" onClick={() => void apply()}>지금 종료 후 업데이트</button>
      <button type="button" className="btn" onClick={() => setConfirming(false)}>나중에</button>
    </div> : null}
    {applyError ? <div role="alert">{applyError}</div> : null}
    {result ? <div role="status" className={styles.result}>
      {'unavailable' in result ? t('update.failed', { reason: t(`update.reason.${result.unavailable}`) })
        : result.isNewer ? <><span>{t('update.newVersion', { version: result.latest })}</span>{' '}<a href={result.releaseUrl} target="_blank" rel="noreferrer">{t('update.releaseNotes')}</a></>
          : t('update.upToDate')}
    </div> : null}
  </section>;
}

/** Mount in the persistent web shell with ready=true only after Hub readiness. */
export function UpdateLaunchBanner({ ready }: { ready: boolean }) {
  const { t } = useI18n();
  const started = useRef(false);
  const [update, setUpdate] = useState<UpdateCheckAvailable | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void fetchUpdateCheck(true).then((result) => {
      if (!('unavailable' in result) && result.isNewer) setUpdate(result);
    });
  }, [ready]);
  if (!update || dismissed) return null;
  return <aside role="status" className={styles.banner}>
    <span>{t('update.newVersion', { version: update.latest })}</span>
    <a href={update.releaseUrl} target="_blank" rel="noreferrer">{t('update.releaseNotes')}</a>
    <button type="button" className="btn" aria-label={t('common.close')} onClick={() => setDismissed(true)}>{t('common.close')}</button>
  </aside>;
}
