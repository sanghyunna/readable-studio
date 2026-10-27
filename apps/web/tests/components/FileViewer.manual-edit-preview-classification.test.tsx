// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

const controls = vi.hoisted(() => ({
  current: null as ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar> | null,
}));
vi.mock('../../src/components/ManualEditShapeToolbar', () => ({
  ManualEditShapeToolbar: (props: ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar>) => {
    controls.current = props;
    return <div data-testid="classification-controls" />;
  },
}));
import { FileViewer } from '../../src/components/FileViewer';

const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, kind: 'html', mime: 'text/html' } as const;
afterEach(() => { cleanup(); controls.current = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(source: string) {
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    return String(input).includes('/raw/') ? new Response(source) : Response.json({ deployments: [] });
  });
  render(<FileViewer projectId="preview-classification" projectKind="prototype" file={file} liveHtml={source} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const documentEpoch = manualEditFrameEpoch(frame);
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { documentEpoch, ...data } }));
  const save = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    return new DOMParser().parseFromString(writes[0]!, 'text/html');
  };
  return { frame, send, save };
}

it('does not rebuild the frozen preview when deleting its last slide-shaped container', async () => {
  const h = await setup('<html><body><section class="slide" data-readable-id="hero">Last slide</section><footer>Keep footer</footer></body></html>');
  const target: ManualEditTarget = { id: 'hero', kind: 'container', label: 'Last slide', tagName: 'section', className: 'slide',
    text: 'Last slide', rect: { x: 0, y: 0, width: 800, height: 450 }, fields: {}, attributes: {},
    styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<section>Last slide</section>' };
  await act(async () => { h.send({ type: 'readable-edit-select', target }); });
  const entry = h.frame.srcdoc;
  await act(async () => { await controls.current!.onApplyPatch({ kind: 'remove-element', id: 'hero' }, 'Delete slide shape'); });
  expect(h.frame.srcdoc).toBe(entry);
  const saved = await h.save();
  expect(saved.querySelector('.slide')).toBeNull();
  expect(saved.querySelector('footer')?.textContent).toBe('Keep footer');
});

it('keeps text edits in place when their literal content changes the deck heuristic', async () => {
  const h = await setup('<html><body><p data-readable-id="hero">Original text</p></body></html>');
  const entry = h.frame.srcdoc;
  await act(async () => { h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'The literal is class="slide".' }); });
  expect(h.frame.srcdoc).toBe(entry);
  expect((await h.save()).querySelector('p')?.textContent).toBe('The literal is class="slide".');
});
