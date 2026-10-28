// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemplateUploadWizard } from '../../src/components/home-hero/TemplateUploadWizard';
import { I18nProvider } from '../../src/i18n';

const analysis = {
  kind: 'single', sessionId: 'session-1', expiresAt: '2099-01-01T00:00:00Z',
  originalFileName: 'kit.zip', prompt: { file: 'PROMPT.md' },
  suggestedName: 'My kit', suggestedCoverPageId: 'p0',
  detectedType: 'report',
  detection: { type: 'report', confidence: 'high', ambiguous: false, signals: ['report:@page portrait A4'] },
  pages: Array.from({ length: 51 }, (_, index) => ({
    id: `p${index}`, file: `kit/page-${index}.html`,
    previewUrl: `/api/design-template-uploads/session-1/pages/kit/page-${index}.html`,
    thumbnailUrl: `/api/design-template-uploads/session-1/thumbnails/p${index}`,
    thumbnail: { status: 'failed', source: null, updatedAt: '' },
    viewport: index === 0 ? { width: 1280, height: 720 } : { width: 900, height: 1200 },
  })),
};
let calls: Array<{ url: string; init?: RequestInit }>;
let xhr: { onload: () => void; responseText: string; status: number };
function stubAnalyse(body: unknown, status = 201, sendLoads = true) {
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {};
    status = status;
    responseText = JSON.stringify(body);
    onload = () => {};
    constructor() { xhr = this; }
    open() {}
    send() { if (sendLoads) this.onload(); }
    abort() {}
  });
}
beforeEach(() => {
  calls = [];
  stubAnalyse(analysis);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => init?.method === 'POST'
      ? { template: { id: 'user-kit', name: 'report-kit-8b704615', displayName: { en: 'Report kit' }, templateType: 'report', mode: 'report' } }
      : analysis };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function wizard() {
  const onComplete = vi.fn();
  const onClose = vi.fn();
  render(<I18nProvider initial="ko"><TemplateUploadWizard onComplete={onComplete} onClose={onClose} /></I18nProvider>);
  return { onComplete, onClose };
}
async function analyse() {
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'kit.zip')] } });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await screen.findByLabelText('템플릿 이름');
}
it('starts on the file step of three and offers no type choice', () => {
  wizard();
  expect(screen.getByText('3단계 중 1단계')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'ZIP 파일 업로드' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '웹사이트' })).toBeNull();
  expect(screen.queryByRole('button', { name: '보고서' })).toBeNull();
  expect(screen.getAllByRole('listitem').map((node) => node.textContent))
    .toEqual(['1ZIP 파일 업로드', '2페이지와 표지', '3최종 확인']);
});
it('lists every nested HTML, shows the detected type and finalizes without a type at completion', async () => {
  const { onComplete } = wizard();
  await analyse();
  expect(screen.getByText('3단계 중 2단계')).toBeTruthy();
  expect(screen.getAllByTestId('template-upload-page')).toHaveLength(51);
  expect(document.querySelectorAll('iframe')).toHaveLength(0);
  // The bundle progress live region stays mounted but says nothing for a single ZIP.
  expect(screen.getByTestId('template-upload-progress').textContent).toBe('');
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: 'Report kit' } });
  fireEvent.click(screen.getByRole('button', { name: /kit\/page-50.html/ }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(calls.some((call) => call.url.endsWith('/finalize'))).toBe(false);
  expect(screen.getByText('3단계 중 3단계')).toBeTruthy();
  expect(screen.getByText('감지된 유형')).toBeTruthy();
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('보고서');
  expect(screen.queryByRole('button', { name: '변경' })).toBeNull();
  expect(screen.queryByRole('button', { name: '건너뛰기' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await act(async () => {});
  expect(JSON.parse(calls.find((call) => call.url.endsWith('/finalize'))!.init!.body as string))
    .toEqual({ name: 'Report kit', coverPageId: 'p50' });
  expect(onComplete).toHaveBeenCalledOnce();
  expect(onComplete).toHaveBeenCalledWith([expect.objectContaining({ templateType: 'report' })]);
  expect(screen.queryByTestId('template-upload-summary')).toBeNull();
});
it('shows deck when an older daemon sends no detection', async () => {
  const { detectedType: _type, detection: _detection, kind: _kind, ...legacy } = analysis;
  stubAnalyse(legacy);
  wizard();
  await analyse();
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('슬라이드덱');
  expect(screen.queryByRole('button', { name: '변경' })).toBeNull();
});
it('offers a radio change control only for an ambiguous detection and sends the chosen override', async () => {
  stubAnalyse({ ...analysis, detectedType: 'deck', detection: { type: 'deck', confidence: 'low', ambiguous: true, signals: [] } });
  wizard();
  await analyse();
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('슬라이드덱');
  expect(screen.getByText('유형을 확실히 판단하지 못했어요. 확인하고 필요하면 바꿔 주세요.')).toBeTruthy();
  expect(screen.queryByRole('radiogroup')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '변경' }));
  const group = screen.getByRole('radiogroup', { name: '감지된 유형' });
  const radios = within(group).getAllByRole('radio');
  expect(radios.map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]))
    .toEqual([['슬라이드덱', 'true'], ['보고서', 'false']]);
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.click(within(group).getByRole('radio', { name: '보고서' }));
  expect(within(group).getByRole('radio', { name: '보고서' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('status').textContent).toBe('변경했어요. 보고서 목록에 추가돼요.');
  expect(screen.getByTestId('template-upload-detected-type').textContent).toBe('보고서');
  fireEvent.keyDown(within(group).getByRole('radio', { name: '보고서' }), { key: 'ArrowLeft' });
  expect(within(group).getByRole('radio', { name: '슬라이드덱' }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(within(group).getByRole('radio', { name: '슬라이드덱' }));
  fireEvent.click(within(group).getByRole('radio', { name: '보고서' }));
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await act(async () => {});
  expect(JSON.parse(calls.find((call) => call.url.endsWith('/finalize'))!.init!.body as string))
    .toEqual({ type: 'report', name: 'My kit', coverPageId: 'p0' });
});
it('shows the server reason under the localized analyse error', async () => {
  stubAnalyse({ error: { code: 'BAD_REQUEST', message: 'bundle contains 21 templates; the limit is 20' } }, 400);
  wizard();
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'kit.zip')] } });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('ZIP 파일을 읽지 못했어요.');
  expect(alert.textContent).toContain('bundle contains 21 templates; the limit is 20');
});
it('cancels the analysed session on Escape', async () => {
  const { onClose } = wizard();
  await analyse();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await act(async () => {});
  expect(calls).toContainEqual({ url: '/api/design-template-uploads/session-1', init: expect.objectContaining({ method: 'DELETE' }) });
  expect(onClose).toHaveBeenCalledOnce();
});
it('requires a nonblank name and keeps the session after a finalize error', async () => {
  wizard();
  await analyse();
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: '  ' } });
  expect((screen.getByRole('button', { name: '다음' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: 'Retry kit' } });
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'INTERNAL_ERROR' }) } as Response);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await screen.findByRole('alert');
  expect(within(screen.getByRole('dialog')).getByText('Retry kit')).toBeTruthy();
  expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
});
it('deletes a session whose analysis arrives after cancellation', async () => {
  stubAnalyse(analysis, 201, false);
  wizard();
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'kit.zip')] } });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await act(async () => { xhr.onload(); });
  expect(calls).toContainEqual({ url: '/api/design-template-uploads/session-1', init: expect.objectContaining({ method: 'DELETE' }) });
});
it('accepts drop, retains analysed pages when going back to the file step, and traps keyboard focus', async () => {
  wizard();
  fireEvent.drop(screen.getByText('ZIP 파일을 여기에 놓으세요').parentElement!, {
    dataTransfer: { files: [new File(['zip'], 'kit.zip')] },
  });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await screen.findByLabelText('템플릿 이름');
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: 'Kept name' } });
  fireEvent.click(screen.getByRole('button', { name: '이전' }));
  expect(screen.getByText('3단계 중 1단계')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(screen.getAllByTestId('template-upload-page')).toHaveLength(51);
  expect((screen.getByLabelText('템플릿 이름') as HTMLInputElement).value).toBe('Kept name');
  const next = screen.getByRole('button', { name: '다음' });
  next.focus();
  fireEvent.keyDown(next, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '닫기' }));
});
it('mounts fallback frames only for visible page thumbnails', async () => {
  const observations: Array<{ callback: IntersectionObserverCallback; node: Element }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(node: Element) { observations.push({ callback: this.callback, node }); }
    disconnect() {}
  });
  wizard();
  await analyse();
  expect(observations).toHaveLength(51);
  const first = observations[0]!;
  act(() => first.callback(
    [{ target: first.node, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  expect(document.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('kit/page-0.html').getAttribute('sandbox')).toBe('');
  expect(screen.getByTitle('kit/page-0.html').getAttribute('width')).toBe('1280');
  expect(screen.getByTitle('kit/page-0.html').getAttribute('height')).toBe('720');
  expect((first.node as HTMLElement).style.aspectRatio).toBe('1280 / 720');
  const second = observations[1]!;
  act(() => second.callback(
    [{ target: second.node, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  expect(screen.getByTitle('kit/page-1.html').getAttribute('width')).toBe('900');
  expect(screen.getByTitle('kit/page-1.html').getAttribute('height')).toBe('1200');
  expect((second.node as HTMLElement).style.aspectRatio).toBe('900 / 1200');
  act(() => first.callback(
    [{ target: first.node, isIntersecting: false } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  expect(document.querySelectorAll('iframe')).toHaveLength(1);
});
it('deletes the previous session before replacing a ZIP', async () => {
  wizard();
  await analyse();
  fireEvent.click(screen.getByRole('button', { name: '이전' }));
  fireEvent.change(screen.getByTestId('template-upload-file'), {
    target: { files: [new File(['another zip'], 'replacement.zip')] },
  });
  await screen.findByText('replacement.zip');
  expect(calls).toContainEqual({ url: '/api/design-template-uploads/session-1', init: expect.objectContaining({ method: 'DELETE' }) });
});
it('keeps the session and retries finalize after a lost response instead of expiring on the next preview poll', async () => {
  const pending = {
    ...analysis,
    pages: analysis.pages.map((page, index) => index === 0
      ? { ...page, thumbnail: { status: 'pending', source: null, updatedAt: '' } } : page),
  };
  stubAnalyse(pending);
  const pollers: Array<() => unknown> = [];
  vi.spyOn(window, 'setInterval').mockImplementation(((callback: () => unknown) => {
    pollers.push(callback);
    return pollers.length;
  }) as unknown as typeof window.setInterval);
  const { onComplete } = wizard();
  await analyse();
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('response lost'));
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await screen.findByRole('alert');
  // The server already finalized, so the session GET now reports 404.
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  await act(async () => { for (const poll of pollers) await poll(); });
  expect(screen.queryByLabelText('템플릿 이름')).toBeNull();
  expect(screen.getByRole('button', { name: '완료' })).toBeTruthy();
  vi.mocked(fetch).mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ template: { id: 'user-kit', name: 'my-kit-8b704615', displayName: { en: 'My kit' }, templateType: 'report', mode: 'report' } }),
  } as Response);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await act(async () => {});
  expect(onComplete).toHaveBeenCalledOnce();
});
