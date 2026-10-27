// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { manualEditFrameEpoch } from './manual-edit-frame-messages';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('keeps the known legacy bridge identifiable after asset inlining so current editing can disable it', async () => {
  window.history.replaceState(null, '', '/?forceInline=1');
  const source = '<html><body><p data-readable-id="hero">Original text</p>'
    + '<script src="assets/readable-direct-edit.js"></script><script src="assets/ordinary.js"></script></body></html>';
  const file = { name: 'preview.html', path: 'preview.html', type: 'file', size: source.length, mtime: 1, kind: 'html', mime: 'text/html' } as const;
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).content);
      return Response.json({ file });
    }
    const url = String(input);
    if (url.endsWith('/assets/readable-direct-edit.js')) return new Response('window.legacyDirectEditBoots = 1;');
    if (url.endsWith('/assets/ordinary.js')) return new Response('window.ordinaryScriptBoots = 1;');
    return url.includes('/raw/') ? new Response(source) : Response.json({ deployments: [] });
  });
  render(<FileViewer projectId="legacy-inline" projectKind="prototype" file={file} liveHtml={source} />);
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  // An ordinary script proves the real asset-inlining continuation completed.
  await waitFor(() => expect(frame.srcdoc).toContain('window.ordinaryScriptBoots = 1;'));
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const preview = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
  const legacy = preview.querySelector('script[src="assets/readable-direct-edit.js"]');
  expect(legacy).not.toBeNull();
  expect(legacy?.getAttribute('type')).toBe('application/x-readable-disabled-script');
  expect(preview.querySelector('script[src="assets/ordinary.js"]')).toBeNull();
  expect(preview.body.textContent).toContain('window.ordinaryScriptBoots = 1;');
  const documentEpoch = manualEditFrameEpoch(frame);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
      data: { type: 'readable-edit-text-commit', documentEpoch, id: 'hero', value: 'Edited text' } }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  const canonical = new DOMParser().parseFromString(writes[0]!, 'text/html');
  expect(canonical.querySelector('script[src="assets/readable-direct-edit.js"]')?.getAttribute('type')).toBeNull();
  expect(canonical.querySelector('script[src="assets/ordinary.js"]')).not.toBeNull();
  expect(canonical.querySelector('[data-readable-id="hero"]')?.textContent).toBe('Edited text');
});
