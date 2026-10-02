// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateSection } from '../../src/components/UpdateSection';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import type { Dict } from '../../src/i18n/types';

const available = { current: '1.2.1', latest: '1.3.0', isNewer: true, assetName: 'portable.zip', assetSize: 1234, sha256: 'a'.repeat(64), releaseUrl: 'https://github.com/sanghyunna/readable-studio/releases/tag/v1.3.0', notes: '', checkedAt: '2026-10-01T00:00:00.000Z' };
const checkReasons = ['offline', 'rate-limited', 'malformed', 'timeout', 'disabled'];
const applyReasons = [
  ['unsupported-layout', 'unsupported-layout'], ['update-in-progress', 'update-in-progress'],
  ['already-current', 'already-current'], ['checksum-mismatch', 'checksum-mismatch'],
  ['download failed: HTTP 503', 'download-failed'], ['download exceeds expected size', 'size-mismatch'],
  ['size-mismatch', 'size-mismatch'], ['download-failed', 'download-failed'],
  ['terminated', 'download-interrupted'], ['ECONNRESET', 'download-interrupted'],
  ['ETIMEDOUT', 'download-interrupted'], ['The operation was aborted', 'download-interrupted'],
  ['TypeError: terminated', 'download-interrupted'], ['fetch failed', 'download-interrupted'],
  ['helper-not-acknowledged', 'helper-not-acknowledged'],
  ['업데이트 준비를 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.', 'helper-not-acknowledged'],
  ['업데이트 준비 프로세스가 종료되었습니다 (1).', 'helper-not-acknowledged'],
  ['업데이트 시작 환경을 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.', 'helper-environment'],
  ['Invalid ZIP path', 'invalid-payload'], ['ZIP path escaped payload', 'invalid-payload'],
  ['ENOENT: missing payload', 'unknown'], ['future-error-code', 'unknown'], ['', 'unknown'],
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() { render(<I18nProvider initial="ko"><UpdateSection currentVersion="1.2.1" /></I18nProvider>); }
async function check() { await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['update.check'] }))); }
function expectMessage(role: 'alert' | 'status', reason: string, key: string) {
  const message = screen.getByRole(role).querySelector('[data-update-message]');
  // Compare shipped dictionary values, not pinned prose.
  expect(message?.textContent).toBe(getKo()[`update.reason.${key}` as keyof Dict]);
  expect(message?.textContent).toMatch(/[가-힣]/);
  if (reason) expect(message?.textContent).not.toContain(reason);
  if (role === 'alert' || key === 'unknown') {
    const details = screen.getByRole(role).querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('code')?.textContent).toBe(reason);
  }
}
it.each([...checkReasons, 'future-check-code'])('renders Korean check failure %s', async (reason) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ unavailable: reason })));
  mount(); await check();
  expectMessage('status', reason, checkReasons.includes(reason) ? reason : 'unknown');
});
it.each([...applyReasons, ...checkReasons.map((reason) => [reason, reason])])('renders Korean apply failure %s', async (reason, key) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(available)).mockResolvedValueOnce(Response.json(checkReasons.includes(reason!) ? { unavailable: reason } : { error: reason }, { status: 500 })));
  mount(); await check();
  fireEvent.click(screen.getByRole('button', { name: getKo()['update.apply'] }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['update.applyNow'] })));
  expectMessage('alert', reason!, key!);
});
it('localizes an apply transport exception', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(available)).mockRejectedValueOnce(new TypeError('terminated')));
  mount(); await check();
  fireEvent.click(screen.getByRole('button', { name: getKo()['update.apply'] }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['update.applyNow'] })));
  expectMessage('alert', 'terminated', 'download-interrupted');
});
