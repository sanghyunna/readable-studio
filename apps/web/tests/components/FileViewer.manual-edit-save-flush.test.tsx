// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPerformanceProfileToDocument } from '../../src/state/config';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { JSDOM } from '../edit-mode/bridge-dom';
import type { ProjectFile } from '../../src/types';

const html = '<html><body><p data-readable-id="hero">First\nsecond</p><p data-readable-id="other">Other</p></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = {
  id: 'hero', kind: 'container', label: 'Hero', tagName: 'p', className: '', text: 'First\nsecond',
  rect: { x: 10, y: 10, width: 160, height: 48 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<p>First\nsecond</p>',
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); applyPerformanceProfileToDocument('full'); });

async function setup(raw = false) {
  let diskSource = html;
  const writes: string[] = [];
  let resolveSaved!: () => void;
  const saved = { promise: new Promise<void>((resolve) => { resolveSaved = resolve; }), resolve: () => resolveSaved() };
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return new Response(JSON.stringify({ file }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(diskSource, { status: 200 });
  }));
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml={raw ? undefined : html} onFileSaved={() => saved.resolve()} />);
  });
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const dom = new JSDOM(`${html}${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  const messages: unknown[] = [];
  const posts: Array<{ type?: string }> = [];
  dom.window.parent.postMessage = (data: unknown) => { messages.push(data); posts.push(data as { type?: string }); };
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  });
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  const drain = async () => {
    await act(async () => { while (messages.length) dispatch(messages.shift()); });
  };
  const select = async (next: ManualEditTarget, beginTextEdit = false) => {
    await act(async () => { dispatch({ type: 'readable-edit-select', target: next, beginTextEdit }); });
    await drain();
  };
  const refresh = () => {
    diskSource = html.replace('First', 'Agent');
    view.rerender(<FileViewer projectId="project-1" projectKind="prototype"
      file={{ ...file, mtime: 2 }} liveHtml={raw ? undefined : diskSource}
      onFileSaved={() => saved.resolve()} />);
  };
  return { dom, writes, saved, select, drain, dispatch, frame, posts, refresh };
}

describe.each(['full', 'low'] as const)('Save flushes the real contenteditable bridge with %s host profile', (profile) => {
  beforeEach(() => applyPerformanceProfileToDocument(profile));
  it.each([
    ['plain', 'save'], ['rich', 'save'], ['plain', 'toggle'], ['rich', 'toggle'],
  ] as const)('persists an active %s line-break edit together with movement and a pending style via %s', async (kind, exit) => {
    const harness = await setup();
    await harness.select(target);
    const surface = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 140 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 130, clientY: 140 });
    });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await harness.select({ ...target, kind: 'text' }, true);
    const el = harness.dom.window.document.querySelector('[data-readable-id="hero"]')!;
    expect(el.getAttribute('data-readable-editing')).toBe('true');
    el.innerHTML = kind === 'rich' ? '<b>First</b> second' : 'First second';
    // Transport delivery is explicitly controlled: no native blur and no timing sleeps.
    await act(async () => { fireEvent.click(exit === 'save'
      ? screen.getByRole('button', { name: 'Save changes' })
      : screen.getByTestId('manual-edit-mode-toggle')); });
    expect(harness.writes).toHaveLength(0);
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    expect(harness.writes).toHaveLength(1);
    const doc = new DOMParser().parseFromString(harness.writes[0]!, 'text/html');
    const saved = doc.querySelector('[data-readable-id="hero"]')!;
    expect(saved.textContent).toBe('First second');
    expect((saved as HTMLElement).style.width).toBe('200px');
    expect((saved as HTMLElement).style.translate).toBe('30px 40px');
    expect(saved.querySelector('strong') !== null).toBe(kind === 'rich');
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it.each(['watcher', 'raw-watcher', 'reload', 'source'] as const)('records live text before %s can replace the document', async (event) => {
    const harness = await setup(event === 'raw-watcher');
    await harness.select({ ...target, kind: 'text' }, true);
    harness.dom.window.document.querySelector('[data-readable-id="hero"]')!.textContent = 'Still typing';
    await act(async () => {
      if (event === 'watcher' || event === 'raw-watcher') harness.refresh();
      else if (event === 'reload') fireEvent.click(screen.getByRole('button', { name: 'Reload Preview' }));
      else fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
    });
    await harness.drain();
    expect(harness.posts.some((post) => post.type === 'readable-edit-text-flushed')).toBe(true);
    if (event === 'source') await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Preview' })); });
    const currentFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(currentFrame.srcdoc).toContain('Still typing');
    expect(currentFrame.srcdoc).not.toContain('Agent');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toContain('Still typing');
  });

  it('flushes live text into history before host Undo replaces the iframe', async () => {
    const harness = await setup();
    await act(async () => { harness.dispatch({ type: 'readable-edit-text-commit', id: 'hero', value: 'Committed' }); });
    await harness.select({ ...target, kind: 'text' }, true);
    harness.dom.window.document.querySelector('[data-readable-id="hero"]')!.textContent = 'Still typing';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await harness.drain();
    expect(harness.posts.some((post) => post.type === 'readable-edit-text-flushed')).toBe(true);
    expect(harness.frame.srcdoc).toContain('Committed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Redo' })); });
    expect(harness.frame.srcdoc).toContain('Still typing');
  });

  it.each(['pointer', 'keyboard', 'resize'] as const)('preserves an open %s movement across a watcher refresh and flushes it before Reload', async (gesture) => {
    const harness = await setup();
    await harness.select(target);
    const surface = screen.getByLabelText('Move element').querySelector('[data-region="interior"]')!;
    await act(async () => {
      if (gesture === 'pointer') {
        fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 140 });
      } else if (gesture === 'resize') {
        const handle = screen.getByLabelText('Resize right edge');
        fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130, clientY: 100 });
      } else fireEvent.keyDown(surface, { key: 'ArrowRight' });
    });
    await act(async () => { harness.refresh(); });
    await harness.drain();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(harness.frame.srcdoc).not.toContain('Agent');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload Preview' })); });
    await harness.drain();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
    expect(harness.frame.srcdoc).not.toContain('Agent');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    const saved = new DOMParser().parseFromString(harness.writes[0]!, 'text/html').querySelector('p')!;
    if (gesture === 'resize') expect(saved.style.width).toBe('190px');
    else expect(saved.style.translate).toBe(gesture === 'pointer' ? '30px 40px' : '1px 0px');
  });

  it('toggling off a text-only active session writes the same replacement space', async () => {
    const harness = await setup();
    await harness.select({ ...target, kind: 'text' }, true);
    harness.dom.window.document.querySelector('[data-readable-id="hero"]')!.textContent = 'First second';
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
    expect(harness.writes).toHaveLength(0);
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    expect(new DOMParser().parseFromString(harness.writes[0]!, 'text/html').querySelector('p')!.textContent).toBe('First second');
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('flushes a still-live session even when its element is no longer focused', async () => {
    const harness = await setup();
    await harness.select(target);
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await harness.select({ ...target, kind: 'text' }, true);
    const el = harness.dom.window.document.querySelector('[data-readable-id="hero"]')!;
    el.textContent = 'First second';
    // Removing a focused node does not dispatch blur. Reinsert it with the
    // editing session intact, while another element owns focus.
    el.remove();
    harness.dom.window.document.body.appendChild(el);
    const other = harness.dom.window.document.querySelector('[data-readable-id="other"]') as HTMLElement;
    other.tabIndex = 0;
    other.focus();
    expect(harness.dom.window.document.activeElement).toBe(other);
    expect(el.getAttribute('data-readable-editing')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    expect(harness.writes[0]).toContain('First second');
  });

  it('switching host selection flushes the previous text and pending style before reading the next draft', async () => {
    const harness = await setup();
    await harness.select(target);
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await harness.select({ ...target, kind: 'text' }, true);
    harness.dom.window.document.querySelector('[data-readable-id="hero"]')!.textContent = 'First second';
    await harness.select({ ...target, id: 'other', text: 'Other' });
    expect(harness.frame.srcdoc).toContain('First second');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await act(async () => { await harness.saved.promise; });
    const el = new DOMParser().parseFromString(harness.writes[0]!, 'text/html').querySelector('[data-readable-id="hero"]') as HTMLElement;
    expect(el.textContent).toBe('First second');
    expect(el.style.width).toBe('200px');
  });

  it.each(['Enter', 'Escape', 'blur'])('%s commits exactly once before Save, even with transport delivery pending', async (gesture) => {
    const harness = await setup();
    await harness.select(target);
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await harness.select({ ...target, kind: 'text' }, true);
    const el = harness.dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    el.textContent = 'First second';
    if (gesture === 'blur') el.blur();
    else el.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: gesture, bubbles: true, cancelable: true }));
    expect(el.hasAttribute('contenteditable')).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    expect(harness.writes).toHaveLength(0);
    await harness.drain();
    await act(async () => { await harness.saved.promise; });
    expect(harness.writes[0]).toContain('First second');
    expect(harness.posts.filter((post) => post.type === 'readable-edit-text-commit')).toHaveLength(1);
  });
});
