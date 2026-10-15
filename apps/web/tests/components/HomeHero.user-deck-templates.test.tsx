// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeHero } from '../../src/components/HomeHero';
import { I18nProvider } from '../../src/i18n';

const template = {
  id: 'user-sample', name: 'Sample deck', description: 'A personal deck',
  source: 'user', userImported: true, mode: 'deck',
  cover: 'slides/Opening page.htm',
  thumbnail: { status: 'pending', source: null, updatedAt: '2026-10-14' },
};
let visible: IntersectionObserverCallback;
let templates: typeof template[];
let calls: Array<{ url: string; init?: RequestInit }>;
let upload: { onload: () => void; responseText: string; status: number; upload: { onprogress: (event: ProgressEvent) => void } };
beforeEach(() => {
  templates = [template];
  calls = [];
  window.localStorage.clear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { visible = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('XMLHttpRequest', class {
    upload = { onprogress: () => {} };
    onload = () => {};
    responseText = '';
    status = 200;
    constructor() { upload = this; }
    open() {}
    send() {}
    abort() {}
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'PATCH') {
      templates = [{ ...template, name: JSON.parse(init.body as string).name }];
      return { ok: true, json: async () => ({ template: templates[0] }) };
    }
    if (init?.method === 'DELETE') {
      templates = [];
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ designTemplates: templates }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function hub() {
  const pick = vi.fn();
  render(<I18nProvider initial="ko"><HomeHero
    surface="hub" prompt="" onPromptChange={() => {}} onSubmit={() => {}}
    activePluginTitle={null} activeChipId={null} onClearActivePlugin={() => {}}
    pluginOptions={[]} pluginsLoading={false} pendingPluginId={null} pendingChipId={null}
    onPickPlugin={() => {}} onPickUserDeckTemplate={pick} onPickChip={() => {}}
    onAddFiles={() => {}} contextItemCount={0} error={null}
  /></I18nProvider>);
  return pick;
}
it('shows user decks with a badge and trailing ZIP importer', async () => {
  hub();
  expect(await screen.findByText('Sample deck')).toBeTruthy();
  expect(screen.getByText('직접 추가')).toBeTruthy();
  expect(screen.getByTestId('user-deck-zip-input').getAttribute('accept')).toBe('.zip');
  expect(screen.getByTestId('hub-template-carousel-rail').lastElementChild?.textContent).toContain('템플릿 추가');
});
it('mounts the pending live preview only when visible', async () => {
  hub();
  await screen.findByText('Sample deck');
  expect(document.querySelector('iframe')).toBeNull();
  act(() => visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(screen.getByTitle('Sample deck preview').getAttribute('src')).toBe('/api/design-templates/user-sample/pages/slides/Opening%20page.htm');
});
it('renames through PATCH and updates the title', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.click(screen.getByLabelText('템플릿 관리'));
  fireEvent.click(screen.getByRole('menuitem', { name: '이름 변경' }));
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: 'Renamed deck' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByText('Renamed deck')).toBeTruthy();
  expect(calls.find((call) => call.init?.method === 'PATCH')?.init?.body).toBe('{"name":"Renamed deck"}');
});
it('requires confirmation before DELETE then removes the card', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.click(screen.getByLabelText('템플릿 관리'));
  fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
  expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '삭제' }));
  await screen.findByTestId('user-deck-add');
  await act(async () => {});
  expect(screen.queryByText('Sample deck')).toBeNull();
});
it('passes the user template DTO through the skill selection callback without plugin application', async () => {
  const pick = hub();
  await screen.findByText('Sample deck');
  fireEvent.click(screen.getByTestId('hub-template-card'));
  expect(pick).toHaveBeenCalledWith(template);
});
it('adds the imported card and reports upload progress', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.change(screen.getByTestId('user-deck-zip-input'), { target: { files: [new File(['zip'], 'deck.zip')] } });
  act(() => upload.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent));
  expect(screen.getByTestId('user-deck-add').textContent).toContain('50%');
  act(() => {
    upload.responseText = JSON.stringify({ template: { ...template, id: 'user-new', name: 'Imported deck' } });
    upload.onload();
  });
  expect(await screen.findByText('Imported deck')).toBeTruthy();
});
it('shows the daemon message for import 400 errors', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.change(screen.getByTestId('user-deck-zip-input'), { target: { files: [new File(['zip'], 'deck.zip')] } });
  act(() => {
    upload.status = 400;
    upload.responseText = JSON.stringify({ error: 'PROMPT.md is required' });
    upload.onload();
  });
  expect(screen.getByRole('alert').textContent).toContain('PROMPT.md is required');
});
