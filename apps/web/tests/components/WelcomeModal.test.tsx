// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOW_DELAY_MS, WelcomeModal } from '../../src/components/WelcomeModal';

type Caps = { desktop: boolean; startMenu: boolean; taskbar: false; startPinned: false; reason?: string };

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function mockFetch(caps: Caps, post?: (location: string) => unknown) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { location } = JSON.parse(String(init.body)) as { location: string };
      return jsonResponse(post ? post(location) : { status: 'created', location });
    }
    return jsonResponse(caps);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const fullCaps: Caps = { desktop: true, startMenu: true, taskbar: false, startPinned: false };

// The modal defers its capability probe by SHOW_DELAY_MS from mount, so every
// render goes through fake timers: `settle` drains pending microtasks only,
// `elapse` moves the faked clock and flushes whatever the timers scheduled.
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function renderModal() {
  render(<WelcomeModal />);
  await elapse(SHOW_DELAY_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('WelcomeModal', () => {
  it('stays hidden until SHOW_DELAY_MS has elapsed, then opens', async () => {
    const fetchFn = mockFetch(fullCaps);
    render(<WelcomeModal />);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();

    await elapse(SHOW_DELAY_MS - 1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBeNull();

    await elapse(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBe('1');
  });

  it('does not probe or mark shown when unmounted during the delay', async () => {
    const fetchFn = mockFetch(fullCaps);
    const view = render(<WelcomeModal />);
    await elapse(SHOW_DELAY_MS - 1);
    view.unmount();
    await elapse(SHOW_DELAY_MS);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBeNull();
  });

  it('renders on first run and not on the second', async () => {
    mockFetch(fullCaps);
    await renderModal();
    expect(screen.getByRole('dialog')).toBeTruthy();
    cleanup();
    await renderModal();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers Desktop and Start Menu as switches, never checkboxes, and no taskbar toggle', async () => {
    mockFetch(fullCaps);
    await renderModal();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.queryByRole('switch', { name: /taskbar|작업 표시줄/i })).toBeNull();
    expect(screen.getByText(/right-click|taskbar/i)).toBeTruthy();
  });

  it('reflects each choice in aria-checked and the visual state attribute, and flips on activation', async () => {
    mockFetch(fullCaps);
    await renderModal();
    const desktop = screen.getByRole('switch', { name: /desktop|바탕 화면/i });
    const startMenu = screen.getByRole('switch', { name: /start menu|시작 메뉴/i });
    expect(desktop.getAttribute('aria-checked')).toBe('true');
    expect(desktop.getAttribute('data-state')).toBe('on');
    expect(startMenu.getAttribute('aria-checked')).toBe('false');
    expect(startMenu.getAttribute('data-state')).toBe('off');
    expect(desktop.querySelector('[aria-hidden="true"] > span')).not.toBeNull();

    fireEvent.click(desktop);
    fireEvent.click(startMenu);
    expect(desktop.getAttribute('aria-checked')).toBe('false');
    expect(desktop.getAttribute('data-state')).toBe('off');
    expect(startMenu.getAttribute('aria-checked')).toBe('true');
    expect(startMenu.getAttribute('data-state')).toBe('on');
  });

  it('renders no control for an unsupported capability', async () => {
    mockFetch({ ...fullCaps, desktop: false });
    await renderModal();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(1);
    expect(switches[0]!.getAttribute('data-location')).toBe('startMenu');
  });

  it('surfaces a failed creation with its reason', async () => {
    mockFetch(fullCaps, (location) => ({ status: 'failed', location, reason: 'write-failed' }));
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const result = screen.getByTestId('welcome-result-desktop');
    expect(result.getAttribute('role')).toBe('alert');
    expect(result.textContent).toMatch(/could not/i);
    expect(result.textContent).toMatch(/could not be written/i);
  });

  it('does not block the app when the capability call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('daemon down'); }));
    await renderModal();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
