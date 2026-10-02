// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { getEn } from '../../src/i18n/locales/en';
import { JSDOM } from '../edit-mode/bridge-dom';
import type { ProjectFile } from '../../src/types';

const html = '<html><body><p data-readable-id="hero">Original</p><p data-readable-id="other">Other</p></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = { id: 'hero', kind: 'text', label: 'Hero', tagName: 'p', className: '', text: 'Original', rect: { x: 10, y: 10, width: 160, height: 48 }, fields: {}, attributes: {}, styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<p>Original</p>' };
const doms: JSDOM[] = [];
afterEach(() => {
  cleanup();
  for (const dom of doms.splice(0)) dom.window.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup() {
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return new Response(JSON.stringify({ file }), { status: 200 });
    }
    return new Response(html, { status: 200 });
  }));
  await act(async () => { render(<FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml={html} />); });
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const dom = new JSDOM(`${html}${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  doms.push(dom); await dom.loaded;
  const incoming: unknown[] = [];
  const requests: Array<{ type?: string; requestId?: number }> = [];
  let deliver = false;
  dom.window.parent.postMessage = (data: unknown) => incoming.push(data);
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
    requests.push(data);
    if (data.type !== 'readable-edit-end-text-edit' || deliver) dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  });
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  const drain = async () => { await act(async () => { while (incoming.length) dispatch(incoming.shift()); }); };
  await act(async () => { dispatch({ type: 'readable-edit-select', target, beginTextEdit: true }); });
  await drain();
  dom.window.document.querySelector('[data-readable-id="hero"]')!.textContent = 'Unsaved edit';
  vi.useFakeTimers();
  return { requests, writes, dispatch, drain, resume: () => { deliver = true; } };
}

describe('text-flush acknowledgement failures are not file-save failures', () => {
  it('reports the local operation on a visible selection timeout without issuing a file write', async () => {
    const harness = await setup();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { harness.dispatch({ type: 'readable-edit-select', target: { ...target, id: 'other' } }); });
    expect(harness.requests.filter((request) => request.type === 'readable-edit-end-text-edit')).toEqual([{ type: 'readable-edit-end-text-edit', requestId: 1 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(harness.writes).toHaveLength(0);
    expect(screen.queryByText(getEn()['manualEdit.error.saveFailed'])).toBeNull();
    expect(screen.getByText(getEn()['manualEdit.error.textFlushFailed'])).toBeTruthy();
  });

  it('keeps a hidden flush pending and saves the same edit after visibility and bridge delivery return', async () => {
    const harness = await setup();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
    visibility = 'hidden';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(3000); });
    expect(harness.writes).toHaveLength(0);
    expect(screen.queryByText(getEn()['manualEdit.error.saveFailed'])).toBeNull();
    harness.resume(); visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await harness.drain();
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toContain('Unsaved edit');
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
  });
});
