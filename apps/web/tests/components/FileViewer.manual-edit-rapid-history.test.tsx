// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const file: ProjectFile = {
  name: 'preview.html', path: 'preview.html', type: 'file', size: 1024,
  mtime: 1710000000, mime: 'text/html', kind: 'html',
  artifactManifest: {
    schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: 'Preview',
    entry: 'preview.html', renderer: 'html', exports: ['html'],
  },
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  { origin: 'host', batch: 0 }, { origin: 'host', batch: 1 },
  { origin: 'host', batch: 2 }, { origin: 'host', batch: 3 },
  { origin: 'bridge', batch: 0 }, { origin: 'bridge', batch: 1 },
  { origin: 'bridge', batch: 2 }, { origin: 'bridge', batch: 3 },
])('applies three synchronous shortcuts from $origin in undo/redo batch $batch', async ({ origin, batch }) => {
  // Given the three committed edits from packaged acceptance.
  const original = '<!doctype html><html><body><h1 data-readable-id="hero">Acceptance Heading</h1></body></html>';
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/raw/')
      ? new Response(original)
      : Response.json(url.includes('/deployments') ? { deployments: [] } : {});
  });
  render(<FileViewer projectId="rapid-history" projectKind="prototype" file={file} liveHtml={original} />);
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('Preview is not an iframe');
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  for (const value of ['Acceptance Edit 1', 'Acceptance Edit 2', 'Acceptance Edit 3']) {
    await act(async () => { send({ type: 'readable-edit-text-commit', id: 'hero', value }); });
  }
  expect(new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('h1')?.textContent).toBe('Acceptance Edit 3');

  const runBatch = (redo: boolean) => act(async () => {
    for (let index = 0; index < 3; index += 1) {
      if (origin === 'host') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: redo, bubbles: true }));
      else send({ type: 'readable-edit-undo', redo });
    }
  });
  for (let prior = 0; prior < batch; prior += 1) await runBatch(prior % 2 === 1);

  // When three shortcuts arrive synchronously before React renders.
  await runBatch(batch % 2 === 1);

  // Then all three distinct entries apply, including the second undo/redo cycle.
  expect(new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('h1')?.textContent)
    .toBe(batch % 2 === 1 ? 'Acceptance Edit 3' : 'Acceptance Heading');
});
