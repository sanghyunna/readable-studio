// macOS-idiom traffic lights for the app's own window chrome.
//
// The desktop window is frameless (`frame: false` on Windows/Linux,
// `titleBarStyle: 'hiddenInset'` on macOS), so minimize / maximize / close are
// drawn here and dispatched to the main process over the `window:*` IPC
// channels exposed by the desktop preload. On macOS the OS still draws its own
// traffic lights inside the inset title bar, so this row renders only where the
// window is genuinely frameless; the web client has no window to control and
// renders nothing.
//
// The buttons are real `<button>` elements with accessible names so the row is
// keyboard reachable, and each is `-webkit-app-region: no-drag` (see
// `shell.css`) so clicks are not swallowed by the surrounding drag strip.

import { useEffect, useState } from 'react';

import { useT } from '../i18n';
import { isMacPlatform } from '../utils/platform';

interface DesktopWindowControlsApi {
  close(): Promise<void>;
  getState(): Promise<{ maximized: boolean }>;
  minimize(): Promise<void>;
  onStateChange(listener: (state: { maximized: boolean }) => void): () => void;
  toggleMaximize(): Promise<{ maximized: boolean }>;
}

function readWindowApi(): DesktopWindowControlsApi | null {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as {
    readableStudioDesktop?: { window?: DesktopWindowControlsApi };
  }).readableStudioDesktop;
  return desktop?.window ?? null;
}

// macOS draws its own traffic lights in the `hiddenInset` title bar; drawing a
// second set beside them would be a duplicate control, so the renderer row is
// only for the platforms whose window is fully frameless.

export function WindowControls() {
  const t = useT();
  const [api] = useState<DesktopWindowControlsApi | null>(readWindowApi);
  const [maximized, setMaximized] = useState(false);
  const minimizeLabel = t('window.minimize');
  const maximizeLabel = maximized ? t('window.restore') : t('window.maximize');

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    void api.getState().then((state) => {
      if (active) setMaximized(Boolean(state?.maximized));
    });
    const unsubscribe = api.onStateChange((state) => {
      setMaximized(Boolean(state?.maximized));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  if (!api || isMacPlatform()) return null;

  return (
    <div className="window-controls" data-testid="window-controls">
      <button
        type="button"
        className="window-controls__light window-controls__light--minimize"
        data-testid="window-control-minimize"
        aria-label={minimizeLabel}
        title={minimizeLabel}
        onClick={() => {
          void api.minimize();
        }}
      >
        <span className="window-controls__glyph" aria-hidden="true">
          <svg viewBox="0 0 10 10" focusable="false">
            <path d="M2 5h6" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        className="window-controls__light window-controls__light--maximize"
        data-testid="window-control-maximize"
        aria-label={maximizeLabel}
        title={maximizeLabel}
        aria-pressed={maximized}
        onClick={() => {
          void api.toggleMaximize().then((state) => {
            setMaximized(Boolean(state?.maximized));
          });
        }}
      >
        <span className="window-controls__glyph" aria-hidden="true">
          {maximized ? (
            <svg viewBox="0 0 10 10" focusable="false">
              <path d="M2.2 3.4h4.4v4.4H2.2z" />
              <path d="M3.6 3.4V2.2h4.2v4.2H6.6" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" focusable="false">
              <path d="M2.4 2.4h5.2v5.2H2.4z" />
            </svg>
          )}
        </span>
      </button>
      <button
        type="button"
        className="window-controls__light window-controls__light--close"
        data-testid="window-control-close"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={() => {
          void api.close();
        }}
      >
        <span className="window-controls__glyph" aria-hidden="true">
          <svg viewBox="0 0 10 10" focusable="false">
            <path d="M3 3l4 4M7 3l-4 4" />
          </svg>
        </span>
      </button>
    </div>
  );
}
