// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { JSDOM } from '../edit-mode/bridge-dom';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

const original = '<!doctype html><html><body><h1 data-readable-id="hero">Acceptance Heading</h1></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 1024, mtime: 1, mime: 'text/html', kind: 'html' } as const;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the active bridge and keyboard focus through three Undo operations without reloading', async () => {
  vi.stubGlobal('fetch', async () => new Response(original));
  render(<FileViewer projectId="history-readiness" projectKind="prototype" file={file} liveHtml={original} />);
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing iframe');
  const frameWindow = frame.contentWindow;
  const documentEpoch = manualEditFrameEpoch(frame);
  const entrySrcDoc = frame.srcdoc;
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data: { documentEpoch, ...data }, source: frameWindow }));
  const bridge = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('script[data-readable-edit-bridge]');
  if (!bridge) throw new Error('Missing shipped edit bridge');
  const dom = new JSDOM(`${original}${bridge.outerHTML}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message: unknown) => {
    if (typeof message === 'object' && message !== null) send(message);
  });
  vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message, source: dom.window.parent }));
  });
  fireEvent.load(frame);
  for (const value of ['Acceptance Edit 1', 'Acceptance Edit 2', 'Acceptance Edit 3']) {
    await act(async () => { send({ type: 'readable-edit-text-commit', id: 'hero', value }); });
  }
  expect(dom.window.document.querySelector('h1')?.textContent).toBe('Acceptance Edit 3');
  const pressUndo = () => {
    if (document.activeElement === frame) {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    }
  };
  frame.focus();

  for (let index = 0; index < 3; index += 1) await act(async () => { pressUndo(); });

  expect(dom.window.document.querySelector('h1')?.textContent).toBe('Acceptance Heading');
  expect(frame.srcdoc).toBe(entrySrcDoc);
  expect(document.activeElement).toBe(frame);
});
