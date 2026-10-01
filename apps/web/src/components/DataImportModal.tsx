import { useEffect, useRef, useState } from 'react';
import { Button, ToggleCard } from '@readable-studio/components';
import type { DataImportCandidatesResponse, DataImportRequest } from '@readable-studio/contracts';
import { useI18n } from '../i18n';
import styles from './DataImportModal.module.css';

/** Startup gate: the welcome flow mounts only after this gate resolves. */
export function DataImportModal({ onResolved }: { onResolved: () => void }) {
  const { t, locale } = useI18n();
  const [result, setResult] = useState<DataImportCandidatesResponse | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/data-import/candidates').then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (!active) return;
      const value = body as DataImportCandidatesResponse;
      setResult(value);
      setSelected(value.candidates[0]?.sourceData ?? '');
      if (value.state === 'pending') setPending(true);
      else if (value.state !== 'offered' && value.state !== 'failed') onResolved();
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [onResolved]);
  useEffect(() => { dialog.current?.focus(); }, [result, error]);

  async function request(body: DataImportRequest) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/data-import/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      if (value.restartRequired) setPending(true);
      else onResolved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (result && !['offered', 'failed', 'pending'].includes(result.state) && !error) return null;
  return <div className={`modal-backdrop ${styles.backdrop}`}>
    <section ref={dialog} tabIndex={-1} className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="data-import-title" data-testid="data-import-modal"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className={styles.head}>
        <h2 id="data-import-title">{t(!result && !error ? 'dataImport.checking' : pending ? 'dataImport.restarting' : result?.state === 'failed' ? 'dataImport.failed' : 'dataImport.title')}</h2>
        <p>{t(pending ? 'dataImport.restartHint' : 'dataImport.description')}</p>
      </header>
      {!pending && result?.candidates.length ? <div className={styles.candidates} role="group" aria-label={t('dataImport.folders')}>
        {result.candidates.map(candidate => <ToggleCard key={candidate.sourceData} className={styles.candidate} pressed={selected === candidate.sourceData} disabled={busy} onPressedChange={() => setSelected(candidate.sourceData)}>
          <span className={styles.path}>{candidate.sourceRoot}</span>
          <span className={styles.meta}>{t('dataImport.projects', { count: String(candidate.projectCount) })} · <time dateTime={candidate.modifiedAt}>{new Date(candidate.modifiedAt).toLocaleString(locale)}</time></span>
        </ToggleCard>)}
      </div> : null}
      {result?.error || error ? <p className={styles.error} role="alert">{t('dataImport.safeFailure')}<br />{error || result?.error}</p> : null}
      {result?.warnings?.length ? <p className={styles.error} role="status">{t('dataImport.unreadable')}<br />{result.warnings.join('\n')}</p> : null}
      {!pending && (result || error) ? <footer className={styles.actions}>
        <Button variant="ghost" disabled={busy} onClick={() => void request({ action: 'decline' })}>{t('dataImport.startFresh')}</Button>
        {selected ? <Button variant="primary" disabled={busy} onClick={() => void request({ action: 'import', from: selected })}>{t(busy ? 'dataImport.requesting' : 'dataImport.import')}</Button> : null}
      </footer> : null}
    </section>
  </div>;
}
