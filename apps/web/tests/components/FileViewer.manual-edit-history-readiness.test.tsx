// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { JSDOM } from '../edit-mode/bridge-dom';

const original = '<!doctype html><html><body><h1 data-readable-id="hero">Acceptance Heading</h1></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 1024, mtime: 1, mime: 'text/html', kind: 'html' } as const;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('applies all three undo keys when iframe load precedes bridge activation', async () => {
  // Given three edits and the real shipped bridge in a newly loaded document.
  vi.stubGlobal('fetch', async () => new Response(original));
  render(<FileViewer projectId="history-readiness" projectKind="prototype" file={file} liveHtml={original} />);
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing iframe');
  const frameWindow = frame.contentWindow;
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }));
  for (const value of ['Acceptance Edit 1', 'Acceptance Edit 2', 'Acceptance Edit 3']) {
    await act(async () => { send({ type: 'readable-edit-text-commit', id: 'hero', value }); });
  }
  const bridge = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('script[data-readable-edit-bridge]');
  if (!bridge) throw new Error('Missing shipped edit bridge');
  const dom = new JSDOM(`<h1 data-readable-id="hero">Acceptance Edit 2</h1>${bridge.outerHTML}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message: unknown) => {
    if (typeof message === 'object' && message !== null) send(message);
  });
  let activation: object | undefined;
  vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'readable-edit-mode') activation = message;
  });
  const pressUndo = () => {
    if (document.activeElement === frame) {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    }
  };
  frame.focus();

  // When the next key lands after load but before its asynchronous mode message.
  await act(async () => { send({ type: 'readable-edit-undo', redo: false }); });
  await act(async () => {
    fireEvent.load(frame);
    pressUndo();
  });
  if (!activation) throw new Error('Host did not activate bridge');
  await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: activation })); });
  await act(async () => { pressUndo(); });

  // Then no key was routed into a disabled bridge and all three edits are undone.
  expect(new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('h1')?.textContent).toBe('Acceptance Heading');
});
