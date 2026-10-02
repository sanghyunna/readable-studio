// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import { useClaudeZipImport } from '../../src/components/useClaudeZipImport';
import { Toast } from '../../src/components/Toast';
import type { ImportClaudeDesignHandler } from '../../src/components/project-create';

afterEach(cleanup);
function Harness({ onImport }: { onImport: ImportClaudeDesignHandler }) {
  const importer = useClaudeZipImport({ onImportClaudeDesign: onImport });
  return <>
    <input type="file" aria-label="ZIP" onChange={importer.handleChange} />
    {importer.error && <Toast role="alert" ttlMs={0} message={importer.error.message} details={importer.error.details} />}
  </>;
}

describe('Claude ZIP import localized error surface', () => {
  it('does not mislabel a connection failure as an invalid ZIP', async () => {
    render(<I18nProvider initial="ko"><Harness onImport={() => { throw new Error('Network request failed'); }} /></I18nProvider>);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('ZIP'), { target: { files: [new File(['zip'], 'design.zip')] } });
    });
    expect(screen.getByRole('alert').querySelector('.readable-toast-message')?.textContent).toBe(getKo()['hubImport.claudeZipFailed']);
    expect(screen.getByRole('alert').querySelector('.readable-toast-details')?.textContent).toBe('Network request failed');
  });

  const raw = 'Error: invalid zip: missing central directory';
  it.each(['returned', 'thrown'] as const)('renders Korean guidance for a %s failure and keeps raw error secondary', async (mode) => {
    const onImport: ImportClaudeDesignHandler = () => {
      if (mode === 'thrown') throw new Error(raw);
      return { ok: false, message: raw, details: 'parser: central directory missing' };
    };
    render(<I18nProvider initial="ko"><Harness onImport={onImport} /></I18nProvider>);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('ZIP'), { target: { files: [new File(['invalid'], 'invalid.zip')] } });
    });
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.readable-toast-message')?.textContent).toBe(getKo()['hubImport.claudeZipInvalid']);
    expect(alert.querySelector('.readable-toast-message')?.textContent).not.toBe(getEn()['hubImport.claudeZipInvalid']);
    expect(alert.querySelector('.readable-toast-message')?.textContent).not.toContain(raw);
    expect(alert.querySelector('.readable-toast-details')?.textContent).toContain(raw);
  });
});
