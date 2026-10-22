// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import type { Dict } from '../../src/i18n/types';
import { getEn } from '../../src/i18n/locales/en';

vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: ({ host }: { host?: string }) => <button>{host ?? 'login'}</button> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([getKo, getEn])('Q11-02 keeps the extraction phase label when counts arrive', (dictionary) => {
  const dict = dictionary();
  expect(dict['update.extractingFiles'].startsWith(dict['update.extracting'])).toBe(true);
});
it.each(['ko', 'en'] as const)('localizes the compact launch setup toast in %s', async (locale) => {
  const dictionary = locale === 'ko' ? getKo() : getEn();
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/update/status'
    ? { state: 'idle', received: 0, total: 0, version: null, error: null } : { unavailable: 'unreachable' })));
  const openSettings = vi.fn();
  await act(async () => render(<I18nProvider initial={locale}><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} /></I18nProvider>));
  expect(screen.getByRole('status').textContent).toContain(dictionary['update.setupFailed']);
  fireEvent.click(screen.getByRole('button', { name: dictionary['update.enableAutomatic'] }));
  expect(openSettings).toHaveBeenCalledOnce();
});
it.each([
  ['unreachable', 'offline'], ['invalid-response', 'malformed'], ['not-logged-in', 'not-logged-in'],
  ['forbidden', 'forbidden'], ['checksum-mismatch', 'checksum-mismatch'],
  ['disk-extract-failed', 'disk-extract-failed'],
  ['app-not-accessible', 'app-not-accessible'], ['update-in-progress', 'update-in-progress'],
  ['version-mismatch', 'version-mismatch'], ['source-changed', 'source-changed'],
  ['cancelled', 'cancelled'], ['not-ready', 'not-ready'],
  ['release-withdrawn', 'release-withdrawn'], ['invalid-package', 'invalid-package'],
])('renders localized Settings failure %s and supplies the login workspace', async (reason, key) => {
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/app-config'
    ? { config: { autoUpdate: { enabled: true, serverUrl: 'https://updates.example' } } }
    : url === '/api/update/status' ? { state: 'idle', received: 0, total: 0, version: null, error: null }
      : { unavailable: reason, host: 'https://workspace.azuredatabricks.net' })));
  await act(async () => { render(<I18nProvider initial="ko"><UpdateSection currentVersion="1.3.4" /></I18nProvider>); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['update.check'] })));
  expect(screen.getByRole('alert').querySelector('[data-update-message]')?.textContent).toBe(getKo()[`update.reason.${key}` as keyof Dict]);
  if (reason === 'not-logged-in') expect(screen.getByRole('button', { name: 'https://workspace.azuredatabricks.net' })).toBeTruthy();
  else expect(screen.queryByRole('button', { name: 'https://workspace.azuredatabricks.net' })).toBeNull();
});
