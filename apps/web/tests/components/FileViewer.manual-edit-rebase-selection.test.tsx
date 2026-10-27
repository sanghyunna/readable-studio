// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyManualEditStyles } from '../../src/edit-mode/types';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

vi.mock('../../src/components/ManualEditShapeToolbar', () => ({
  ManualEditShapeToolbar: () => <div data-testid="selected-object-toolbar" />,
}));
import { FileViewer } from '../../src/components/FileViewer';

const original = '<html><body><div data-readable-id="hero" style="width:120px">Original object</div><p>Other content</p></body></html>';
const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, kind: 'html', mime: 'text/html' } as const;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function setup() {
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(String(init.body));
    return new Response(original);
  });
  const props = { projectId: 'rebase-selection', projectKind: 'prototype' as const, file };
  const view = render(<FileViewer {...props} liveHtml={original} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const documentEpoch = manualEditFrameEpoch(frame);
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { documentEpoch, ...data },
  }));
  await act(async () => { send({ type: 'readable-edit-select', target: {
    id: 'hero', kind: 'container', label: 'Original object', tagName: 'div', className: '', text: 'Original object',
    rect: { x: 20, y: 20, width: 120, height: 40 }, fields: { text: 'Original object' }, attributes: {},
    styles: { ...emptyManualEditStyles(), width: '120px' }, isLayoutContainer: false,
    outerHtml: '<div data-readable-id="hero" style="width:120px">Original object</div>',
  } }); });
  expect(screen.getByTestId('selected-object-toolbar')).toBeTruthy();
  return { writes, view, props, send };
}

it.each(['changed', 'removed'])('drops stale selection and inspector when a clean external source has %s the object', async (change) => {
  const h = await setup();
  const external = change === 'changed'
    ? original.replace('width:120px', 'width:320px').replace('Original object', 'Agent replacement')
    : '<html><body><p data-readable-id="other">Agent replacement</p></body></html>';
  await act(async () => { h.view.rerender(<FileViewer {...h.props} liveHtml={external} />); });
  expect(screen.queryByTestId('selected-object-toolbar')).toBeNull();
  expect(screen.queryByLabelText('Move element')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc).toContain('Agent replacement');
  expect(h.writes).toHaveLength(0);
});

it('keeps the selected local object and unsaved changes when an external source is deferred', async () => {
  const h = await setup();
  await act(async () => { h.send({ type: 'readable-edit-text-commit', id: 'hero', value: 'Unsaved local object' }); });
  await act(async () => { h.view.rerender(<FileViewer {...h.props} liveHtml={original.replace('Original object', 'Agent replacement')} />); });
  expect(screen.getByTestId('selected-object-toolbar')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  expect(h.writes).toHaveLength(0);
});
