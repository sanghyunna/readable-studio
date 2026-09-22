// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles } from '../../src/edit-mode/types';

const source = '<!doctype html><html><body><p data-readable-id="text">Original</p></body></html>';
const file = { name: 'same.html', path: 'same.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' } as const;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['undo', 'redo'])('releases %s when switching projects with the same document name', async (stack) => {
  // Given an edited document and an undo history.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source)));
  const view = render(<FileViewer projectId="first" projectKind="prototype" liveHtml={source} file={file} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('Expected preview iframe');
  const select = () => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'readable-edit-select', target: { id: 'text', kind: 'text', label: 'Text', tagName: 'p', className: '', text: 'Original', rect: { x: 0, y: 0, width: 120, height: 40 }, fields: { text: 'Original' }, attributes: {}, styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<p>Original</p>' } }, source: frame.contentWindow,
  }));
  await act(async () => { select(); });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'readable-edit-text-commit', id: 'text', value: 'Changed' }, source: frame.contentWindow,
    }));
  });
  expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(false);
  if (stack === 'redo') {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(screen.getByRole('button', { name: 'Redo' }).hasAttribute('disabled')).toBe(false);
  }
  // When opening a different project's identically named document.
  await act(async () => {
    view.rerender(<FileViewer projectId="second" projectKind="prototype" liveHtml={source} file={file} />);
  });
  await act(async () => { select(); });
  // Then neither history stack can affect the new document.
  expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Redo' }).hasAttribute('disabled')).toBe(true);
});
