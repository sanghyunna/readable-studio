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
let templates: Array<typeof template & { templateType?: 'report' | 'website' }>;
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
it('shows user templates with two entries into the same wizard', async () => {
  hub();
  expect(await screen.findByText('Sample deck')).toBeTruthy();
  expect(screen.getByText('직접 추가')).toBeTruthy();
  expect(screen.getByTestId('hub-template-carousel-rail').lastElementChild?.textContent).toContain('템플릿 추가');
  fireEvent.click(screen.getByTestId('user-deck-add'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '템플릿 업로드하기' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
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
it('files user reports and websites under their matching tabs and resets tab scrolling', async () => {
  templates = [
    template,
    { ...template, id: 'user-report', name: 'User report', templateType: 'report' },
    { ...template, id: 'user-web', name: 'User website', templateType: 'website' },
  ];
  hub();
  await screen.findByText('Sample deck');
  expect(screen.queryByText('User report')).toBeNull();
  const rail = screen.getByTestId('hub-template-carousel-rail');
  rail.scrollLeft = 500;
  fireEvent.click(screen.getAllByTestId('hub-template-carousel-tab').find((node) => node.getAttribute('data-tab-id') === 'report')!);
  expect(screen.getByText('User report')).toBeTruthy();
  expect(screen.queryByText('Sample deck')).toBeNull();
  expect(rail.scrollLeft).toBe(0);
  fireEvent.click(screen.getAllByTestId('hub-template-carousel-tab').find((node) => node.getAttribute('data-tab-id') === 'prototype')!);
  expect(screen.getByText('User website')).toBeTruthy();
});
it('does not upload a ZIP until the user continues from the file step', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.click(screen.getByTestId('user-deck-add'));
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'deck.zip')] } });
  expect(await screen.findByText('deck.zip')).toBeTruthy();
  expect(calls.some((call) => call.url.includes('/analyse'))).toBe(false);
});
it('rejects non-ZIP files in the wizard', async () => {
  hub();
  await screen.findByText('Sample deck');
  fireEvent.click(screen.getByTestId('user-deck-add'));
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['html'], 'page.html')] } });
  expect(screen.getByRole('alert')).toBeTruthy();
});
it('adds every template saved from a bundle, opens the first one’s tab and closes the wizard once', async () => {
  // The first is a report, the second a deck saved later (finalize stamps importedAt).
  const saved = [
    null,
    { name: 'Bundle first', type: 'report', importedAt: '2026-10-28T10:00:00.000Z' },
    { name: 'Bundle second', type: 'deck', importedAt: '2026-10-28T10:00:05.000Z' },
  ] as const;
  const child = (n: 1 | 2) => ({
    kind: 'single', sessionId: `child-${n}`, bundleId: 'bundle-1', expiresAt: '2099-01-01T00:00:00Z',
    originalFileName: `t${n}.zip`, prompt: { file: 'PROMPT.md' }, suggestedName: saved[n].name, suggestedCoverPageId: 'p0',
    detectedType: saved[n].type, detection: { type: saved[n].type, confidence: 'high', ambiguous: false, signals: [] },
    pages: [{ id: 'p0', file: 'index.html', previewUrl: '/x', thumbnailUrl: '/y', thumbnail: { status: 'ready', source: null, updatedAt: '' } }],
  });
  // jsdom has no layout: give each card a distinct position so the rail's scroll target is visible.
  const positions: Record<string, number> = { 'user-sample': 0, 'user-bundle-1': 240, 'user-bundle-2': 480 };
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return positions[this.dataset.pluginId ?? ''] ?? 0;
  });
  hub();
  await screen.findByText('Sample deck');
  const list = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (!String(url).startsWith('/api/design-template-uploads/')) return list(url, init);
    calls.push({ url: String(url), init });
    const n = /child-(\d)\/finalize$/.exec(String(url))?.[1] as '1' | '2' | undefined;
    return { ok: true, status: 201, json: async () => n
      ? { template: { ...template, id: `user-bundle-${n}`, name: saved[n].name, templateType: saved[n].type, mode: saved[n].type, importedAt: saved[n].importedAt } }
      : { ok: true, cancelledSessionIds: [] } } as Response;
  });
  fireEvent.click(screen.getByTestId('user-deck-add'));
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'pack.zip')] } });
  await screen.findByText('pack.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  upload.responseText = JSON.stringify({
    kind: 'bundle', bundleId: 'bundle-1', expiresAt: '2099-01-01T00:00:00Z', originalFileName: 'pack.zip',
    templates: [
      { index: 0, entryName: 'first.zip', ok: true, analysis: child(1) },
      { index: 1, entryName: 'second.zip', ok: true, analysis: child(2) },
    ],
  });
  upload.status = 201;
  await act(async () => { upload.onload(); });
  for (const primary of ['다음', '저장 후 다음', '다음', '완료', '완료']) {
    fireEvent.click(screen.getByRole('button', { name: primary }));
    await act(async () => {});
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  // The first saved template's tab (report) opened and the rail scrolled to its card.
  expect(screen.getByText('Bundle first')).toBeTruthy();
  expect(screen.queryByText('Bundle second')).toBeNull();
  expect(screen.queryByText('Sample deck')).toBeNull();
  const rail = screen.getByTestId('hub-template-carousel-rail');
  expect(rail.scrollLeft).toBe(240);
  // Both were added: the deck one sits in the deck tab.
  fireEvent.click(screen.getAllByTestId('hub-template-carousel-tab').find((node) => node.getAttribute('data-tab-id') === 'deck')!);
  expect(screen.getByText('Bundle second')).toBeTruthy();
  expect(screen.getByText('Sample deck')).toBeTruthy();
});

it('keeps the rail at the far left after cards load until the user scrolls', async () => {
  hub();
  await screen.findByText('Sample deck');
  const rail = screen.getByTestId('hub-template-carousel-rail');
  // Something (focus, snap, layout) scrolls the freshly populated rail to its end.
  rail.scrollLeft = 500;
  fireEvent.scroll(rail);
  expect(rail.scrollLeft).toBe(0);
  // A real user gesture releases the pin.
  fireEvent.wheel(rail, { deltaX: 120 });
  rail.scrollLeft = 300;
  fireEvent.scroll(rail);
  expect(rail.scrollLeft).toBe(300);
});
