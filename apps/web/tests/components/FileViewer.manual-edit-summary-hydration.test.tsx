// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

const controls = vi.hoisted(() => ({
  current: null as ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar> | null,
}));
vi.mock('../../src/components/ManualEditShapeToolbar', async (original) => {
  const actual = await original<typeof import('../../src/components/ManualEditShapeToolbar')>();
  return { ...actual, ManualEditShapeToolbar: (props: ComponentProps<typeof actual.ManualEditShapeToolbar>) => {
    controls.current = props;
    return <actual.ManualEditShapeToolbar {...props} />;
  } };
});
import { FileViewer } from '../../src/components/FileViewer';

const source = '<!doctype html><html><body><div data-readable-id="first">First</div><div data-readable-id="second">Second</div><div data-readable-id="third">Third</div></body></html>';
const file: ProjectFile = { name: 'summary.html', path: 'summary.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
function target(id = 'first'): ManualEditTarget {
  return {
    id, kind: 'container', label: id, tagName: 'div', className: '', text: id,
    rect: { x: 20, y: 20, width: 160, height: 48 }, fields: {}, attributes: {},
    styles: { ...emptyManualEditStyles(), fontSize: '24px', fontWeight: '400', color: 'rgb(17, 34, 51)' },
    authoredSize: { width: 'auto', height: 'auto' }, cssSize: { width: '160px', height: '48px' },
    isLayoutContainer: false, outerHtml: `<div>${id}</div>`,
  };
}
function summary(id = 'first') {
  return { ...target(id), stylesMeasured: false, styles: emptyManualEditStyles(),
    authoredSize: undefined, rect: { x: 30, y: 40, width: 180, height: 54 } };
}
type HydrationRequest = { type: 'readable-edit-select-target'; id: string; documentEpoch?: string; actionSeq?: number };

afterEach(() => {
  cleanup();
  controls.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source)));
  render(<FileViewer projectId="summary-hydration" projectKind="prototype" file={file} liveHtml={source} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing preview iframe');
  const post = vi.spyOn(frame.contentWindow, 'postMessage');
  const documentEpoch = manualEditFrameEpoch(frame);
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { documentEpoch, ...data },
  }));
  const select = async (next = target()) => {
    await act(async () => { send({ type: 'readable-edit-select', target: next }); });
  };
  const requests = () => post.mock.calls.map(([message]) => message as HydrationRequest)
    .filter((message) => message.type === 'readable-edit-select-target');
  const requestHover = async (id = 'second') => {
    await act(async () => { send({ type: 'readable-edit-hover', target: summary(id) }); });
    await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-hover-open')); });
    const request = requests().at(-1);
    if (!request) throw new Error('Hover selection did not request the existing full-target command');
    return request;
  };
  const reply = async (request: HydrationRequest, override: object = {}) => {
    await act(async () => { send({ type: 'readable-edit-select', target: target(request.id),
      requestedId: request.id, actionSeq: request.actionSeq ?? 1, ...override }); });
  };
  await select();
  post.mockClear();
  return { frame, post, documentEpoch, send, select, requests, requestHover, reply };
}

describe('FileViewer discovery summary hydration', () => {
  it('keeps complete selected styles while a summary refreshes its geometry', async () => {
    const editor = await mount();
    await act(async () => { editor.send({ type: 'readable-edit-targets', targets: [summary(), summary('second')] }); });
    expect(controls.current!.target.styles.fontSize).toBe('24px');
    expect(controls.current!.target.styles.fontWeight).toBe('400');
    expect(controls.current!.target.styles.color).toBe('rgb(17, 34, 51)');
    expect(controls.current!.target.rect).toEqual(summary().rect);
    expect(controls.current!.target.authoredSize).toEqual(target().authoredSize);
    await act(async () => { editor.send({ type: 'readable-edit-targets', targets: [{ ...target(),
      styles: { ...target().styles, fontSize: '32px', fontWeight: '700' } }] }); });
    expect(controls.current!.target.styles.fontSize).toBe('32px');
    expect(controls.current!.target.styles.fontWeight).toBe('700');
  });

  it('requests full metadata before selecting an unmeasured summary', async () => {
    const editor = await mount();
    await editor.select(summary('second'));
    expect(controls.current!.target.id).toBe('first');
    const request = editor.requests().at(-1);
    expect(request).toMatchObject({ type: 'readable-edit-select-target', id: 'second', documentEpoch: editor.documentEpoch });
    expect(request?.actionSeq).toEqual(expect.any(Number));
    await editor.reply(request!);
    expect(controls.current!.target.id).toBe('second');
    expect(controls.current!.target.styles.fontSize).toBe('24px');
  });

  it('scopes hover hydration to the current document and action before accepting full metadata', async () => {
    const editor = await mount();
    const request = await editor.requestHover();
    expect(controls.current!.target.id).toBe('first');
    expect(request).toMatchObject({ id: 'second', documentEpoch: editor.documentEpoch, actionSeq: expect.any(Number) });
    await editor.reply(request);
    expect(controls.current!.target.id).toBe('second');
    expect(controls.current!.target.styles.fontWeight).toBe('400');
  });

  it.each(['requested identity', 'target identity', 'document epoch', 'action sequence'] as const)(
    'rejects a hydration reply with the wrong %s', async (field) => {
      const editor = await mount();
      const request = await editor.requestHover();
      const invalid = field === 'requested identity' ? { requestedId: 'third' }
        : field === 'target identity' ? { target: target('third') }
          : field === 'document epoch' ? { documentEpoch: `${editor.documentEpoch}-old` }
            : { actionSeq: (request.actionSeq ?? 1) - 1 };
      await editor.reply(request, invalid);
      expect(controls.current!.target.id).toBe('first');
      await editor.reply(request);
      expect(controls.current!.target.id).toBe('second');
    },
  );

  it('keeps a later explicit selection when an older hydration reply arrives', async () => {
    const editor = await mount();
    const request = await editor.requestHover('second');
    await editor.select(target('third'));
    expect(controls.current!.target.id).toBe('third');
    await editor.reply(request);
    expect(controls.current!.target.id).toBe('third');
  });

  it('hydrates a pending duplicate summary before exposing its selected inspector metadata', async () => {
    const editor = await mount();
    const messages = (type: string) => editor.post.mock.calls.map(([message]) => message)
      .filter((message) => message.type === type);
    const surface = document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]');
    expect(surface).not.toBeNull();
    await act(async () => { fireEvent.keyDown(surface!, { key: 'd', ctrlKey: true }); });
    await waitFor(() => expect(messages('readable-edit-duplicate-create')).toHaveLength(1));
    const create = messages('readable-edit-duplicate-create')[0]!;
    await act(async () => { editor.send({
      type: 'readable-edit-duplicate-preview', documentEpoch: create.documentEpoch,
      transactionId: create.transactionId, sequence: create.sequence, ok: true,
      rect: target().rect, placementOffset: { x: 0, y: 0 },
    }); });
    await waitFor(() => expect(messages('readable-edit-duplicate-update').length).toBeGreaterThan(0));
    const update = messages('readable-edit-duplicate-update').at(-1)!;
    await act(async () => { editor.send({
      type: 'readable-edit-duplicate-preview', documentEpoch: update.documentEpoch,
      transactionId: update.transactionId, sequence: update.sequence, ok: true,
      rect: { ...target().rect, x: 36, y: 36 }, placementOffset: { x: 0, y: 0 },
    }); });
    await waitFor(() => expect(messages('readable-edit-preview-source').at(-1)?.afterSource).toContain(create.duplicateRootId));
    await act(async () => { editor.send({ type: 'readable-edit-targets', targets: [summary(), summary(create.duplicateRootId), summary('second')] }); });
    await waitFor(() => expect(editor.requests().at(-1)?.id).toBe(create.duplicateRootId));
    expect(controls.current!.target.id).toBe('first');
    const request = editor.requests().at(-1)!;
    expect(request).toMatchObject({ documentEpoch: editor.documentEpoch, actionSeq: expect.any(Number) });
    await editor.reply(request);
    expect(controls.current!.target.id).toBe(create.duplicateRootId);
    expect(controls.current!.target.styles.fontSize).toBe('24px');
  });
});
