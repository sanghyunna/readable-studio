// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

const html = '<!doctype html><html><body><h1 data-readable-id="hero">Title</h1></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' } as const;
const target: ManualEditTarget = { id: 'hero', kind: 'text', label: 'Title', tagName: 'h1', className: '', text: 'Title',
  rect: { x: 8, y: 20, width: 400, height: 40 }, fields: { text: 'Title' }, attributes: {}, styles: emptyManualEditStyles(),
  isLayoutContainer: false, outerHtml: '<h1>Title</h1>' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// A text edit started under one epoch is dropped by the bridge once the epoch
// moves, so the epoch must only move with the document, never on a later re-sync.
it('loads the edit document with its final epoch when edit entry commits before the preview window is reachable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html)));
  await act(async () => { render(<FileViewer projectId="document-epoch" projectKind="prototype" file={file} liveHtml={html} />); });
  const unreachable = vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  unreachable.mockRestore();
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const epochs: string[] = [];
  vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((data: { type?: string; documentEpoch?: string }) => {
    if (data?.type === 'readable-edit-mode' && data.documentEpoch) epochs.push(data.documentEpoch);
  });
  await act(async () => { fireEvent.load(frame); });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'readable-edit-select', target, beginTextEdit: true } }));
  });

  expect(epochs.length).toBeGreaterThanOrEqual(2);
  expect(new Set(epochs).size).toBe(1);
});
