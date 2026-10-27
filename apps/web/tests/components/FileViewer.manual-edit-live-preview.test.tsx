// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FileViewer } from '../../src/components/FileViewer';
import { manualEditCanonicalSource, manualEditFrameEpoch } from './manual-edit-frame-messages';
import { emptyManualEditStyles } from '../../src/edit-mode/types';
import { JSDOM } from '../edit-mode/bridge-dom';

const source = '<!doctype html><html><body><section class="slide" data-readable-id="slide-1"><h1>First</h1></section><section class="slide" data-readable-id="slide-2"><p data-readable-id="hero">Original text</p></section></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 1024, mtime: 1, mime: 'text/html', kind: 'html' } as const;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(initialSource = source) {
  const writes: { content: string; expectedContentSha256?: string }[] = [];
  let persisted = initialSource;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/files') && init?.method === 'POST') {
      const write = JSON.parse(String(init.body)) as { content: string; expectedContentSha256?: string };
      writes.push(write);
      persisted = write.content;
      return Response.json({ file });
    }
    return url.includes('/raw/') ? new Response(persisted) : Response.json({ deployments: [] });
  });
  const view = render(<FileViewer projectId="live-edit" projectKind="prototype" file={file} liveHtml={initialSource} />);
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing active frame');
  const posts = vi.spyOn(frame.contentWindow, 'postMessage');
  const mode = { documentEpoch: manualEditFrameEpoch(frame) };
  const send = async (data: object, from: Window | null = frame.contentWindow) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { documentEpoch: mode.documentEpoch, ...data }, source: from }));
    });
  };
  return { view, frame, posts, send, writes, mode, setPersisted: (html: string) => { persisted = html; } };
}

it('keeps the deck document mounted through text commit and Undo/Redo while saving canonical source', async () => {
  const h = await setup();
  const entry = h.frame.srcdoc;
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Updated text' });
  expect(h.frame.srcdoc).toBe(entry);
  await h.send({ type: 'readable-edit-undo', redo: false });
  expect(h.frame.srcdoc).toBe(entry);
  await h.send({ type: 'readable-edit-undo', redo: true });
  expect(h.frame.srcdoc).toBe(entry);
  fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(new DOMParser().parseFromString(h.writes[0]!.content, 'text/html').querySelector('[data-readable-id="hero"]')?.textContent).toBe('Updated text');
});

it('rejects text commits from a stale document and the inactive mounted frame', async () => {
  const h = await setup();
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Current text' });
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Stale text', documentEpoch: 'previous-document' });
  const inactive = screen.getByTestId('artifact-preview-frame-url-load');
  if (!(inactive instanceof HTMLIFrameElement)) throw new Error('Missing inactive frame');
  await h.send({ type: 'readable-edit-html-commit', id: 'hero', html: '<b>Inactive text</b>' }, inactive.contentWindow);
  fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]!.content).toContain('Current text');
  expect(h.writes[0]!.content).not.toMatch(/Stale text|Inactive text/);
});

it('rejects a present stale selection epoch after same-frame source replacement', async () => {
  const h = await setup();
  const oldEpoch = h.mode.documentEpoch;
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Replacement text' });
  const replay = h.posts.mock.calls.map(([message]) => message).find((message) => message.type === 'readable-edit-preview-source');
  expect(replay).toBeTruthy();
  await h.send({ type: 'readable-edit-preview-source-applied', requestId: replay.requestId, ok: false });
  expect(manualEditFrameEpoch(h.frame)).not.toBe(oldEpoch);
  await h.send({ type: 'readable-edit-select', documentEpoch: oldEpoch, target: {
    id: 'hero', kind: 'text', label: 'Old document text', tagName: 'p', className: '', text: 'Original text',
    rect: { x: 20, y: 20, width: 200, height: 50 }, fields: { text: 'Original text' }, attributes: {},
    styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<p>Original text</p>',
  } });
  expect(screen.queryByLabelText('Move element')).toBeNull();
  expect(h.writes).toHaveLength(0);
});

it.each(['external update', 'file switch'])('rebases a clean edit session after %s before the next local Save', async (transition) => {
  const h = await setup();
  const external = source.replace('Original text', 'Agent text');
  const nextFile = transition === 'file switch' ? { ...file, name: 'other.html', path: 'other.html' } : file;
  h.setPersisted(external);
  await act(async () => { h.view.rerender(<FileViewer projectId="live-edit" projectKind="prototype" file={nextFile} liveHtml={external} />); });
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  // A newly loaded bridge receives the replacement document epoch.
  const active = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Local after agent', documentEpoch: manualEditFrameEpoch(active) }, active.contentWindow);
  fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]!.expectedContentSha256).toBe(createHash('sha256').update(external).digest('hex'));
});

it('ignores an old document ending the current text-edit selection', async () => {
  const h = await setup();
  await h.send({ type: 'readable-edit-select', beginTextEdit: true, target: {
    id: 'hero', kind: 'text', label: 'Text', tagName: 'p', className: '', text: 'Original text',
    rect: { x: 20, y: 20, width: 200, height: 50 }, fields: { text: 'Original text' }, attributes: {},
    styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<p>Original text</p>',
  } });
  await h.send({ type: 'readable-edit-selection-state', editing: true, hasSelection: false, bold: false, italic: false, underline: false });
  expect(screen.getByLabelText('Move element').querySelector('[data-region="interior"]')).toBeNull();
  await h.send({ type: 'readable-edit-selection-state', documentEpoch: 'old-document', editing: false, hasSelection: false, bold: false, italic: false, underline: false });
  expect(screen.getByLabelText('Move element').querySelector('[data-region="interior"]')).toBeNull();
  await h.send({ type: 'readable-edit-selection-state', editing: false, hasSelection: false, bold: false, italic: false, underline: false });
  expect(screen.getByLabelText('Move element').querySelector('[data-region="interior"]')).not.toBeNull();
});

it('keeps distinct same-tick edits undoable without replacing the deck document', async () => {
  const original = source.replace('<h1>First</h1>', '<h1 data-readable-id="other">First</h1>');
  const h = await setup(original);
  const entry = h.frame.srcdoc;
  const bridge = new DOMParser().parseFromString(entry, 'text/html').querySelector('script[data-readable-edit-bridge]');
  if (!bridge) throw new Error('Missing edit bridge');
  const dom = new JSDOM(`${original}${bridge.outerHTML}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  dom.window.parent.postMessage = (data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data, source: h.frame.contentWindow }));
  };
  h.posts.mockImplementation((data: unknown) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window.parent }));
  });
  fireEvent.load(h.frame);
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  await act(async () => {
    for (const [id, value] of [['hero', 'Changed paragraph'], ['other', 'Changed heading']]) {
      window.dispatchEvent(new MessageEvent('message', {
        source: h.frame.contentWindow, data: { type: 'readable-edit-text-commit', documentEpoch: h.mode.documentEpoch, id, value },
      }));
    }
  });
  await h.send({ type: 'readable-edit-undo', redo: false });
  await h.send({ type: 'readable-edit-undo', redo: false });
  expect(h.frame.srcdoc).toBe(entry);
  expect(dom.window.document.querySelector('[data-readable-id="hero"]')?.textContent).toBe('Original text');
  expect(dom.window.document.querySelector('[data-readable-id="other"]')?.textContent).toBe('First');
});

it('does not reclaim chat focus when an earlier text-entry request finishes flushing', async () => {
  const h = await setup(source.replace('<h1>First</h1>', '<h1 data-readable-id="other">First</h1>'));
  const target = (id: string) => ({
    id, kind: 'text', label: id, tagName: 'p', className: '', text: id,
    rect: { x: 20, y: 20, width: 200, height: 50 }, fields: { text: id }, attributes: {},
    styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: `<p>${id}</p>`,
  });
  await h.send({ type: 'readable-edit-select', beginTextEdit: true, target: target('hero') });
  await h.send({ type: 'readable-edit-select', beginTextEdit: true, target: target('other') });
  const flush = h.posts.mock.calls.map(([message]) => message as { type?: string; requestId?: number; documentEpoch?: string })
    .filter((message) => message.type === 'readable-edit-end-text-edit').at(-1);
  expect(flush?.requestId).toBeTypeOf('number');
  const composer = document.createElement('input');
  h.view.container.appendChild(composer);
  composer.focus();
  await h.send({ type: 'readable-edit-text-flushed', requestId: flush!.requestId, documentEpoch: flush!.documentEpoch });
  expect(h.posts).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-begin-text-edit', id: 'other' }), '*');
  expect(document.activeElement).toBe(composer);
});

it.each(['raw to live', 'live to raw'])('preserves dirty canonical edits when the same file changes from %s', async (transition) => {
  const h = await setup();
  if (transition === 'raw to live') {
    await act(async () => {
      h.view.rerender(<FileViewer projectId="live-edit" projectKind="prototype" file={file} />);
    });
  }
  const active = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Unsaved local text', documentEpoch: manualEditFrameEpoch(active) }, active.contentWindow);
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  await act(async () => {
    h.view.rerender(<FileViewer projectId="live-edit" projectKind="prototype" file={file}
      liveHtml={transition === 'raw to live' ? source : undefined} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]!.content).toContain('Unsaved local text');
  expect(h.writes[0]!.expectedContentSha256).toBe(createHash('sha256').update(source).digest('hex'));
});

it.each(['raw', 'live'])('shows an ignored external update after Discard in %s mode without writing a file', async (retrieval) => {
  const h = await setup();
  if (retrieval === 'raw') {
    await act(async () => { h.view.rerender(<FileViewer projectId="live-edit" projectKind="prototype" file={file} />); });
  }
  const active = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Local unsaved text', documentEpoch: manualEditFrameEpoch(active) }, active.contentWindow);
  const external = source.replace('Original text', 'Latest external text');
  h.setPersisted(external);
  await act(async () => {
    h.view.rerender(<FileViewer projectId="live-edit" projectKind="prototype" file={file}
      liveHtml={retrieval === 'live' ? external : undefined} filesRefreshKey={1} />);
  });
  expect(manualEditCanonicalSource(active)).toContain('Local unsaved text');
  expect(h.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc).toContain('Latest external text'));
  expect(h.writes).toHaveLength(0);
});
