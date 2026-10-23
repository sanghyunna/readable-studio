// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataImportModal } from '../../src/components/DataImportModal';
import { I18nProvider } from '../../src/i18n';

const candidate = { sourceRoot: 'D:\\Earlier', sourceData: 'D:\\Earlier\\ReadableStudioData\\namespaces\\rg\\data', projectCount: 2, modifiedAt: '2026-10-01T00:00:00Z' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown) => Response.json(body);
function mount(onResolved = vi.fn()) {
  return { ...render(<I18nProvider initial="ko"><DataImportModal manual onResolved={onResolved} /></I18nProvider>), onResolved };
}

it('shows cancellable discovery, then ignores a response after close', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  const view = mount();
  expect(screen.getByRole('status').textContent).toContain('이전 작업 내역을 확인하고 있습니다');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '닫기' })); });
  expect(view.onResolved).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => { resolve(reply({ state: 'offered', candidates: [candidate] })); });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps discovery failures visible and allows an explicit retry without recording a decision', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(reply({ state: 'offered', candidates: [candidate] }));
  vi.stubGlobal('fetch', fetcher);
  const { onResolved } = mount();
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('이전 버전의 작업 내역을 확인하지 못했습니다');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 확인' })); });
  expect(screen.getByText(candidate.sourceRoot)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(onResolved).not.toHaveBeenCalled();
});

it.each([
  [{ state: 'unavailable', candidates: [] }, '이전 버전의 작업 폴더를 찾지 못했습니다'],
  [{ state: 'unavailable', candidates: [], unavailableReason: 'projects-present' }, '현재 폴더에 프로젝트가 있어 가져올 수 없습니다'],
  [{ state: 'unavailable', candidates: [], unavailableReason: 'unsupported-runtime' }, '포터블 앱에서 사용할 수 있습니다'],
  [{ state: 'done', candidates: [] }, '이미 이전 버전의 작업 내역을 가져왔습니다'],
])('explains a blocked manual import without offering a write (%j)', async (body, message) => {
  const fetcher = vi.fn(async () => reply(body));
  vi.stubGlobal('fetch', fetcher);
  const { onResolved } = mount();
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toContain(message);
  expect(screen.queryByRole('button', { name: '가져오기' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '닫기' })); });
  expect(onResolved).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('submits the chosen source and waits for explicit restart while preserving cancel semantics', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ state: 'offered', candidates: [candidate] }))
    .mockResolvedValueOnce(reply({ state: 'pending', restartRequired: true }))
    .mockResolvedValueOnce(reply({ state: 'declined', restartRequired: false }));
  vi.stubGlobal('fetch', fetcher);
  const { onResolved } = mount();
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '가져오기' })); });
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ action: 'import', from: candidate.sourceData });
  expect(screen.getByRole('button', { name: '다시 시작하기' })).toBeTruthy();
  expect(onResolved).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '가져오지 않기' })); });
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ action: 'decline' });
  expect(onResolved).toHaveBeenCalledOnce();
});

it('rescans an empty discovery after an earlier app folder becomes available', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ state: 'unavailable', candidates: [] }))
    .mockResolvedValueOnce(reply({ state: 'offered', candidates: [candidate] }));
  vi.stubGlobal('fetch', fetcher);
  mount();
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 확인' })); });
  expect(screen.getByText(candidate.sourceRoot)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not close or submit twice while an import request is in flight', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ state: 'offered', candidates: [candidate] }))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  const { onResolved } = mount();
  await act(async () => {});
  const button = screen.getByRole('button', { name: '가져오기' });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); fireEvent.keyDown(document, { key: 'Escape' }); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '닫기' }).hasAttribute('disabled')).toBe(true);
  expect(onResolved).not.toHaveBeenCalled();
  await act(async () => { resolve(reply({ state: 'pending', restartRequired: true })); });
  expect(screen.getByRole('button', { name: '다시 시작하기' })).toBeTruthy();
});
