// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemplateUploadWizard } from '../../src/components/home-hero/TemplateUploadWizard';
import { I18nProvider } from '../../src/i18n';

const analysis = {
  sessionId: 'session-1', expiresAt: '2099-01-01T00:00:00Z',
  originalFileName: 'kit.zip', prompt: { file: 'PROMPT.md' },
  suggestedName: 'My kit', suggestedCoverPageId: 'p0',
  pages: Array.from({ length: 51 }, (_, index) => ({
    id: `p${index}`, file: `kit/page-${index}.html`,
    previewUrl: `/api/design-template-uploads/session-1/pages/kit/page-${index}.html`,
    thumbnailUrl: `/api/design-template-uploads/session-1/thumbnails/p${index}`,
    thumbnail: { status: 'failed', source: null, updatedAt: '' },
  })),
};
let calls: Array<{ url: string; init?: RequestInit }>;
let xhr: { onload: () => void; responseText: string; status: number };
beforeEach(() => {
  calls = [];
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {};
    status = 201;
    responseText = JSON.stringify(analysis);
    onload = () => {};
    constructor() { xhr = this; }
    open() {}
    send() { this.onload(); }
    abort() {}
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => init?.method === 'POST'
      ? { template: { id: 'user-kit', name: 'Report kit', templateType: 'report', mode: 'report' } }
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
  fireEvent.click(screen.getByRole('button', { name: '보고서' }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'kit.zip')] } });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await screen.findByLabelText('템플릿 이름');
}
it('lists every nested HTML and finalizes only at completion with the selected type and cover', async () => {
  const { onComplete } = wizard();
  await analyse();
  expect(screen.getAllByTestId('template-upload-page')).toHaveLength(51);
  expect(document.querySelectorAll('iframe')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('템플릿 이름'), { target: { value: 'Report kit' } });
  fireEvent.click(screen.getByRole('button', { name: /kit\/page-50.html/ }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(calls.some((call) => call.url.endsWith('/finalize'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await act(async () => {});
  expect(JSON.parse(calls.find((call) => call.url.endsWith('/finalize'))!.init!.body as string))
    .toEqual({ type: 'report', name: 'Report kit', coverPageId: 'p50' });
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ templateType: 'report' }));
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
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {};
    status = 201;
    responseText = JSON.stringify(analysis);
    onload = () => {};
    constructor() { xhr = this; }
    open() {}
    send() {}
    abort() {}
  });
  wizard();
  fireEvent.click(screen.getByRole('button', { name: '보고서' }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.change(screen.getByTestId('template-upload-file'), { target: { files: [new File(['zip'], 'kit.zip')] } });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await act(async () => { xhr.onload(); });
  expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true);
});
it('accepts drop, retains analysed pages when changing type, and traps keyboard focus', async () => {
  wizard();
  fireEvent.click(screen.getByRole('button', { name: '슬라이드덱' }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.drop(screen.getByText('ZIP 파일을 여기에 놓으세요').parentElement!, {
    dataTransfer: { files: [new File(['zip'], 'kit.zip')] },
  });
  await screen.findByText('kit.zip');
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await screen.findByLabelText('템플릿 이름');
  fireEvent.click(screen.getByRole('button', { name: '이전' }));
  fireEvent.click(screen.getByRole('button', { name: '이전' }));
  fireEvent.click(screen.getByRole('button', { name: '웹사이트' }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  expect(screen.getAllByTestId('template-upload-page')).toHaveLength(51);
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
  expect(screen.getByTitle('kit/page-0.html').getAttribute('width')).toBe('1920');
  expect(screen.getByTitle('kit/page-0.html').getAttribute('height')).toBe('1080');
  act(() => first.callback(
    [{ target: first.node, isIntersecting: false } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  expect(document.querySelectorAll('iframe')).toHaveLength(0);
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
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {};
    status = 201;
    responseText = JSON.stringify(pending);
    onload = () => {};
    constructor() { xhr = this; }
    open() {}
    send() { this.onload(); }
    abort() {}
  });
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
    json: async () => ({ template: { id: 'user-kit', name: 'My kit', templateType: 'report', mode: 'report' } }),
  } as Response);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await act(async () => {});
  expect(onComplete).toHaveBeenCalledOnce();
});
