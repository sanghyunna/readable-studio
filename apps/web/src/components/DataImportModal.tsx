import { useEffect, useRef, useState } from 'react';
import { Button, ToggleCard } from '@readable-studio/components';
import type { DataImportCandidatesResponse, DataImportRequest, DataImportSourceRunningError } from '@readable-studio/contracts';
import { useI18n } from '../i18n';
import { useEscapeDismiss } from '../hooks/useEscapeDismiss';
import styles from './DataImportModal.module.css';

/** Startup gate: the welcome flow mounts only after this gate resolves. */
export function DataImportModal({ onResolved, manual = false }: { onResolved: () => void; manual?: boolean }) {
  const { t, locale } = useI18n();
  const [result, setResult] = useState<DataImportCandidatesResponse | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const close = () => { if (!inFlight.current) onResolved(); };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode replays effects while Settings is inert; keep the original trigger.
      const target = previousFocus.current;
      if (manual && target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [manual]);
  useEscapeDismiss(close, manual && !busy);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    setResult(null); setSelected(''); setPending(false); setError('');
    const check = () => { void fetch(`/api/data-import/candidates${manual ? '?manual=1' : ''}`, { signal: controller.signal }).then(async response => {
      // Only a successful JSON status can offer a permanent import decision.
      // Proxy/network failures are not an import state.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!active) return;
      // Boundary: an unexpected body must never trap the user behind this gate.
      // A missing candidate list reads as empty; an unrecognized state resolves.
      const raw = (body ?? {}) as Partial<DataImportCandidatesResponse>;
      const value = { ...raw, candidates: Array.isArray(raw.candidates) ? raw.candidates : [] } as DataImportCandidatesResponse;
      if (manual && !['offered', 'failed', 'pending', 'done', 'unavailable'].includes(value.state)) throw new Error('Unexpected import status');
      setResult(value);
      setSelected(value.runningSource?.sourceData ?? value.candidates[0]?.sourceData ?? '');
      if (value.state === 'pending') setPending(true);
      else if (!manual && value.state !== 'offered' && value.state !== 'failed') onResolved();
    }).catch(() => {
      if (!active) return;
      if (manual) setError(t('dataImport.checkFailure'));
      else retryTimer = setTimeout(check, Math.min(1_000 * 2 ** retryAttempt++, 10_000));
    }); };
    check();
    return () => { active = false; controller.abort(); clearTimeout(retryTimer); };
  }, [onResolved, manual, checkAttempt, t]);
  useEffect(() => { dialog.current?.focus(); }, [result, error]);

  const runningSource = result?.runningSource;

  async function request(body: DataImportRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    let restartAccepted = false;
    try {
      const response = await fetch('/api/data-import/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if ([502, 503, 504].includes(response.status)) throw new TypeError('Backend unreachable');
      const value = await response.json();
      if (!mounted.current) return;
      if (!response.ok && value.code === 'SOURCE_RUNNING' && value.runningSource) {
        const blocked = value as DataImportSourceRunningError;
        setPending(false);
        setResult({ state: 'failed', candidates: [], error: blocked.error, runningSource: blocked.runningSource });
        setSelected(blocked.runningSource.sourceData);
        return;
      }
      if (!response.ok) throw new Error(value.error || t('dataImport.safeFailure'));
      if (body.action === 'restart') {
        restartAccepted = true;
        setRestarting(true);
      } else if (value.restartRequired) setPending(true);
      else {
        setPending(false);
        setResult({ state: 'declined', candidates: [] });
        onResolved();
      }
    } catch (cause) {
      if (!mounted.current) return;
      setError(body.action === 'stop-source' ? t('dataImport.stopFailure')
        : cause instanceof TypeError || cause instanceof SyntaxError
          ? t('connection.reconnecting') : cause instanceof Error ? cause.message : t('dataImport.safeFailure'));
    }
    finally {
      if (!restartAccepted) { inFlight.current = false; if (mounted.current) setBusy(false); }
    }
  }
  // The check itself is invisible: the Hub stays usable until there is
  // actually something to offer, a failure to report, or a pending restart.
  if (!manual && !result && !error) return null;
  if (!manual && result && !['offered', 'failed', 'pending'].includes(result.state) && !error) return null;
  const unavailable = manual && result && (result.state === 'done' || result.state === 'unavailable');
  const unavailableMessage = result?.state === 'done' ? 'dataImport.alreadyImported'
    : result?.unavailableReason === 'projects-present' ? 'dataImport.projectsPresent'
      : result?.unavailableReason === 'unsupported-runtime' ? 'dataImport.unsupportedRuntime' : 'dataImport.notFound';
  return <div className={`modal-backdrop ${styles.backdrop}`}>
    <section ref={dialog} tabIndex={-1} className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="data-import-title" data-testid="data-import-modal"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className={styles.head}>
        <h2 id="data-import-title">{t(pending ? restarting ? 'dataImport.restarting' : 'dataImport.restartTitle' : runningSource ? 'dataImport.sourceRunning' : result?.state === 'failed' ? 'dataImport.failed' : manual ? 'dataImport.manualTitle' : 'dataImport.title')}</h2>
        <p>{t(pending ? 'dataImport.restartHint' : runningSource ? 'dataImport.stopHint' : 'dataImport.description')}</p>
      </header>
      {manual && !result && !error ? <p role="status">{t('dataImport.checking')}</p> : null}
      {unavailable ? <p role="status">{t(unavailableMessage)}</p> : null}
      {!unavailable && !pending && !runningSource && result?.candidates.length ? <div className={styles.candidates} role="group" aria-label={t('dataImport.folders')}>
        {result.candidates.map(candidate => <ToggleCard key={candidate.sourceData} className={styles.candidate} pressed={selected === candidate.sourceData} disabled={busy} onPressedChange={() => setSelected(candidate.sourceData)}>
          <span className={styles.path}>{candidate.sourceRoot}</span>
          <span className={styles.meta}>{t('dataImport.projects', { count: String(candidate.projectCount) })} · <time dateTime={candidate.modifiedAt}>{new Date(candidate.modifiedAt).toLocaleString(locale)}</time></span>
        </ToggleCard>)}
      </div> : null}
      {!pending && runningSource ? <div className={styles.runningSource}>
        <p className={styles.sourcePath}>{runningSource.sourceRoot}</p>
        {runningSource.processes.length ? <details className={styles.processDetails}>
          <summary>{t('dataImport.processDetails', { count: String(runningSource.processes.length) })}</summary>
          <ul>{runningSource.processes.map(row => <li key={row.pid}><span>PID {row.pid}</span><span className={styles.executablePath}>{row.executablePath}</span></li>)}</ul>
        </details> : null}
      </div> : null}
      {(error || (!pending && !runningSource && result?.error)) ? <p className={styles.error} role="alert">{pending || runningSource || (manual && !result) ? error : <>{t('dataImport.safeFailure')}<br />{error || result?.error}</>}</p> : null}
      {!pending && result?.warnings?.length ? <p className={styles.error} role="status">{t('dataImport.unreadable')}<br />{result.warnings.join('\n')}</p> : null}
      {pending ? <footer className={styles.actions}>
        <Button variant="ghost" disabled={busy} onClick={() => void request({ action: 'decline' })}>{t('dataImport.cancelImport')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void request({ action: 'restart' })}>{t('dataImport.restart')}</Button>
      </footer> : (result || error) ? <footer className={styles.actions}>
        <Button variant="ghost" disabled={busy} onClick={() => manual ? close() : void request({ action: 'decline' })}>{t(manual ? 'common.close' : 'dataImport.startFresh')}</Button>
        {manual && ((!result && error) || (result?.state === 'unavailable' && !result.unavailableReason)) ? <Button variant="primary" onClick={() => setCheckAttempt(attempt => attempt + 1)}>{t('dataImport.checkAgain')}</Button> : null}
        {runningSource ? <Button variant="primary" disabled={busy} onClick={() => void request({ action: 'stop-source', from: runningSource.sourceData })}>{t(busy ? 'dataImport.requesting' : 'dataImport.stopSource')}</Button>
          : !unavailable && selected ? <Button variant="primary" disabled={busy} onClick={() => void request({ action: 'import', from: selected })}>{t(busy ? 'dataImport.requesting' : 'dataImport.import')}</Button> : null}
      </footer> : manual ? <footer className={styles.actions}><Button variant="ghost" onClick={close}>{t('common.close')}</Button></footer> : null}
    </section>
  </div>;
}
