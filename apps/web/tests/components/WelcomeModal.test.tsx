// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeModal } from '../../src/components/WelcomeModal';

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

async function renderModal() {
  render(<WelcomeModal />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('WelcomeModal', () => {
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
