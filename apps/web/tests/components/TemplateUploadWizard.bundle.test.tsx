// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemplateUploadWizard } from '../../src/components/home-hero/TemplateUploadWizard';
import { I18nProvider } from '../../src/i18n';

const ROOT = '/api/design-template-uploads';
type Detection = { type: 'deck' | 'report'; confidence: 'high' | 'medium' | 'low'; ambiguous: boolean; signals: string[] };
const deck: Detection = { type: 'deck', confidence: 'high', ambiguous: false, signals: ['deck:slide-group x12'] };
const ambiguousReport: Detection = { type: 'report', confidence: 'low', ambiguous: true, signals: [] };
let thumbnail = 'ready';
function child(n: number, detection: Detection) {
  const sessionId = `child-${n}`;
  return {
    kind: 'single', sessionId, bundleId: 'bundle-1', expiresAt: '2099-01-01T00:00:00Z',
    originalFileName: `t${n}.zip`, prompt: { file: 'PROMPT.md' },
    suggestedName: `Template ${n}`, suggestedCoverPageId: 'p0',
    detectedType: detection.type, detection,
    pages: [0, 1].map((page) => ({
      id: `p${page}`, file: `t${n}/page-${page}.html`,
      previewUrl: `${ROOT}/${sessionId}/pages/t${n}/page-${page}.html`,
      thumbnailUrl: `${ROOT}/${sessionId}/thumbnails/p${page}`,
      thumbnail: { status: thumbnail, source: null, updatedAt: '' },
      viewport: { width: 1920, height: 1080 },
    })),
  };
}
function bundle() {
  // Deliberately out of order: the wizard walks templates in `index` order.
  return {
    kind: 'bundle', bundleId: 'bundle-1', expiresAt: '2099-01-01T00:00:00Z', originalFileName: 'pack.zip',
    templates: [
      { index: 2, entryName: 'c-report.zip', ok: true, analysis: child(2, ambiguousReport) },
      { index: 0, entryName: 'a-deck.zip', ok: true, analysis: child(1, deck) },
      { index: 1, entryName: 'b-broken.zip', ok: false, reason: 'template zip must contain PROMPT.md at its root' },
      { index: 3, entryName: 'd-deck.zip', ok: true, analysis: child(3, deck) },
    ],
  };
}
let calls: Array<{ url: string; method: string; body?: unknown }>;
let finalizeStatus: Record<string, number[]>;
let getStatus: number;
let timers: Map<number, () => unknown>;
let analyseBody: unknown;
// When set, the analyse response waits for an explicit `xhr.onload()`.
let deferred: boolean;
let xhr: { onload: () => void };
let bundleDeleteOk: boolean;
beforeEach(() => {
  calls = [];
  finalizeStatus = {};
  getStatus = 200;
  thumbnail = 'ready';
  timers = new Map();
  analyseBody = undefined;
  deferred = false;
  bundleDeleteOk = true;
  let timerId = 0;
  vi.spyOn(window, 'setInterval').mockImplementation(((callback: () => unknown) => {
    timers.set(++timerId, callback);
    return timerId;
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, 'clearInterval').mockImplementation(((id: number) => { timers.delete(id); }) as typeof window.clearInterval);
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {};
    status = 201;
    responseText = JSON.stringify(analyseBody ?? bundle());
    onload = () => {};
    constructor() { xhr = this; }
    open() {}
    send() { if (!deferred) this.onload(); }
    abort() {}
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const match = /\/(child-\d)(\/finalize)?$/.exec(url);
    if (method === 'POST' && match) {
      const status = finalizeStatus[match[1]!]?.shift() ?? 201;
      if (status !== 201) return { ok: false, status, json: async () => ({ error: { code: 'X', message: 'nope' } }) };
      const n = match[1]!.slice('child-'.length);
      return { ok: true, status, json: async () => ({
        template: { id: `user-${n}`, name: `slug-${n}-8b704615`, displayName: { en: body.name }, templateType: body.type ?? 'deck', mode: body.type ?? 'deck' },
      }) };
    }
    if (method === 'DELETE' && url.includes('/bundles/')) {
      if (!bundleDeleteOk) throw new TypeError('offline');
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelledSessionIds: [] }) };
    }
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (getStatus !== 200) return { ok: false, status: getStatus, json: async () => ({}) };
    const n = Number(match![1]!.slice('child-'.length));
    return { ok: true, status: 200, json: async () => child(n, n === 2 ? ambiguousReport : deck) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function wizard(locale: 'ko' | 'en' = 'ko') {
  const onComplete = vi.fn();
  const onClose = vi.fn();
  render(<I18nProvider initial={locale}><TemplateUploadWizard onComplete={onComplete} onClose={onClose} /></I18nProvider>);
  return { onComplete, onClose };
}
async function analyse(next = '다음') {
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'pack.zip')] } });
  await screen.findByText('pack.zip');
  fireEvent.click(screen.getByRole('button', { name: next }));
  await screen.findByTestId('template-upload-progress');
}
const nameField = () => screen.getByLabelText('템플릿 이름') as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const finalizes = () => calls.filter((call) => call.method === 'POST');
async function click(name: string | RegExp) {
  fireEvent.click(button(name));
  await act(async () => {});
}

it('walks every valid template with an n/N announcement and saves each one as soon as it is confirmed', async () => {
  const { onComplete, onClose } = wizard();
  await analyse();
  const progress = screen.getByTestId('template-upload-progress');
  expect(progress.getAttribute('aria-live')).toBe('polite');
  expect(progress.textContent).toContain('템플릿 3개 중 1번째');
  expect(progress.textContent).toContain('a-deck.zip');
  expect(nameField().value).toBe('Template 1');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  fireEvent.change(nameField(), { target: { value: 'Deck A' } });
  fireEvent.click(screen.getByRole('button', { name: /t1\/page-1.html/ }));
  await click('다음');
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('슬라이드덱');
  expect(screen.queryByRole('button', { name: '변경' })).toBeNull();
  expect(screen.queryByRole('button', { name: '완료' })).toBeNull();
  await click('저장 후 다음');
  expect(finalizes()).toEqual([{ url: `${ROOT}/child-1/finalize`, method: 'POST', body: { name: 'Deck A', coverPageId: 'p1' } }]);

  expect(screen.getByTestId('template-upload-progress').textContent).toContain('템플릿 3개 중 2번째');
  expect(screen.getByText('3단계 중 2단계')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  expect(screen.queryByRole('button', { name: '이전' })).toBeNull();
  expect(nameField().value).toBe('Template 2');
  fireEvent.change(nameField(), { target: { value: '   ' } });
  expect(button('다음').disabled).toBe(true);
  fireEvent.change(nameField(), { target: { value: 'Report C' } });
  await click('다음');
  await click('이전');
  expect(nameField().value).toBe('Report C');
  await click('다음');
  fireEvent.click(screen.getByRole('button', { name: '변경' }));
  fireEvent.click(screen.getByRole('radio', { name: '슬라이드덱' }));
  expect(screen.getByRole('status').textContent).toBe('변경했어요. 슬라이드덱 목록에 추가돼요.');
  await click('저장 후 다음');
  expect(finalizes()[1]).toEqual({ url: `${ROOT}/child-2/finalize`, method: 'POST', body: { type: 'deck', name: 'Report C', coverPageId: 'p0' } });

  expect(screen.getByTestId('template-upload-progress').textContent).toContain('템플릿 3개 중 3번째');
  expect(screen.queryByRole('button', { name: '변경' })).toBeNull();
  await click('다음');
  expect(screen.queryByRole('button', { name: '저장 후 다음' })).toBeNull();
  await click('완료');
  expect(finalizes()).toHaveLength(3);
  // The override chosen for template 2 stays with template 2.
  expect(finalizes()[2]).toEqual({ url: `${ROOT}/child-3/finalize`, method: 'POST', body: { name: 'Template 3', coverPageId: 'p0' } });

  const summary = screen.getByTestId('template-upload-summary');
  expect(screen.queryByTestId('template-upload-progress')).toBeNull();
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('업로드 결과');
  expect(summary.textContent).toContain('저장됨 3개');
  expect(summary.textContent).toContain('Deck A');
  expect(summary.textContent).toContain('Report C');
  expect(summary.textContent).toContain('Template 3');
  // The daemon returns the id slug as `name`; the summary must show the display name.
  expect(summary.textContent).not.toContain('slug-');
  expect(summary.textContent).toContain('읽을 수 없음 1개');
  expect(summary.textContent).toContain('b-broken.zip');
  expect(summary.textContent).toContain('template zip must contain PROMPT.md at its root');
  expect(onComplete).not.toHaveBeenCalled();
  await click('완료');
  expect(calls.at(-1)).toEqual({ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined });
  expect(onComplete).toHaveBeenCalledOnce();
  expect(onComplete.mock.calls[0]![0].map((template: { id: string }) => template.id)).toEqual(['user-1', 'user-2', 'user-3']);
  expect(onClose).not.toHaveBeenCalled();
});

it('skips a template by deleting only its child session', async () => {
  wizard();
  await analyse();
  button('건너뛰기').focus();
  await click('건너뛰기');
  expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ url: `${ROOT}/child-1`, method: 'DELETE', body: undefined }]);
  expect(screen.getByTestId('template-upload-progress').textContent).toContain('템플릿 3개 중 2번째');
  // Only the index changed (step 2 to step 2): the heading still takes focus.
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  await click('다음');
  await click('건너뛰기');
  await click('건너뛰기');
  expect(finalizes()).toHaveLength(0);
  const summary = screen.getByTestId('template-upload-summary');
  expect(summary.textContent).toContain('건너뜀 3개');
  expect(summary.textContent).toContain('a-deck.zip');
});

it('marks a failed save, moves on, and retries it from the summary with the stored selection', async () => {
  finalizeStatus = { 'child-1': [500], 'child-3': [404, 500] };
  const { onComplete } = wizard();
  await analyse();
  fireEvent.change(nameField(), { target: { value: 'Retry me' } });
  fireEvent.click(screen.getByRole('button', { name: /t1\/page-1.html/ }));
  await click('다음');
  await click('저장 후 다음');
  expect(screen.getByTestId('template-upload-progress').textContent).toContain('템플릿 3개 중 2번째');
  await click('다음');
  await click('저장 후 다음');
  await click('다음');
  await click('완료');
  const summary = screen.getByTestId('template-upload-summary');
  expect(summary.textContent).toContain('저장됨 1개');
  expect(summary.textContent).toContain('저장 실패 2개');
  expect(summary.textContent).toContain('업로드 세션이 만료됐어요.');
  const retries = within(summary).getAllByRole('button', { name: /다시 시도/ });
  expect(retries).toHaveLength(2);
  const status = within(summary).getByRole('status');
  expect(status.textContent).toBe('');
  retries[0]!.focus();
  fireEvent.click(retries[0]!);
  await act(async () => {});
  expect(finalizes().at(-1)).toEqual({ url: `${ROOT}/child-1/finalize`, method: 'POST', body: { name: 'Retry me', coverPageId: 'p1' } });
  expect(summary.textContent).toContain('저장됨 2개');
  expect(summary.textContent).toContain('저장 실패 1개');
  // The saved row is gone: focus moves to the remaining Retry and the outcome is announced.
  expect(status.textContent).toBe('a-deck.zip 템플릿을 저장했어요.');
  expect(document.activeElement).toBe(button('다시 시도: d-deck.zip'));
  await click('다시 시도: d-deck.zip');
  expect(status.textContent).toBe('d-deck.zip: 이 템플릿을 저장하지 못했어요.');
  expect(summary.textContent).toContain('이 템플릿을 저장하지 못했어요.');
  expect(summary.textContent).not.toContain('완료를 다시 눌러 주세요');
  expect(document.activeElement).toBe(button('다시 시도: d-deck.zip'));
  await click('다시 시도: d-deck.zip');
  expect(summary.textContent).toContain('저장됨 3개');
  expect(status.textContent).toBe('d-deck.zip 템플릿을 저장했어요.');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  await click('완료');
  // Reported in save order: the retried templates come last.
  expect(onComplete.mock.calls[0]![0].map((template: { id: string }) => template.id)).toEqual(['user-2', 'user-1', 'user-3']);
});

it('cancels the whole bundle and still reports templates that were already saved', async () => {
  const { onComplete, onClose } = wizard();
  await analyse();
  await click('다음');
  await click('저장 후 다음');
  await click('취소');
  expect(calls.at(-1)).toEqual({ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined });
  expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/child-2'))).toBe(false);
  expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ id: 'user-1' })]);
  expect(onClose).not.toHaveBeenCalled();
});

it('closes with onClose after cancelling a bundle with nothing saved, also on unmount', async () => {
  const { onComplete, onClose } = wizard();
  await analyse();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await act(async () => {});
  expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined }]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onComplete).not.toHaveBeenCalled();
  cleanup();
  calls = [];
  wizard();
  await analyse();
  cleanup();
  await act(async () => {});
  expect(calls).toEqual([{ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined }]);
});

it('keeps the first template analysis when going back to the file step and cancels the bundle when the file is replaced', async () => {
  wizard();
  await analyse();
  fireEvent.change(nameField(), { target: { value: 'Kept' } });
  await click('이전');
  expect(screen.getByText('3단계 중 1단계')).toBeTruthy();
  await click('다음');
  expect(nameField().value).toBe('Kept');
  await click('이전');
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'other.zip')] } });
  await screen.findByText('other.zip');
  expect(calls).toContainEqual({ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined });
});

it('deletes a bundle whose analysis arrives after the wizard was closed', async () => {
  deferred = true;
  const { onClose } = wizard();
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'pack.zip')] } });
  await screen.findByText('pack.zip');
  await click('다음');
  await click('닫기');
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => { xhr.onload(); });
  expect(calls).toEqual([{ url: `${ROOT}/bundles/bundle-1`, method: 'DELETE', body: undefined }]);
});

it('mounts the template progress live region before the bundle analysis fills it', async () => {
  deferred = true;
  wizard();
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'pack.zip')] } });
  await screen.findByText('pack.zip');
  await click('다음');
  // Screen readers skip a live region inserted with its text, so it must exist empty first.
  const region = screen.getByTestId('template-upload-progress');
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.textContent).toBe('');
  await act(async () => { xhr.onload(); });
  expect(screen.getByTestId('template-upload-progress')).toBe(region);
  expect(region.textContent).toContain('템플릿 3개 중 1번째');
});

it('still reports saved templates when the bundle cleanup fails, but stays open when nothing was saved', async () => {
  bundleDeleteOk = false;
  const { onComplete, onClose } = wizard();
  await analyse();
  await click('취소');
  expect(screen.getByRole('alert').textContent).toContain('연결을 확인하고 다시 시도해 주세요.');
  expect(onClose).not.toHaveBeenCalled();
  await click('다음');
  await click('저장 후 다음');
  await click('취소');
  expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ id: 'user-1' })]);
  expect(onClose).not.toHaveBeenCalled();
});

it('reports a single template finished after an expired bundle ahead of the earlier bundle saves', async () => {
  thumbnail = 'pending';
  const { onComplete } = wizard();
  await analyse();
  await click('다음');
  await click('저장 후 다음');
  getStatus = 404;
  await act(async () => { for (const poll of [...timers.values()]) await poll(); });
  expect(screen.getByText('3단계 중 1단계')).toBeTruthy();
  getStatus = 200;
  analyseBody = { ...child(9, deck), bundleId: undefined };
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'single.zip')] } });
  await screen.findByText('single.zip');
  await click('다음');
  await click('다음');
  await click('완료');
  // HomeHero selects the first template, so the one just finished leads.
  expect(onComplete.mock.calls[0]![0].map((template: { id: string }) => template.id)).toEqual(['user-9', 'user-1']);
});

it('polls only the current template session while its thumbnails are pending', async () => {
  thumbnail = 'pending';
  const { onComplete } = wizard();
  await analyse();
  const rendered = () => document.querySelectorAll(`img[src="${ROOT}/child-1/thumbnails/p0"]`);
  expect(rendered()).toHaveLength(0);
  // child-1's covers finish rendering: only that template's pages are refreshed.
  thumbnail = 'ready';
  await act(async () => { for (const poll of [...timers.values()]) await poll(); });
  thumbnail = 'pending';
  expect(calls.filter((call) => call.method === 'GET').map((call) => call.url)).toEqual([`${ROOT}/child-1`]);
  expect(rendered()).toHaveLength(1);
  await click('다음');
  await click('저장 후 다음');
  // The refresh did not overwrite the other templates' pages.
  expect(screen.getAllByTestId('template-upload-page').map((node) => node.textContent))
    .toEqual([expect.stringContaining('t2/page-0.html'), expect.stringContaining('t2/page-1.html')]);
  calls = [];
  await act(async () => { for (const poll of [...timers.values()]) await poll(); });
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ROOT}/child-2`]);
  // The bundle expired: back to the file step, keeping what was saved for the close report.
  getStatus = 404;
  await act(async () => { for (const poll of [...timers.values()]) await poll(); });
  expect(screen.getByRole('alert').textContent).toContain('업로드 세션이 만료됐어요.');
  expect(screen.getByText('3단계 중 1단계')).toBeTruthy();
  expect(screen.queryByTestId('template-upload-progress')).toBeNull();
  expect(timers.size).toBe(0);
  await click('취소');
  expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ id: 'user-1' })]);
});

it('speaks English labels for the bundle loop and summary', async () => {
  const { onComplete } = wizard('en');
  await analyse('Next');
  expect(screen.getByTestId('template-upload-progress').textContent).toContain('Template 1 of 3');
  expect(screen.getByText('Step 2 of 3')).toBeTruthy();
  await click('Skip');
  await click('Next');
  expect(screen.getByText('We could not tell the type for sure. Check it and change it if needed.')).toBeTruthy();
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('Reports');
  await click('Save & next');
  await click('Next');
  await click('Finish');
  const summary = screen.getByTestId('template-upload-summary');
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Upload results');
  expect(summary.textContent).toContain('Saved (2)');
  expect(summary.textContent).toContain('Skipped (1)');
  expect(summary.textContent).toContain('Could not be read (1)');
  await click('Done');
  expect(onComplete).toHaveBeenCalledOnce();
});
