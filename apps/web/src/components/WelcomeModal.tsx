// First-run welcome. Shown once per install (localStorage flag, same
// mechanism as the other one-time UI state such as the AMR reminder and the
// Home first-run guide). The shortcut section is driven entirely by the
// daemon's GET /api/shortcuts capability report: an unsupported target renders
// no control, and a failed capability call renders no modal at all.
//
// The modal is mounted in the same commit as the Hub shell, so without a
// delay it would land on the Hub's very first frame (mount + one localhost
// round-trip) and the user never gets to see the Hub behind it. The capability
// probe is therefore deferred by SHOW_DELAY_MS from mount; the shown flag is
// written only when the modal actually opens, so closing the window during
// the delay does not burn the one-time showing.
//
// The primary action is the whole decision: it creates every selected
// shortcut, and when all of them succeed the modal closes itself and a
// success toast names what was made. Only a failure keeps the modal open,
// with the reason inline beside the switch and the successful ones marked
// done, so the user can retry just the failed target or skip. With nothing
// selected the primary action IS Skip (one button, labelled with what it
// does) instead of a disabled "Add" beside a working ghost button.
import { useEffect, useRef, useState } from 'react';
import { Button, Switch } from '@readable-studio/components';
import type { ShortcutCapabilities, ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';
import { useT } from '../i18n';
import { useEscapeDismiss } from '../hooks/useEscapeDismiss';
import { Toast } from './Toast';
import styles from './WelcomeModal.module.css';

const STORAGE_KEY = 'readable-studio:welcome-modal-shown';
export const SHOW_DELAY_MS = 2000;
const LOCATIONS: ShortcutLocation[] = ['desktop', 'startMenu'];

function readShown(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

function markShown(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Private-mode storage failures just skip the modal next time too.
  }
}

async function fetchCapabilities(): Promise<ShortcutCapabilities | null> {
  const res = await fetch('/api/shortcuts');
  if (!res.ok) return null;
  const body = (await res.json()) as Partial<ShortcutCapabilities>;
  return {
    desktop: body.desktop === true,
    startMenu: body.startMenu === true,
    taskbar: false,
    startPinned: false,
    ...(body.reason ? { reason: body.reason } : {}),
  };
}

function isSuccess(result: ShortcutCreateResult | undefined): boolean {
  return result?.status === 'created' || result?.status === 'already-existed';
}

async function createShortcut(location: ShortcutLocation): Promise<ShortcutCreateResult> {
  try {
    const res = await fetch('/api/shortcuts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location }),
    });
    if (!res.ok) return { status: 'failed', location, reason: `http-${res.status}` };
    return (await res.json()) as ShortcutCreateResult;
  } catch (err) {
    return { status: 'failed', location, reason: err instanceof Error ? err.message : 'request-failed' };
  }
}

export function WelcomeModal() {
  const t = useT();
  const [caps, setCaps] = useState<ShortcutCapabilities | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Record<ShortcutLocation, boolean>>({ desktop: true, startMenu: false });
  const [results, setResults] = useState<Partial<Record<ShortcutLocation, ShortcutCreateResult>>>({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // setState is async, so a second click in the same tick would slip past the
  // `busy` render guard; the ref closes that window.
  const inFlight = useRef(false);

  useEffect(() => {
    if (readShown()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchCapabilities()
        .then((next) => {
          if (cancelled || !next) return;
          markShown();
          setCaps(next);
          setOpen(true);
        })
        .catch(() => {
          // Capability probe failed: degrade to no modal, never block startup.
        });
    }, SHOW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEscapeDismiss(() => setOpen(false), open && !busy);

  if (!open || !caps) {
    return toast ? <Toast message={toast} tone="success" onDismiss={() => setToast(null)} /> : null;
  }

  const offered = LOCATIONS.filter((location) => caps[location]);
  const selected = offered.filter((location) => chosen[location]);
  const succeeded = (location: ShortcutLocation) => isSuccess(results[location]);
  const pending = selected.filter((location) => !succeeded(location));
  const failedBefore = pending.some((location) => results[location]?.status === 'failed');

  function finish(made: ShortcutLocation[]) {
    if (made.length > 0) {
      const both = made.includes('desktop') && made.includes('startMenu');
      setToast(t(both ? 'welcome.toast.both' : made[0] === 'desktop' ? 'welcome.toast.desktop' : 'welcome.toast.startMenu'));
    }
    setOpen(false);
  }

  async function apply() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const next = { ...results };
    for (const location of pending) {
      next[location] = await createShortcut(location);
    }
    setResults(next);
    setBusy(false);
    inFlight.current = false;
    if (selected.every((location) => isSuccess(next[location]))) finish(selected);
  }

  function resultText(result: ShortcutCreateResult): string {
    if (result.status === 'failed') {
      return t('welcome.result.failed').replace('{reason}', reasonText(result.reason));
    }
    if (result.status === 'created') return t('welcome.result.created');
    return t('welcome.result.alreadyExisted');
  }

  function reasonText(reason: string): string {
    if (reason === 'unsupported') return t('welcome.reason.unsupported');
    if (reason === 'desktop-unavailable') return t('welcome.reason.desktopUnavailable');
    if (reason === 'conflict') return t('welcome.reason.conflict');
    if (reason === 'write-failed') return t('welcome.reason.writeFailed');
    return t('welcome.reason.failed');
  }

  const primary =
    pending.length > 0
      ? { label: busy ? t('welcome.applying') : failedBefore ? t('welcome.retry') : t('welcome.apply'), onClick: () => void apply() }
      : selected.length > 0 || offered.length === 0
        ? { label: t('welcome.done'), onClick: () => finish(selected) }
        : { label: t('welcome.skip'), onClick: () => finish([]) };

  return (
    <div className={`modal-backdrop ${styles.backdrop}`} role="presentation">
      <section
        className={`modal ${styles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        data-testid="welcome-modal"
      >
        <header className={styles.head}>
          <h2 id="welcome-modal-title">{t('welcome.title')}</h2>
          <p className={styles.intro}>{t('welcome.intro')}</p>
        </header>

        {offered.length > 0 ? (
          <div className={styles.shortcuts} role="group" aria-label={t('welcome.shortcutsHeading')}>
            <p className={styles.sectionLabel}>{t('welcome.shortcutsHeading')}</p>
            {offered.map((location) => {
              const result = results[location];
              return (
                <div key={location} className={styles.row}>
                  <Switch
                    className={styles.switch}
                    checked={chosen[location]}
                    disabled={busy || succeeded(location)}
                    onCheckedChange={(checked) => setChosen((prev) => ({ ...prev, [location]: checked }))}
                    data-location={location}
                  >
                    {t(location === 'desktop' ? 'welcome.desktop' : 'welcome.startMenu')}
                  </Switch>
                  {result ? (
                    <p
                      className={result.status === 'failed' ? styles.resultFailed : styles.result}
                      role={result.status === 'failed' ? 'alert' : 'status'}
                      data-testid={`welcome-result-${location}`}
                    >
                      {resultText(result)}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <p className={styles.hint}>{t('welcome.taskbarHint')}</p>

        <footer className={styles.foot}>
          {pending.length > 0 ? (
            <Button variant="ghost" onClick={() => finish([])} disabled={busy}>
              {t('welcome.skip')}
            </Button>
          ) : null}
          <Button variant="primary" onClick={primary.onClick} disabled={busy} aria-busy={busy || undefined}>
            {primary.label}
          </Button>
        </footer>
      </section>
    </div>
  );
}
