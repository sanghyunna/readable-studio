// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { JSDOM } from '../edit-mode/bridge-dom';
import type { ProjectFile } from '../../src/types';

const html = '<!doctype html><html><head><style>p{width:640px;color:#123456}</style></head><body><main>'
  + Array.from({ length: 120 }, (_, i) => `<p data-readable-id="p${i}">${'Realistic document paragraph with editable content and layout. '.repeat(8)}</p>`).join('')
  + '</main></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: html.length, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = {
  id: 'p0', kind: 'text', label: 'Paragraph', tagName: 'p', className: '', text: 'Paragraph',
  rect: { x: 0, y: 0, width: 640, height: 80 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '',
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function setup() {
  const writes: string[] = [];
  const requestBytes: number[] = [];
  let completeSave = () => {};
  const saved = new Promise<void>((resolve) => { completeSave = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = String(init.body);
      const payload: { content: string } = JSON.parse(body);
      writes.push(payload.content);
      requestBytes.push(new TextEncoder().encode(body).byteLength);
      return new Response(JSON.stringify({ file }), { status: 200 });
    }
    return new Response(html, { status: 200 });
  }));
  const commits = vi.fn();
  await act(async () => { render(<Profiler id="viewer" onRender={commits}><FileViewer projectId="cost" projectKind="prototype" file={file} liveHtml={html} onFileSaved={completeSave} /></Profiler>); });
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing preview frame');
  const frames: FrameRequestCallback[] = [];
  const dom = new JSDOM(`${html}${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: 'http://localhost',
    beforeParse(window) {
      window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      window.cancelAnimationFrame = () => { frames.length = 0; };
      window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 80, top: 0, left: 0, right: 640, bottom: 80, toJSON: () => ({}) });
    },
  });
  await dom.loaded;
  const inbound: unknown[] = [];
  const messages: unknown[] = [];
  dom.window.parent.postMessage = (data: unknown) => { inbound.push(data); messages.push(data); };
  const outgoing = vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation((data) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  });
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  const drain = async () => { await act(async () => { while (inbound.length) dispatch(inbound.shift()); }); };
  const flushFrames = async () => {
    const pending = frames.splice(0);
    for (const callback of pending) callback(0);
    await drain();
  };
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
  const styles = vi.spyOn(dom.window, 'getComputedStyle');
  return { dom, writes, requestBytes, saved, commits, messages, outgoing, dispatch, drain, flushFrames, parse, styles };
}

it('avoids repeated source parsing when selecting an object in a 120-paragraph document', async () => {
  // Given
  const h = await setup();
  h.parse.mockClear();
  h.commits.mockClear();
  // When
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target }); });
  // Then
  expect(h.parse).toHaveBeenCalledTimes(1);
});

it('keeps unchanged caret state local while typing and durably saves the final text once', async () => {
  // Given
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const h = await setup();
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target, beginTextEdit: true }); });
  await h.drain();
  await h.flushFrames();
  // Finish mode-entry scroll restoration before measuring typing. Execute
  // queued timers during each keystroke too, so deferred typing work is counted.
  await act(async () => { await vi.runAllTimersAsync(); });
  const el = h.dom.window.document.querySelector('p');
  if (!el?.firstChild) throw new Error('Missing text');
  h.messages.length = 0;
  h.outgoing.mockClear();
  h.commits.mockClear();
  h.styles.mockClear();
  h.parse.mockClear();
  // When: each keystroke has its own DOM mutation, selection event and render frame.
  for (let i = 0; i < 12; i++) {
    await h.dom.nextMutation(() => { el.textContent += 'x'; });
    const range = h.dom.window.document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    h.dom.window.getSelection()?.removeAllRanges();
    h.dom.window.getSelection()?.addRange(range);
    h.dom.window.document.dispatchEvent(new h.dom.window.Event('selectionchange'));
    await h.flushFrames();
    await act(async () => { await vi.runAllTimersAsync(); });
  }
  // Then
  const typing = { bridge: h.messages.length + h.outgoing.mock.calls.length, commits: h.commits.mock.calls.length, computedStyles: h.styles.mock.calls.length, parses: h.parse.mock.calls.length };
  h.messages.length = 0;
  h.outgoing.mockClear();
  h.commits.mockClear();
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  await h.drain();
  await act(async () => { await h.saved; });
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]).toContain('xxxxxxxxxxxx</p>');
  expect(typing).toEqual({ bridge: 0, commits: 0, computedStyles: 0, parses: 0 });
});

it('parses a pending style only for its patch and reconciliation when saving', async () => {
  // Given
  const h = await setup();
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target }); });
  fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
  await h.drain();
  h.parse.mockClear();
  h.commits.mockClear();
  h.messages.length = 0;
  h.outgoing.mockClear();
  // When
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  await act(async () => { await h.saved; });
  // Then
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]).toContain('width: 200px');
  // Patch + reconciliation + the existing two preview-annotation parses.
  expect(h.parse).toHaveBeenCalledTimes(4);
});
