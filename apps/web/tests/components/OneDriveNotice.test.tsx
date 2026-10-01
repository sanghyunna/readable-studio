// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OneDriveNotice } from '../../src/components/OneDriveNotice';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';

const ko = getKo();
const URL = 'readable-studio://app/__packaged/startup-state';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(startupUrl?: string) {
  return render(
    <I18nProvider initial="ko">
      <OneDriveNotice {...(startupUrl ? { startupUrl } : {})} />
    </I18nProvider>,
  );
}

it('explains the risk and remembers dismissal through the data-root bridge', async () => {
  let dismissed = false;
  const fetchState = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') dismissed = true;
    return { ok: true, json: async () => ({ oneDriveNotice: !dismissed }) } as Response;
  });
  vi.stubGlobal('fetch', fetchState);
  let view!: ReturnType<typeof render>;
  await act(async () => { view = mount(URL); });
  expect(screen.getByRole('status').textContent).toContain(ko['startup.oneDriveExplanation']);
  expect(screen.getByRole('status').textContent).toContain(ko['startup.oneDriveMove']);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ko['startup.oneDriveDismiss'] })); });
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  await act(async () => { mount(URL); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(dismissed).toBe(true);
});

it('reports a failed dismissal and keeps the notice up', async () => {
  const fetchState = vi.fn(async (_url: unknown, init?: RequestInit) =>
    ({ ok: init?.method !== 'POST', status: init?.method === 'POST' ? 500 : 200, json: async () => ({ oneDriveNotice: true }) }) as Response);
  vi.stubGlobal('fetch', fetchState);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => { mount(URL); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ko['startup.oneDriveDismiss'] })); });
  expect(screen.getByRole('alert').textContent).toBe(ko['startup.oneDriveDismissFailed']);
  expect(screen.getByRole('status')).not.toBeNull();
});

it('does not probe the packaged bridge in a browser', async () => {
  const fetchState = vi.fn(); vi.stubGlobal('fetch', fetchState);
  await act(async () => { mount(); });
  expect(fetchState).not.toHaveBeenCalled();
});
