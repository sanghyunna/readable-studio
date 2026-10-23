// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
vi.mock('../../src/analytics/provider', () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { DataImportModal } from '../../src/components/DataImportModal';

const candidate = { sourceRoot: 'D:\\Earlier', sourceData: 'D:\\Earlier\\ReadableStudioData\\namespaces\\rg\\data', projectCount: 2, modifiedAt: '2026-10-01T00:00:00Z' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function SettingsImport({ locale, onClose }: { locale: 'en' | 'ko'; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return <I18nProvider initial={locale}>
    <SettingsDialog initial={DEFAULT_CONFIG} agents={[]} daemonLive appVersionInfo={null}
      initialSection="projectLocations" onPersist={vi.fn()} onClose={onClose} onRefreshAgents={vi.fn()}
      dataImportOpen={open} onDataImport={() => setOpen(true)} />
    {open ? <DataImportModal manual onResolved={() => setOpen(false)} /> : null}
  </I18nProvider>;
}

it.each(['ko', 'en'] as const)('reopens import from project locations without declining on close (%s)', async (locale) => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return Response.json(url.includes('/api/data-import/candidates')
      ? { state: 'offered', candidates: [candidate] } : {});
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  await act(async () => {
    render(<SettingsImport locale={locale} onClose={onClose} />);
  });
  const button = screen.getByRole('button', { name: locale === 'ko' ? '이전 버전 데이터 가져오기' : 'Import data from an earlier version' });
  button.focus();
  await act(async () => { fireEvent.click(button); });
  expect(requests.filter(url => url.includes('/api/data-import/'))).toEqual(['/api/data-import/candidates?manual=1']);
  expect(screen.getByTestId('data-import-modal').textContent).toContain(candidate.sourceRoot);
  expect(screen.getByRole('dialog')).toBe(screen.getByTestId('data-import-modal'));
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
  expect(screen.queryByTestId('data-import-modal')).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(onClose).not.toHaveBeenCalled();
  expect(requests.some(url => url.includes('/api/data-import/request'))).toBe(false);
  await act(async () => { fireEvent.click(button); });
  expect(requests.filter(url => url.includes('/api/data-import/'))).toHaveLength(2);
});

it('restores the original trigger through StrictMode cleanup while the settings background is inert', async () => {
  // jsdom does not enforce inert; model the browser's refusal to focus its descendants.
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    if ((this.closest('.modal-backdrop') as HTMLElement | null)?.inert) return;
    nativeFocus.call(this, options);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/api/data-import/candidates')
    ? { state: 'offered', candidates: [candidate] } : {})));
  await act(async () => { render(<StrictMode><SettingsImport locale="ko" onClose={vi.fn()} /></StrictMode>); });
  const button = screen.getByRole('button', { name: '이전 버전 데이터 가져오기' });
  button.focus();
  await act(async () => { fireEvent.click(button); });
  expect(document.activeElement).toBe(screen.getByTestId('data-import-modal'));
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
  expect(screen.queryByTestId('data-import-modal')).toBeNull();
  expect(document.activeElement).toBe(button);
});
