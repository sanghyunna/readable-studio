// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { hostAvailable, hostPick, localPick } = vi.hoisted(() => ({ hostAvailable: vi.fn(), hostPick: vi.fn(), localPick: vi.fn() }));
vi.mock('@readable-studio/host', () => ({ isReadableStudioHostAvailable: hostAvailable, pickAndImportHostProject: hostPick }));
vi.mock('../../src/state/projects', () => ({ pickLocalFolderPath: localPick }));
import { useOpenFolderImport } from '../../src/components/useOpenFolderImport';
import { Toast } from '../../src/components/Toast';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function Harness({ failure }: { failure: unknown }) {
  const importer = useOpenFolderImport({ onImportFolder: () => { throw failure; }, onImportFolderResponse: () => undefined });
  return <><button onClick={() => void importer.openFolder()}>Import</button>{importer.error && <Toast ttlMs={0} role="alert" message={importer.error.message} details={importer.error.details} />}</>;
}
describe('folder import Korean errors', () => {
  it.each(['web-error', 'web-non-error', 'host-result', 'host-thrown'] as const)('%s keeps technical errors secondary', async (mode) => {
    const raw = 'Failed to import folder';
    hostAvailable.mockReturnValue(mode.startsWith('host'));
    localPick.mockResolvedValue('/project');
    if (mode === 'host-thrown') hostPick.mockRejectedValue(new Error(raw));
    else hostPick.mockResolvedValue({ ok: false, reason: raw, details: { error: { message: 'EACCES', details: { reason: '/project' } } } });
    render(<I18nProvider initial="ko"><Harness failure={mode === 'web-non-error' ? null : new Error(raw)} /></I18nProvider>);
    await act(async () => { fireEvent.click(screen.getByText('Import')); });
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.readable-toast-message')?.textContent).toBe(getKo()['hubImport.folderFailed']);
    expect(alert.querySelector('.readable-toast-message')?.textContent).not.toBe(getEn()['hubImport.folderFailed']);
    expect(alert.querySelector('.readable-toast-message')?.textContent).not.toContain(raw);
    if (mode !== 'web-non-error') expect(alert.querySelector('.readable-toast-details')?.textContent).toContain(raw);
    if (mode === 'host-result') expect(alert.querySelector('.readable-toast-details')?.textContent).toContain('EACCES (/project)');
  });
});
