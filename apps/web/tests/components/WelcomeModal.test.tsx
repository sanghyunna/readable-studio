// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FALLBACK_MS, EXIT_MS, SHOW_DELAY_MS, WelcomeModal } from '../../src/components/WelcomeModal';

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

// The inline per-row results are also role="status", so the toast is
// identified by the shared Toast surface class instead of its role.
function toastEl(): HTMLElement | null {
  return document.querySelector('.readable-toast');
}

async function renderModal() {
  render(<WelcomeModal />);
  await elapse(SHOW_DELAY_MS);
}

// A dismissal keeps the dialog mounted in its closing phase until the CSS
// exit animation reports `animationend`; jsdom runs no animations, so the
// tests end the exit explicitly. Asserts the phase itself on the way.
function backdropEl(): HTMLElement {
  return document.querySelector('.modal-backdrop') as HTMLElement;
}

async function finishExit() {
  const dialog = screen.getByRole('dialog');
  expect(backdropEl().getAttribute('data-closing')).toBe('true');
  expect(backdropEl().hasAttribute('inert')).toBe(true);
  await act(async () => {
    fireEvent.animationEnd(dialog);
  });
  expect(screen.queryByRole('dialog')).toBeNull();
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

  it('keeps the modal open on a failed creation and explains the reason inline', async () => {
    mockFetch(fullCaps, (location) => ({ status: 'failed', location, reason: 'write-failed' }));
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();
    const result = screen.getByTestId('welcome-result-desktop');
    expect(result.getAttribute('role')).toBe('alert');
    expect(result.textContent).toMatch(/could not/i);
    expect(result.textContent).toMatch(/could not be written/i);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(toastEl()).toBeNull();
  });

  it('closes and announces a success toast once every selected shortcut is created', async () => {
    const fetchFn = mockFetch(fullCaps);
    await renderModal();
    fireEvent.click(screen.getByRole('switch', { name: /start menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();
    // The toast is up while the modal is still fading out.
    expect(toastEl()).not.toBeNull();
    await finishExit();
    const posted = fetchFn.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => (JSON.parse(String(init!.body)) as { location: string }).location);
    expect(posted).toEqual(['desktop', 'startMenu']);
    const toast = toastEl();
    expect(toast?.getAttribute('role')).toBe('status');
    expect(toast?.textContent).toContain('Desktop and Start Menu shortcuts');
    expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBe('1');
  });

  it('names only the chosen target in the toast', async () => {
    mockFetch(fullCaps);
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();
    await finishExit();
    expect(toastEl()?.textContent).toContain('Desktop shortcut');
  });

  it('treats an already-existing shortcut as success', async () => {
    mockFetch(fullCaps, (location) => ({ status: 'already-existed', location }));
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();
    await finishExit();
    expect(toastEl()).not.toBeNull();
  });

  it('stays open on partial failure, marks the created one done, and lets the user retry only the failed one', async () => {
    const post = vi.fn((location: string) =>
      location === 'startMenu' ? { status: 'failed', location, reason: 'conflict' } : { status: 'created', location },
    );
    mockFetch(fullCaps, post);
    await renderModal();
    fireEvent.click(screen.getByRole('switch', { name: /start menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(toastEl()).toBeNull();
    expect(screen.getByTestId('welcome-result-desktop').textContent).toMatch(/created/i);
    const failed = screen.getByTestId('welcome-result-startMenu');
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.textContent).toMatch(/different file already uses that name/i);
    expect(screen.getByRole('switch', { name: /desktop/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: /start menu/i }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /skip/i })).toBeTruthy();

    post.mockImplementation((location) => ({ status: 'created', location }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await settle();
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2]![0]).toBe('startMenu');
    await finishExit();
    expect(toastEl()?.textContent).toContain('Desktop and Start Menu shortcuts');
  });

  it('lets Skip close the modal after a failure without a toast', async () => {
    mockFetch(fullCaps, (location) => ({ status: 'failed', location, reason: 'unsupported' }));
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await finishExit();
    expect(toastEl()).toBeNull();
  });

  it('turns the primary action into Skip when nothing is selected, closing without creating anything', async () => {
    const fetchFn = mockFetch(fullCaps);
    await renderModal();
    fireEvent.click(screen.getByRole('switch', { name: /desktop/i }));
    expect(screen.queryByRole('button', { name: /add shortcut/i })).toBeNull();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Skip');
    fireEvent.click(buttons[0]!);
    await finishExit();
    expect(toastEl()).toBeNull();
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBe('1');
  });

  it('shows a busy state and ignores a second submit while creating', async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return gate;
      return jsonResponse(fullCaps);
    });
    vi.stubGlobal('fetch', fetchFn);
    await renderModal();
    const apply = screen.getByRole('button', { name: /add shortcut/i });
    fireEvent.click(apply);
    await settle();
    const busyButton = screen.getByRole('button', { name: /adding/i });
    expect(busyButton.getAttribute('aria-busy')).toBe('true');
    expect(busyButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(busyButton);
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    release(jsonResponse({ status: 'created', location: 'desktop' }));
    await settle();
    await finishExit();
    expect(toastEl()).not.toBeNull();
  });

  describe('exit animation', () => {
    it('keeps the dialog mounted and inert in a closing state until animationend, then unmounts', async () => {
      mockFetch(fullCaps);
      await renderModal();
      const dialog = screen.getByRole('dialog');
      expect(backdropEl().getAttribute('data-closing')).toBeNull();
      expect(backdropEl().hasAttribute('inert')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: /skip/i }));
      // Still mounted: the exit has to be painted before the unmount.
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(backdropEl().getAttribute('data-closing')).toBe('true');
      expect(backdropEl().hasAttribute('inert')).toBe(true);

      // A descendant's animationend bubbling through the dialog is not the exit.
      await act(async () => {
        fireEvent.animationEnd(screen.getByRole('heading', { level: 2 }));
      });
      expect(screen.getByRole('dialog')).toBe(dialog);

      await act(async () => {
        fireEvent.animationEnd(dialog);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(window.localStorage.getItem('readable-studio:welcome-modal-shown')).toBe('1');
    });

    it('unmounts on the fallback timer when animationend never arrives', async () => {
      mockFetch(fullCaps);
      await renderModal();
      fireEvent.click(screen.getByRole('button', { name: /skip/i }));
      expect(backdropEl().getAttribute('data-closing')).toBe('true');
      await elapse(EXIT_MS);
      expect(screen.getByRole('dialog')).toBeTruthy();
      await elapse(EXIT_FALLBACK_MS - EXIT_MS);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('resolves a dismissal exactly once: repeat presses and Escape during the exit are ignored', async () => {
      const fetchFn = mockFetch(fullCaps);
      await renderModal();
      fireEvent.click(screen.getByRole('switch', { name: /start menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /add shortcut/i }));
      await settle();
      expect(document.querySelectorAll('.readable-toast')).toHaveLength(1);
      const postsBefore = fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').length;

      // jsdom does not enforce `inert`, so the component's own guard is what
      // these presses exercise.
      fireEvent.click(screen.getByRole('button', { name: /skip|done|add shortcut/i }));
      fireEvent.keyDown(document, { key: 'Escape' });
      await settle();
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(document.querySelectorAll('.readable-toast')).toHaveLength(1);
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(postsBefore);

      await finishExit();
      expect(document.querySelectorAll('.readable-toast')).toHaveLength(1);
      expect(toastEl()?.textContent).toContain('Desktop and Start Menu shortcuts');
      // The fallback timer was cleared by animationend: nothing fires later.
      await elapse(EXIT_FALLBACK_MS);
      expect(document.querySelectorAll('.readable-toast')).toHaveLength(1);
    });

    it('closes instantly under prefers-reduced-motion', async () => {
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query })));
      mockFetch(fullCaps);
      await renderModal();
      fireEvent.click(screen.getByRole('button', { name: /skip/i }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('routes Escape through the same exit', async () => {
      mockFetch(fullCaps);
      await renderModal();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeTruthy();
      await finishExit();
      expect(toastEl()).toBeNull();
    });
  });

  it('does not block the app when the capability call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('daemon down'); }));
    await renderModal();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
