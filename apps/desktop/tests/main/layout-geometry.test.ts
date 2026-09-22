import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { attachLayoutGeometry } from '../../src/main/layout-geometry.js';

const bounds = { x: 10, y: 20, width: 1280, height: 900 };
function fixture() {
  const window = Object.assign(new EventEmitter(), {
    getBounds: () => bounds, getContentBounds: () => ({ ...bounds, height: 864 }),
    getContentSize: () => [1280, 864], isMaximized: () => true, isDestroyed: () => false,
    webContents: { isDestroyed: () => false, getZoomFactor: () => 1.2, send: vi.fn() },
  });
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: () => ({ bounds, workArea: { ...bounds, height: 860 }, scaleFactor: 1.5 }),
  });
  return { window, screen };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['resize', 'maximize', 'unmaximize', 'restore', 'display-metrics-changed'])(
  'emits numeric native geometry and requests renderer geometry on %s', event => {
    // Given native boundary fakes and a captured production logger.
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { window, screen } = fixture();
    const dispose = attachLayoutGeometry(window, screen);
    // When Electron emits the event.
    (event === 'display-metrics-changed' ? screen : window).emit(event);
    vi.advanceTimersByTime(250);
    // Then both processes receive the same bounded reason batch, with geometry only.
    expect(info).toHaveBeenCalledWith('layout geometry', {
      source: 'main', reasons: [event], bounds, contentBounds: { ...bounds, height: 864 },
      contentSize: [1280, 864], maximized: true, zoomFactor: 1.2,
      display: { bounds, workArea: { ...bounds, height: 860 }, scaleFactor: 1.5 },
    });
    expect(window.webContents.send).toHaveBeenCalledWith('layout:geometry', [event]);
    dispose();
  },
);

it('coalesces bursts, deduplicates unchanged geometry and removes listeners on disposal', () => {
  // Given diagnostics attached to a live window.
  vi.useFakeTimers();
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const { window, screen } = fixture();
  const dispose = attachLayoutGeometry(window, screen);
  // When repeated events arrive, then the listener is disposed with work pending.
  for (let i = 0; i < 100; i++) window.emit('resize');
  vi.advanceTimersByTime(250);
  window.emit('resize');
  vi.advanceTimersByTime(250);
  window.emit('maximize');
  dispose();
  vi.advanceTimersByTime(250);
  // Then only one sample was logged and no retained event/timer can emit.
  expect(info).toHaveBeenCalledTimes(1);
  expect(screen.listenerCount('display-metrics-changed')).toBe(0);
  expect(window.listenerCount('resize')).toBe(0);
});
