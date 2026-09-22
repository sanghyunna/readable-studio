import type { BrowserWindow, Display, Rectangle } from 'electron';

type GeometryWindow = Pick<BrowserWindow, 'getBounds' | 'getContentBounds' | 'getContentSize' | 'isMaximized' | 'isDestroyed'> & {
  readonly webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'getZoomFactor' | 'send'>;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
};
type GeometryScreen = {
  getDisplayMatching(bounds: Rectangle): Pick<Display, 'bounds' | 'workArea' | 'scaleFactor'>;
  on(event: 'display-metrics-changed', listener: () => void): unknown;
  removeListener(event: 'display-metrics-changed', listener: () => void): unknown;
};

/** One bounded native sample and renderer request per event burst; no user data. */
export function attachLayoutGeometry(window: GeometryWindow, screen: GeometryScreen): () => void {
  const reasons = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = '';
  const sample = () => {
    timer = undefined;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const batch = [...reasons].sort();
    reasons.clear();
    const geometry = {
      source: 'main', reasons: batch, bounds, contentBounds: window.getContentBounds(),
      contentSize: window.getContentSize(), maximized: window.isMaximized(),
      zoomFactor: window.webContents.getZoomFactor(),
      display: { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor },
    };
    // Always request the renderer: its layout may change while native geometry does not.
    window.webContents.send('layout:geometry', batch);
    const key = JSON.stringify(geometry);
    if (key === previous) return;
    previous = key;
    console.info('layout geometry', geometry);
  };
  const queue = (reason: string) => {
    reasons.add(reason);
    timer ??= setTimeout(sample, 250);
  };
  const listeners = ['resize', 'maximize', 'unmaximize', 'restore'].map(event => {
    const listener = () => queue(event);
    window.on(event, listener);
    return { event, listener };
  });
  const metricsChanged = () => queue('display-metrics-changed');
  screen.on('display-metrics-changed', metricsChanged);
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    reasons.clear();
    for (const { event, listener } of listeners) window.removeListener(event, listener);
    screen.removeListener('display-metrics-changed', metricsChanged);
    window.removeListener('closed', dispose);
  };
  window.on('closed', dispose);
  return dispose;
}
