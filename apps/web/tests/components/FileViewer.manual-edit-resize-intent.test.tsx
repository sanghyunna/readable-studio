// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

const handles = vi.hoisted(() => ({
  current: null as ComponentProps<typeof import('../../src/components/ManualEditResizeHandles').ManualEditResizeHandles> | null,
}));
vi.mock('../../src/components/ManualEditResizeHandles', () => ({
  ManualEditResizeHandles: (props: ComponentProps<typeof import('../../src/components/ManualEditResizeHandles').ManualEditResizeHandles>) => {
    handles.current = props;
    return <div data-testid="pending-resize-handles" />;
  },
}));
vi.mock('../../src/components/ManualEditShapeToolbar', () => ({
  ManualEditShapeToolbar: (props: { target: ManualEditTarget }) => <div data-testid="selected-target" data-target-id={props.target.id} />,
}));
import { FileViewer } from '../../src/components/FileViewer';

const original = '<html><body><div data-readable-id="hero" style="width:200px;height:100px">Hero</div><div data-readable-id="other">Other</div></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' } as const;
const target = (id: string): ManualEditTarget => ({
  id, kind: 'container', label: id, tagName: 'div', className: '', text: id,
  rect: { x: 20, y: 20, width: 200, height: 100 }, fields: {}, attributes: {},
  styles: { ...emptyManualEditStyles(), width: '200px', height: '100px' }, cssSize: { width: '200px', height: '100px' },
  isLayoutContainer: false, textEditTargetId: id, outerHtml: `<div>${id}</div>`,
});
afterEach(() => { cleanup(); handles.current = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function deferredResizeFixture() {
  const writes: string[] = [];
  let persisted = original;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    return String(input).includes('/raw/') ? new Response(persisted) : Response.json({ deployments: [] });
  });
  const view = render(<FileViewer projectId="resize-owner" projectKind="prototype" file={file} liveHtml={original} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = () => screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  let epoch = manualEditFrameEpoch(frame());
  const posts = vi.spyOn(frame().contentWindow!, 'postMessage');
  const send = (data: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame().contentWindow, data: { documentEpoch: epoch, ...data } }));
  });
  posts.mockImplementation((message) => {
    if (message.type === 'readable-edit-end-text-edit' && typeof message.requestId === 'number') {
      window.dispatchEvent(new MessageEvent('message', { source: frame().contentWindow, data: {
        type: 'readable-edit-text-flushed', requestId: message.requestId, documentEpoch: message.documentEpoch,
      } }));
    }
  });
  const start = async () => {
    await send({ type: 'readable-edit-select', target: target('hero') });
    expect(handles.current).not.toBeNull();
    expect(handles.current!.disabled).toBe(false);
    let done!: Promise<void>;
    let expire: (() => void) | undefined;
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    try {
      await act(async () => {
        handles.current!.onResizeStart?.();
        done = Promise.resolve(handles.current!.onResizeCommit('e', { width: 240, height: 100 }, { width: 200, height: 100 }));
      });
      const timeoutIndex = timeouts.mock.calls.findIndex(([, delay]) => delay === 30_000);
      const callback = timeouts.mock.calls[timeoutIndex]?.[0];
      const handle = timeouts.mock.results[timeoutIndex]?.value;
      if (typeof callback === 'function') expire = () => { clearTimeout(handle); callback(); };
    } finally { timeouts.mockRestore(); }
    const command = posts.mock.calls.map(([message]) => message).filter((message) => message.resize?.stage === 'finalize').at(-1);
    if (!command) throw new Error('Missing final resize command');
    let settled = false;
    return {
      settle: async () => {
        if (settled) return;
        settled = true;
        if (screen.queryByTestId('artifact-preview-frame')) {
          await send({ ...command.resize, type: 'readable-edit-preview-style-applied', id: 'hero', version: command.version,
            ok: true, rect: { x: 20, y: 20, width: 240, height: 100 },
            resize: { decision: 'ordinary', constraints: [], causes: [], safetyFailures: [], confidence: 'confirmed', classification: 'ordinary' },
          });
        } else {
          // A failing replacement can unmount the old iframe. Settle only its
          // existing timeout for cleanup; the B-acceptance assertion is above.
          if (!expire) throw new Error('Missing obsolete resize timeout cleanup');
          await act(async () => { expire!(); });
        }
        await act(async () => { await done; });
      },
    };
  };
  return { frame, posts, writes, send, start,
    refreshEpoch: () => { epoch = manualEditFrameEpoch(frame()); },
    replace: async (nextFile: typeof file | { name: string; path: string; type: 'file'; size: number; mtime: number; mime: 'text/html'; kind: 'html' }, source: string) => {
      persisted = source;
      await act(async () => { view.rerender(<FileViewer projectId="resize-owner" projectKind="prototype" file={nextFile} liveHtml={source} />); });
    },
  };
}

it('waits for released resize history before reading the Undo cursor', async () => {
  const h = await deferredResizeFixture();
  const entry = h.frame().srcdoc;
  const resize = await h.start();
  try {
    await h.send({ type: 'readable-edit-undo', redo: false });
    expect(h.posts.mock.calls.some(([message]) => message.type === 'readable-edit-preview-source')).toBe(false);
  } finally { await resize.settle(); }
  const replay = h.posts.mock.calls.map(([message]) => message).filter((message) => message.type === 'readable-edit-preview-source').at(-1);
  expect(replay?.afterSource).toBe(original);
  expect(h.frame().srcdoc).toBe(entry);
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(h.writes).toHaveLength(0);
});

it('waits for released resize history before reading the Redo cursor', async () => {
  const h = await deferredResizeFixture();
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Earlier edit' });
  await h.send({ type: 'readable-edit-undo', redo: false });
  h.posts.mockClear();
  const resize = await h.start();
  try {
    await h.send({ type: 'readable-edit-undo', redo: true });
    expect(h.posts.mock.calls.some(([message]) => message.type === 'readable-edit-preview-source')).toBe(false);
  } finally { await resize.settle(); }
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  const saved = new DOMParser().parseFromString(h.writes[0]!, 'text/html').querySelector<HTMLElement>('[data-readable-id="hero"]')!;
  expect(saved.style.width).toBe('240px');
  expect(saved.textContent).toBe('Hero');
});

it('quietly settles an obsolete resize owner after Discard and re-entry', async () => {
  const h = await deferredResizeFixture();
  await h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Discard this edit' });
  const oldResize = await h.start();
  let currentResize: Awaited<ReturnType<typeof h.start>> | undefined;
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
    h.refreshEpoch();
    currentResize = await h.start();
    const currentDocument = h.frame().srcdoc;
    await oldResize.settle();
    expect(handles.current!.disabled).toBe(true);
    expect(h.frame().srcdoc).toBe(currentDocument);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.writes).toHaveLength(0);
  } finally {
    await oldResize.settle();
    await currentResize?.settle();
  }
});

it('quietly settles an obsolete resize owner after a real different-file replacement', async () => {
  const h = await deferredResizeFixture();
  const oldResize = await h.start();
  const replacement = original.replace('Hero', 'Second file');
  try {
    await h.replace({ ...file, name: 'second.html', path: 'second.html' }, replacement);
    await waitFor(() => expect(screen.queryByTestId('artifact-preview-frame')).not.toBeNull());
    await waitFor(() => expect(h.frame().srcdoc).toContain('Second file'));
    const currentDocument = h.frame().srcdoc;
    await oldResize.settle();
    expect(h.frame().srcdoc).toBe(currentDocument);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(h.writes).toHaveLength(0);
  } finally { await oldResize.settle(); }
});

it.each([
  { intent: 'select', success: true }, { intent: 'clear', success: true },
  { intent: 'select', success: false }, { intent: 'clear', success: false },
  { intent: 'text', success: true }, { intent: 'text', success: false },
] as const)('waits for released resize ACK before $intent intent (success=$success)', async ({ intent, success }) => {
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    return String(input).includes('/raw/') ? new Response(original) : Response.json({ deployments: [] });
  });
  const view = render(<FileViewer projectId="resize-intent" projectKind="prototype" file={file} liveHtml={original} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const documentEpoch = manualEditFrameEpoch(frame);
  const posts = vi.spyOn(frame.contentWindow!, 'postMessage');
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { documentEpoch, ...data } }));
  posts.mockImplementation((message) => {
    if (message.type === 'readable-edit-end-text-edit' && typeof message.requestId === 'number') {
      send({ type: 'readable-edit-text-flushed', requestId: message.requestId, documentEpoch: message.documentEpoch });
    }
  });
  await act(async () => { send({ type: 'readable-edit-select', target: target('hero') }); });
  expect(handles.current).not.toBeNull();
  let finalizing!: Promise<void>;
  await act(async () => {
    handles.current!.onResizeStart?.();
    finalizing = Promise.resolve(handles.current!.onResizeCommit('e', { width: 240, height: 100 }, { width: 200, height: 100 }));
  });
  const command = posts.mock.calls.map(([message]) => message).find((message) => message.resize?.stage === 'finalize');
  expect(command).toBeTruthy();
  try {
    await act(async () => {
      if (intent === 'text') {
        const surface = screen.getByLabelText('Move element');
        expect(surface.hasAttribute('data-readable-edit-selected-surface')).toBe(true);
        surface.focus();
        fireEvent.keyDown(surface, { key: 'Enter' });
      } else send(intent === 'select' ? { type: 'readable-edit-select', target: target('other') } : { type: 'readable-edit-background' });
    });
    expect(screen.getByTestId('selected-target').getAttribute('data-target-id')).toBe('hero');
    expect(posts.mock.calls.some(([message]) => message.type === 'readable-edit-begin-text-edit')).toBe(false);
    expect(writes).toHaveLength(0);
  } finally {
    await act(async () => {
      send({ ...command.resize, type: 'readable-edit-preview-style-applied', id: 'hero', version: command.version,
        ok: success, rect: { x: 20, y: 20, width: 240, height: 100 },
        resize: { decision: 'ordinary', constraints: [], causes: [], safetyFailures: [], confidence: 'confirmed', classification: 'ordinary' },
      });
      await finalizing;
    });
  }
  if (!success) {
    expect(screen.getByTestId('selected-target').getAttribute('data-target-id')).toBe('hero');
    expect(new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector<HTMLElement>('[data-readable-id="hero"]')?.style.width).toBe('200px');
    expect(posts.mock.calls.some(([message]) => message.type === 'readable-edit-begin-text-edit')).toBe(false);
    const external = original.replace('Hero', 'External version');
    await act(async () => {
      view.rerender(<FileViewer projectId="resize-intent" projectKind="prototype" file={file} liveHtml={external} />);
    });
    expect(screen.queryByTestId('selected-target')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    const epoch = manualEditFrameEpoch(frame);
    await act(async () => { send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Edited external version', documentEpoch: epoch }); });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toContain('Edited external version');
    return;
  }
  if (intent === 'text') expect(posts.mock.calls.some(([message]) => message.type === 'readable-edit-begin-text-edit')).toBe(true);
  else if (intent === 'select') expect(screen.getByTestId('selected-target').getAttribute('data-target-id')).toBe('other');
  else expect(screen.queryByTestId('selected-target')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(new DOMParser().parseFromString(writes[0]!, 'text/html').querySelector<HTMLElement>('[data-readable-id="hero"]')?.style.width).toBe('240px');
});
