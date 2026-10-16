// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner } from '../../src/components/UpdateSection';
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
it.each([
  ['unreachable', 'offline'], ['invalid-response', 'malformed'], ['not-logged-in', 'not-logged-in'],
  ['forbidden', 'forbidden'], ['checksum-mismatch', 'checksum-mismatch'],
  ['disk-extract-failed', 'disk-extract-failed'],
  ['app-not-accessible', 'app-not-accessible'], ['update-in-progress', 'update-in-progress'],
  ['version-mismatch', 'version-mismatch'], ['source-changed', 'source-changed'],
  ['cancelled', 'cancelled'], ['not-ready', 'not-ready'],
  ['release-withdrawn', 'release-withdrawn'], ['invalid-package', 'invalid-package'],
])('renders localized failure %s and supplies the login workspace', async (reason, key) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ unavailable: reason, host: 'https://workspace.azuredatabricks.net' })));
  await act(async () => { render(<I18nProvider initial="ko"><UpdateLaunchBanner ready /></I18nProvider>); });
  expect(screen.getByRole('alert').querySelector('[data-update-message]')?.textContent).toBe(getKo()[`update.reason.${key}` as keyof Dict]);
  if (reason === 'not-logged-in') expect(screen.getByRole('button', { name: 'https://workspace.azuredatabricks.net' })).toBeTruthy();
  else expect(screen.queryByRole('button', { name: 'https://workspace.azuredatabricks.net' })).toBeNull();
});
