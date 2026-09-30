// First-run welcome. Shown once per install (localStorage flag, same
// mechanism as the other one-time UI state such as the AMR reminder and the
// Home first-run guide). The shortcut section is driven entirely by the
// daemon's GET /api/shortcuts capability report: an unsupported target renders
// no control, and a failed capability call renders no modal at all.
import { useEffect, useState } from 'react';
import { Button, Switch } from '@readable-studio/components';
import type { ShortcutCapabilities, ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';
import { useT } from '../i18n';
import { useEscapeDismiss } from '../hooks/useEscapeDismiss';
import styles from './WelcomeModal.module.css';

const STORAGE_KEY = 'readable-studio:welcome-modal-shown';
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

  useEffect(() => {
    if (readShown()) return;
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, []);

  useEscapeDismiss(() => setOpen(false), open && !busy);

  if (!open || !caps) return null;

  const offered = LOCATIONS.filter((location) => caps[location]);
  const selected = offered.filter((location) => chosen[location]);
  const finished = offered.length > 0 && offered.every((location) => results[location]);

  async function apply() {
    setBusy(true);
    const next: Partial<Record<ShortcutLocation, ShortcutCreateResult>> = {};
    for (const location of selected) {
      next[location] = await createShortcut(location);
    }
    setResults(next);
    setBusy(false);
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
    return reason;
  }

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
                    disabled={busy || Boolean(result)}
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
          {finished || offered.length === 0 ? (
            <Button variant="primary" onClick={() => setOpen(false)}>
              {t('welcome.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                {t('welcome.skip')}
              </Button>
              <Button variant="primary" onClick={() => void apply()} disabled={busy || selected.length === 0}>
                {busy ? t('welcome.applying') : t('welcome.apply')}
              </Button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
