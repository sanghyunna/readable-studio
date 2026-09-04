// @vitest-environment jsdom

/**
 * Traffic-light window controls for the frameless desktop window.
 *
 * The desktop main window is created with no native title bar, so these three
 * buttons ARE the window chrome. Each has to dispatch the real `window:*` IPC
 * exposed by the desktop preload, and the maximize control has to reflect the
 * live window state (including state changes that originate outside the
 * renderer, e.g. Aero snap or a double-click on the drag strip).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowControls } from '../../src/components/WindowControls';
import { I18nProvider } from '../../src/i18n';

type StateListener = (state: { maximized: boolean }) => void;

function installDesktopWindowApi(initialMaximized = false) {
  const listeners = new Set<StateListener>();
  const api = {
    close: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ maximized: initialMaximized })),
    minimize: vi.fn(async () => undefined),
    onStateChange: vi.fn((listener: StateListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    toggleMaximize: vi.fn(async () => ({ maximized: !initialMaximized })),
  };
  (window as unknown as { readableStudioDesktop?: unknown }).readableStudioDesktop = {
    window: api,
  };
  return {
    api,
    emit(state: { maximized: boolean }) {
      listeners.forEach((listener) => listener(state));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  // The component renders only where the window is genuinely frameless; jsdom's
  // default platform is not mac, but pin it so the suite is platform-stable.
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { readableStudioDesktop?: unknown }).readableStudioDesktop;
});

describe('WindowControls', () => {
  it('renders nothing in the browser, where there is no window to control', () => {
    const { container } = render(<WindowControls />);
    expect(container.innerHTML).toBe('');
  });

  it('dispatches minimize / toggle-maximize / close to the desktop IPC bridge', () => {
    const desktop = installDesktopWindowApi();
    render(<WindowControls />);

    fireEvent.click(screen.getByTestId('window-control-minimize'));
    expect(desktop.api.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('window-control-maximize'));
    expect(desktop.api.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('window-control-close'));
    expect(desktop.api.close).toHaveBeenCalledTimes(1);
  });

  it('exposes each control as a real button with an accessible name', () => {
    installDesktopWindowApi();
    render(<WindowControls />);

    for (const testId of [
      'window-control-minimize',
      'window-control-maximize',
      'window-control-close',
    ]) {
      const button = screen.getByTestId(testId);
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });

  it('reflects maximized state pushed from the main process', async () => {
    const desktop = installDesktopWindowApi(false);
    render(<WindowControls />);

    const maximize = screen.getByTestId('window-control-maximize');
    await waitFor(() => expect(maximize.getAttribute('aria-pressed')).toBe('false'));
    expect(maximize.getAttribute('aria-label')).toBe('Maximize');

    // A maximize that did not come from the button (snap, double-click drag
    // strip, OS shortcut) must still flip the control to its restore affordance.
    desktop.emit({ maximized: true });

    await waitFor(() => expect(maximize.getAttribute('aria-pressed')).toBe('true'));
    expect(maximize.getAttribute('aria-label')).toBe('Restore');
  });

  it('localizes every accessible name in Korean', () => {
    installDesktopWindowApi();
    render(
      <I18nProvider initial="ko">
        <WindowControls />
      </I18nProvider>,
    );

    expect(screen.getByTestId('window-control-minimize').getAttribute('aria-label')).toBe('최소화');
    expect(screen.getByTestId('window-control-maximize').getAttribute('aria-label')).toBe('최대화');
    expect(screen.getByTestId('window-control-close').getAttribute('aria-label')).toBe('닫기');
  });

  it('unsubscribes from window-state events on unmount', () => {
    const desktop = installDesktopWindowApi();
    const { unmount } = render(<WindowControls />);
    expect(desktop.listenerCount).toBe(1);
    unmount();
    expect(desktop.listenerCount).toBe(0);
  });
});
