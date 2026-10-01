import { useEffect, useState } from 'react';
import { Button } from '@readable-studio/components';
import { useI18n } from '../i18n';
import styles from './OneDriveNotice.module.css';

const STARTUP_PATH = '/__packaged/startup-state';

// Packaged-only same-origin bridge; the shell stores dismissal in its data
// root, not in Chromium localStorage (which changes between installations).
export function OneDriveNotice({ startupUrl }: { startupUrl?: string }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const endpoint = startupUrl ?? (typeof window !== 'undefined' && window.location.protocol === 'readable-studio:' ? STARTUP_PATH : null);
  useEffect(() => {
    if (!endpoint) return;
    let active = true;
    void fetch(endpoint).then(async (response) => {
      if (!response.ok) throw new Error(`Startup notice probe failed: ${response.status}`);
      const state = await response.json() as { oneDriveNotice: boolean };
      if (active) setVisible(state.oneDriveNotice === true);
    }).catch((failure: unknown) => { console.error('Packaged startup notice unavailable', failure); });
    return () => { active = false; };
  }, [endpoint]);
  async function dismiss() {
    if (!endpoint) return;
    setBusy(true); setError(false);
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error(`Startup notice dismissal failed: ${response.status}`);
      setVisible(false);
    } catch (failure) {
      console.error('Packaged startup notice dismissal failed', failure); setError(true);
    } finally { setBusy(false); }
  }
  if (!visible) return null;
  return <section className={styles.notice} role="status" aria-labelledby="onedrive-notice-title" data-testid="onedrive-notice">
    <h2 id="onedrive-notice-title">{t('startup.oneDriveTitle')}</h2>
    <p>{t('startup.oneDriveExplanation')}</p>
    <p>{t('startup.oneDriveMove')}</p>
    {error && <p role="alert">{t('startup.oneDriveDismissFailed')}</p>}
    <Button disabled={busy} onClick={() => { void dismiss(); }}>{t('startup.oneDriveDismiss')}</Button>
  </section>;
}
