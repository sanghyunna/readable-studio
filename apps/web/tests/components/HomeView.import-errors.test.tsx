// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
describe('Home template failure headline', () => {
  it.each(['error', 'non-error', 'false'] as const)('localizes a %s creation failure', async (mode) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plugins: [] }))));
    const raw = 'Failed to create project from template';
    await act(async () => {
      render(<I18nProvider initial="ko"><HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} onViewAllProjects={() => undefined}
        templates={[{ id: 'saved', name: 'Saved', createdAt: 0, files: [] }]}
        projectImportHandlers={{ onCreateFromTemplate: () => { if (mode === 'false') return false; throw mode === 'error' ? new Error(raw) : null; } }} /></I18nProvider>);
    });
    fireEvent.click(screen.getByRole('button', { name: getKo()['homeHero.addMenu'] }));
    fireEvent.mouseEnter(screen.getByTestId('composer-plus-templates'));
    await act(async () => { fireEvent.click(screen.getByTestId('composer-plus-template-saved')); });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(getKo()['hubImport.templateCreateFailed']);
    expect(alert.textContent).not.toContain(getEn()['hubImport.templateCreateFailed']);
    expect(alert.textContent).not.toContain(raw);
  });
});
