import { useEffect, useRef, useState } from 'react';
import type { UpdateApplyResult, UpdateCheckAvailable, UpdateCheckResult, UpdateUnavailableReason } from '@readable-studio/contracts';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/types';
import styles from './UpdateSection.module.css';

let lastCheck: UpdateCheckResult | null = null;
let lastCheckedAt: string | null = null;
const checkListeners = new Set<() => void>();
type UpdateReasonKey = Extract<keyof Dict, `update.reason.${string}`>;
const checkReasonKeys = {
  offline: 'update.reason.offline',
  'rate-limited': 'update.reason.rate-limited',
  malformed: 'update.reason.malformed',
  timeout: 'update.reason.timeout',
  disabled: 'update.reason.disabled',
} satisfies Record<UpdateUnavailableReason, UpdateReasonKey>;
const applyReasonKeys: Record<string, UpdateReasonKey> = {
  ...checkReasonKeys,
  'unsupported-layout': 'update.reason.unsupported-layout',
  'update-in-progress': 'update.reason.update-in-progress',
  'already-current': 'update.reason.already-current',
  'checksum-mismatch': 'update.reason.checksum-mismatch',
  'size-mismatch': 'update.reason.size-mismatch',
  'download-failed': 'update.reason.download-failed',
  'helper-not-acknowledged': 'update.reason.helper-not-acknowledged',
};
function updateReasonKey(reason: string): UpdateReasonKey {
  if (Object.hasOwn(applyReasonKeys, reason)) return applyReasonKeys[reason]!;
  if (/terminated|ECONNRESET|ETIMEDOUT|aborted|AbortError|TimeoutError|fetch failed/i.test(reason)) return 'update.reason.download-interrupted';
  if (/^download failed: HTTP \d+$/.test(reason)) return 'update.reason.download-failed';
  if (reason === 'download exceeds expected size') return 'update.reason.size-mismatch';
  if (reason === 'Invalid ZIP path' || reason === 'ZIP path escaped payload') return 'update.reason.invalid-payload';
  if (reason === '업데이트 준비를 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.'
    || /^업데이트 준비 프로세스가 종료되었습니다 \(.+\)\.$/.test(reason)) return 'update.reason.helper-not-acknowledged';
  if (reason === '업데이트 시작 환경을 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.') return 'update.reason.helper-environment';
  return 'update.reason.unknown';
}

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
      // Preserve future reason strings for localized fallback and secondary diagnostics.
      if ('unavailable' in value) return typeof value.unavailable === 'string'
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
      if ('error' in body) throw new Error(body.error);
      if ('unavailable' in body) throw new Error(body.unavailable);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
      <button type="button" className="btn" onClick={() => void apply()}>{t('update.applyNow')}</button>
      <button type="button" className="btn" onClick={() => setConfirming(false)}>{t('update.applyLater')}</button>
    </div> : null}
    {applyError !== null ? <div role="alert" className={styles.result}>
      <span data-update-message>{t(updateReasonKey(applyError))}</span>
      <details><summary>{t('update.errorDetails')}</summary><code>{applyError}</code></details>
    </div> : null}
    {result ? <div role="status" className={styles.result}>
      {'unavailable' in result ? <>
        <span data-update-message>{t(updateReasonKey(result.unavailable))}</span>
        {updateReasonKey(result.unavailable) === 'update.reason.unknown'
          ? <details><summary>{t('update.errorDetails')}</summary><code>{result.unavailable}</code></details> : null}
      </>
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
