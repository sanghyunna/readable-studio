'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input } from '@readable-studio/components';
import type { DatabricksManagedLoginRequest, DatabricksManagedLoginStart, DatabricksManagedLoginStatus } from '@readable-studio/contracts';
import { useI18n } from '../../i18n';
import { refreshDatabricksModels } from '../databricksModels';
import { startDatabricksLogin, fetchDatabricksLogin, cancelDatabricksLogin } from '../../providers/databricks';
import { openExternalUrl } from '../../providers/registry';
import { copyToClipboard } from '../../lib/copy-to-clipboard';
import { Icon } from '../Icon';
import { DatabricksApiError, fetchDatabricksStatus } from '../../providers/databricks';
import styles from './DatabricksLoginButton.module.css';

export interface DatabricksLoginButtonProps { host?: string; profile?: string; connectionId?: string; onSuccess?: (profileId?: string) => void | Promise<void>; }

export function DatabricksLoginButton({ host, profile, connectionId, onSuccess }: DatabricksLoginButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [needsInput, setNeedsInput] = useState(false);
  const [workspace, setWorkspace] = useState(host ?? '');
  const [profileName, setProfileName] = useState(profile ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DatabricksManagedLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useRef<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastRequest = useRef<DatabricksManagedLoginRequest>();
  const fail = t('databricks.login.failed');
  const failureText = (code?: string | null) => code === 'DATABRICKS_CLI_MISSING' || code === 'DATABRICKS_CLI_UNSUPPORTED'
    ? t('databricks.login.packageRepair')
    : code === 'DATABRICKS_KEYRING_UNAVAILABLE' ? t('databricks.login.keyringUnavailable') : fail;
  const cancel = async () => {
    generation.current++;
    clearTimeout(timer.current);
    const id = job.current;
    job.current = null;
    setBusy(false);
    setOpen(false);
    if (id) await cancelDatabricksLogin(id).catch(() => undefined);
  };
  useEffect(() => () => {
    generation.current++;
    clearTimeout(timer.current);
    if (job.current) void cancelDatabricksLogin(job.current).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Claim modal keys before the parent Settings document capture handler.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void cancel();
      } else if (event.key === 'Tab') {
        event.stopPropagation();
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button, input, a[href]') ?? [])]
          .filter(control => !control.hasAttribute('disabled') && control.tabIndex >= 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) {
        dialog.current?.querySelector<HTMLElement>('button')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('focusin', containFocus);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = overflow;
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    (dialog.current?.querySelector<HTMLElement>('input:not([readonly])') ?? dialog.current?.querySelector<HTMLElement>('button'))?.focus();
  }, [open, needsInput]);

  const begin = async (explicit = false) => {
    setError(null);
    setStatus(null);
    setOpen(true);
    let normalized = host;
    if (explicit) {
      try {
        const url = new URL(workspace.trim());
        if (url.protocol !== 'https:' || url.port || /^https:\/\/[^/]*:\d+/i.test(workspace.trim()) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
        normalized = url.origin;
      } catch {
        setError(t('databricks.setup.hostInvalid'));
        return;
      }
    }
    setBusy(true);
    const current = ++generation.current;
    try {
      let payload = explicit ? { host: normalized, ...(profileName.trim() ? { profile: profileName.trim() } : {}) }
        : lastRequest.current ?? { host: normalized, profile };
      if (!explicit && connectionId) {
        const selected = (await fetchDatabricksStatus()).profiles.find(entry => entry.id === connectionId);
        if (current !== generation.current) return;
        if (!selected) throw new Error();
        if (selected.connectionMode === 'workspace-token') {
          setBusy(false);
          setError(t('databricks.login.replaceToken'));
          return;
        }
        payload = { host: selected.workspaceLabel, profile: selected.label };
      }
      lastRequest.current = payload;
      const result: DatabricksManagedLoginStart = await startDatabricksLogin(payload);
      if (current !== generation.current) {
        if (result.loginId) await cancelDatabricksLogin(result.loginId);
        return;
      }
      if (result.state === 'needs-input') { setNeedsInput(true); setBusy(false); return; }
      if (!result.loginId) throw new Error();
      if (result.host) lastRequest.current = { host: result.host, ...(result.profile ? { profile: result.profile } : {}) };
      job.current = result.loginId;
      setNeedsInput(false);
      const poll = async () => {
        try {
          const next = await fetchDatabricksLogin(result.loginId!);
          if (current !== generation.current) return;
          setStatus(next);
          if (next.state === 'waiting-browser') { timer.current = setTimeout(() => void poll(), 1000); return; }
          job.current = null;
          setBusy(false);
          if (next.state === 'succeeded') {
            await refreshDatabricksModels();
            if (current !== generation.current) return;
            await onSuccess?.(next.profileId);
            if (current !== generation.current) return;
            setOpen(false);
          } else {
            const issue = next.issues?.[0];
            setError(next.state === 'timeout' ? t('databricks.login.timedOut')
              : failureText(issue?.code));
          }
        } catch {
          if (current === generation.current) {
            const id = job.current;
            job.current = null;
            if (id) await cancelDatabricksLogin(id).catch(() => undefined);
            setBusy(false);
            setError(fail);
          }
        }
      };
      void poll();
    } catch (error) { if (current === generation.current) { setBusy(false); setError(failureText(error instanceof DatabricksApiError ? error.code : undefined)); } }
  };

  return <>
    <Button ref={trigger} onClick={() => { lastRequest.current = undefined; void begin(); }} disabled={busy} data-testid="databricks-login-start">{t('databricks.login.action')}</Button>
    {open && createPortal(<div className={`modal-backdrop ${styles.backdrop}`} onMouseDown={event => { if (event.target === event.currentTarget) void cancel(); }}>
      <section ref={dialog} className={`modal ${styles.dialog}`} role="dialog" aria-modal="true" aria-label={t('databricks.login.action')}>
        <header className={styles.header}>
          <h2>{t('databricks.login.action')}</h2>
          <Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={() => void cancel()}><Icon name="close" size={16} /></Button>
        </header>
        {needsInput && <form id="databricks-login-form" onSubmit={event => { event.preventDefault(); void begin(true); }}>
          <label>{t('databricks.login.workspaceLabel')}<Input autoFocus value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="https://workspace.databricks.com" /></label>
          <label>{t('databricks.login.profileLabel')}<Input value={profileName} onChange={event => setProfileName(event.target.value)} /></label>
        </form>}
        {busy && <p className={styles.progress} role="status" data-testid="databricks-login-progress"><Icon name="spinner" size={14} /><span>{t('databricks.login.waiting')}</span></p>}
        {status?.state === 'waiting-browser' && status.authUrl && <div className={styles.url}>
          <Button className={styles.browserAction} onClick={() => void openExternalUrl(status.authUrl!)}><Icon name="external-link" size={14} />{t('databricks.login.openBrowser')}</Button>
          <div className={styles.urlRow}>
            <Input aria-label={t('databricks.login.authUrl')} readOnly value={status.authUrl} />
            <Button onClick={() => void copyToClipboard(status.authUrl!)}>{t('databricks.login.copy')}</Button>
          </div>
        </div>}
        {error && <p role="alert" data-testid="databricks-login-error">{error}</p>}
        <footer className={styles.actions}>
          <Button variant="subtle" onClick={() => void cancel()} data-testid="databricks-login-cancel">{t(busy ? 'databricks.login.cancel' : needsInput && !error ? 'common.cancel' : 'common.close')}</Button>
          {needsInput && !error && <Button variant="primary" type="submit" form="databricks-login-form" disabled={busy}>{t('databricks.login.action')}</Button>}
          {error && <Button variant="primary" onClick={() => void begin(needsInput)}>{t('databricks.login.retry')}</Button>}
        </footer>
      </section>
    </div>, document.body)}
  </>;
}
