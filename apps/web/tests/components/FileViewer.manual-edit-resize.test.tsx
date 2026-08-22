// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';

beforeEach(() => {
  // Handles rAF-throttle their preview flush; run it synchronously so drag
  // assertions don't need to await a real animation frame.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer manual edit resize handles', () => {
  const SOURCE = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';

  async function previewFrame() {
    return waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      if (!node.contentWindow) throw new Error('Preview frame not ready');
      return node;
    });
  }

  async function selectManualEditTarget(target = heroTarget()) {
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('manual-edit-shape-toolbar')).toBeTruthy();
    });
    expect(document.querySelector('.manual-edit-right')).toBeNull();
  }

  function seHandle() {
    return screen.getByLabelText('Resize bottom-right corner') as HTMLButtonElement;
  }

  it('renders the 8 resize handles once a target is selected in edit mode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    for (const label of [
      'Resize top-left corner', 'Resize top edge', 'Resize top-right corner', 'Resize right edge',
      'Resize bottom-right corner', 'Resize bottom edge', 'Resize bottom-left corner', 'Resize left edge',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('clears hover around resize controls without forwarding overlay coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } })));
    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();
    const sendHover = () => act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-hover', target: { ...heroTarget(), id: 'hovered' } },
        source: frame.contentWindow,
      }));
    });
    sendHover();
    await waitFor(() => expect(screen.getByTestId('manual-edit-hover-open')).toBeTruthy());
    postSpy.mockClear();

    fireEvent.pointerEnter(se, { clientX: 300, clientY: 150 });
    expect(postSpy).toHaveBeenCalledWith({ type: 'readable-edit-hover-reset' }, '*');

    sendHover();
    await waitFor(() => expect(screen.getByTestId('manual-edit-hover-open')).toBeTruthy());
    postSpy.mockClear();
    fireEvent.pointerDown(se, { pointerId: 90, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 90, clientX: 340, clientY: 170 });
    fireEvent.pointerCancel(se, { pointerId: 90 });
    expect(postSpy).toHaveBeenCalledWith({ type: 'readable-edit-hover-reset' }, '*');
    expect(postSpy.mock.calls.some(([message]) => (
      (message as { type?: string }).type === 'readable-edit-hover-at'
    ))).toBe(false);
  });

  it('streams readable-edit-preview-style with width/height while dragging the SE handle', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();

    fireEvent.pointerDown(se, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          id: 'hero',
          styles: expect.objectContaining({
            width: expect.stringMatching(/px$/),
            height: expect.stringMatching(/px$/),
          }),
          includeAuthoredSize: false,
        }),
        '*',
      );
    });

    fireEvent.pointerUp(se, { pointerId: 1, clientX: 340, clientY: 170 });
  });

  it('reports only the axis affected by an edge resize', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } })));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const east = screen.getByLabelText('Resize right edge') as HTMLButtonElement;
    fireEvent.pointerDown(east, { pointerId: 59, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(east, { pointerId: 59, clientX: 340, clientY: 150 });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resize: {
            axes: ['width'],
            requested: { width: 200, height: 48 },
          },
        }),
        '*',
      );
    });

    fireEvent.keyDown(east, { key: 'Escape' });
  });

  it('reports constrained resize feedback only for the latest selected-target acknowledgement', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 60, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 60, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          id: 'hero',
          resize: {
            axes: ['width', 'height'],
            requested: { width: 200, height: 68 },
          },
        }),
        '*',
      );
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 68 },
          resize: {
            announce: true,
            constraints: [{
              axis: 'width', requested: 200, applied: 180, reason: 'max',
              property: 'max-width', value: '180px',
            }],
          },
        },
        source: frame.contentWindow,
      }));
    });

    expect((await screen.findByRole('status')).textContent).toContain('Width limited by max-width: 180px');
    expect(screen.getByRole('status').textContent).toContain('200px requested · 180px rendered');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 2,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 68 },
        },
        source: frame.contentWindow,
      }));
    });
    expect(screen.getByRole('status').textContent).toContain('Width limited by max-width: 180px');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 3,
          ok: true,
          rect: { x: 24, y: 24, width: 200, height: 68 },
          resize: { constraints: [] },
        },
        source: frame.contentWindow,
      }));
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 2,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 68 },
          resize: {
            constraints: [{ axis: 'width', requested: 200, applied: 180, reason: 'layout' }],
          },
        },
        source: frame.contentWindow,
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'other',
          version: 4,
          ok: true,
          rect: { x: 0, y: 0, width: 100, height: 50 },
          resize: {
            constraints: [{ axis: 'width', requested: 200, applied: 100, reason: 'layout' }],
          },
        },
        source: frame.contentWindow,
      }));
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 5,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 68 },
          resize: {
            announce: true,
            constraints: [{ axis: 'width', requested: 200, applied: 180, reason: 'layout' }],
          },
        },
        source: frame.contentWindow,
      }));
    });
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.keyDown(se, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not restore cleared resize feedback when a pre-cancel acknowledgement arrives late', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } })));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 61, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 61, clientX: 340, clientY: 170 });

    let resizeVersion = 0;
    await waitFor(() => {
      const resizePreview = postSpy.mock.calls
        .map(([message]) => message as { type?: string; version?: number; resize?: unknown })
        .find((message) => message.type === 'readable-edit-preview-style' && message.resize);
      expect(resizePreview?.version).toEqual(expect.any(Number));
      resizeVersion = resizePreview?.version ?? 0;
    });

    fireEvent.keyDown(se, { key: 'Escape' });

    const revertVersion = resizeVersion + 1;
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          id: 'hero',
          version: revertVersion,
        }),
        '*',
      );
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: resizeVersion,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 68 },
          resize: {
            constraints: [{ axis: 'width', requested: 200, applied: 180, reason: 'layout' }],
          },
        },
        source: frame.contentWindow,
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: revertVersion,
          ok: true,
          rect: heroTarget().rect,
        },
        source: frame.contentWindow,
      }));
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores resize acknowledgements from the inactive preview iframe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } })));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const inactiveFrame = screen.getByTestId('artifact-preview-frame-url-load') as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 48 },
          resize: {
            constraints: [{ axis: 'width', requested: 200, applied: 180, reason: 'layout' }],
          },
        },
        source: inactiveFrame.contentWindow,
      }));
    });

    expect(screen.queryByText('Width is limited by page layout')).toBeNull();
  });

  it('announces only the final constrained resize result while keeping preview feedback visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } })));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const frame = await previewFrame();
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 62, clientX: 300, clientY: 150 });
    const constraints = [
      { axis: 'width', requested: 200, applied: 180, reason: 'layout' },
      { axis: 'height', requested: 68, applied: 60, reason: 'layout' },
    ] as const;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 48 },
          resize: { constraints, announce: false },
        },
        source: frame.contentWindow,
      }));
    });

    expect(screen.getByText('Width is limited by page layout')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    const previewCallout = screen.getByTestId('manual-edit-resize-callout');
    expect(previewCallout.getAttribute('aria-hidden')).toBe('true');
    expect(previewCallout.getAttribute('role')).toBeNull();
    expect(previewCallout.getAttribute('aria-live')).toBeNull();
    expect(previewCallout.textContent).toContain('Width is limited by page layout · 180px');
    expect(previewCallout.textContent).toContain('Height is limited by page layout · 60px');
    expect(previewCallout.textContent).not.toContain('requested');
    expect(se.getAttribute('data-constrained')).toBe('true');
    expect(screen.getByTestId('manual-edit-resize-edge-e')).toBeTruthy();
    expect(screen.getByTestId('manual-edit-resize-edge-s')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 2,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 48 },
          resize: {
            constraints: [{
              axis: 'width', requested: 200, applied: 180, reason: 'max',
              property: 'max-width', value: '180px',
            }],
            announce: true,
          },
        },
        source: frame.contentWindow,
      }));
    });

    expect(screen.getByRole('status').textContent).toContain('200px requested');
    const finalCallout = screen.getByTestId('manual-edit-resize-callout');
    expect(finalCallout.textContent).toBe('Width limited by max-width: 180px · 180px');
    expect(screen.queryByTestId('manual-edit-resize-edge-s')).toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 3,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 48 },
          resize: { constraints: [] },
        },
        source: frame.contentWindow,
      }));
    });
    expect(screen.queryByTestId('manual-edit-resize-callout')).toBeNull();

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '120' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('commits width/height inline styles to the saved file on pointerup', async () => {
    let savedContent = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        savedContent = JSON.parse(String(init.body)).content as string;
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 2, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 2, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 2, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          id: 'hero',
          includeAuthoredSize: true,
          resize: {
            axes: ['width', 'height'],
            requested: { width: 200, height: 68 },
            includeDetails: true,
          },
        }),
        '*',
      );
    });
    expect(savedContent).toMatch(/data-readable-id="hero"[^>]*style="[^"]*width:\s*200px/);
    expect(savedContent).toMatch(/height:\s*68px/);

    await waitFor(() => {
      expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('200');
      expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('68');
    });
  });

  it('does not rebuild manual-edit srcDoc for matching saved-source refreshes, but rebuilds it once for an external change', async () => {
    let persistedSource = SOURCE;
    let savedSource = '';
    let resolveSave!: (response: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const rawResponseResolvers: Array<(response: Response) => void> = [];
    const textResponse = (content: string) => new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        savedSource = JSON.parse(String(init.body)).content as string;
        persistedSource = savedSource;
        return saveResponse;
      }
      if (url.includes('/api/projects/project-1/raw/')) {
        if (init?.cache === 'no-store') return Promise.resolve(textResponse(persistedSource));
        return new Promise<Response>((resolve) => {
          rawResponseResolvers.push(resolve);
        });
      }
      return Promise.resolve(textResponse(persistedSource));
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = htmlPreviewFile();
    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={file} />,
    );

    await waitFor(() => expect(rawResponseResolvers).toHaveLength(1));
    await act(async () => {
      rawResponseResolvers.shift()!(textResponse(SOURCE));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 58, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 58, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 58, clientX: 340, clientY: 170 });
    await waitFor(() => expect(savedSource).toMatch(/width:\s*200px/));

    const savedSrcDoc = frame.srcdoc;
    const savedRevision = manualEditDocumentRevision(savedSrcDoc);
    const refresh = async (key: number, content: string) => {
      rerender(
        <FileViewer
          projectId="project-1"
          projectKind="prototype"
          file={file}
          filesRefreshKey={key}
        />,
      );
      await waitFor(() => expect(rawResponseResolvers).toHaveLength(1));
      await act(async () => {
        rawResponseResolvers.shift()!(textResponse(content));
        await Promise.resolve();
      });
    };

    // A pending watcher echo can settle in the same microtask as the POST.
    rerender(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={file}
        filesRefreshKey={1}
      />,
    );
    await waitFor(() => expect(rawResponseResolvers).toHaveLength(1));
    await act(async () => {
      resolveSave(new Response(JSON.stringify({ file }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      rawResponseResolvers.shift()!(textResponse(savedSource));
      await Promise.resolve();
    });
    expect(frame.srcdoc).toBe(savedSrcDoc);
    expect(manualEditDocumentRevision(frame.srcdoc)).toBe(savedRevision);
    // Project metadata and the file watcher can each report this same save.
    await refresh(2, savedSource);
    expect(frame.srcdoc).toBe(savedSrcDoc);
    expect(manualEditDocumentRevision(frame.srcdoc)).toBe(savedRevision);

    const externalSource = savedSource.replace('>Hero</main>', '>Externally updated hero</main>');
    await refresh(3, externalSource);
    expect(frame.srcdoc).toContain('Externally updated hero');
    expect(frame.srcdoc).not.toBe(savedSrcDoc);
    expect(manualEditDocumentRevision(frame.srcdoc)).toBe(savedRevision + 1);
  });

  it.each([
    ['before', true],
    ['after', false],
  ])('does not let a stale save replace another file when its response arrives %s the new raw response', async (_order, saveFirst) => {
    const secondSource = '<!doctype html><html><body><main data-readable-id="hero">Second file</main></body></html>';
    let resolveSave!: (response: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const rawResponseResolvers = new Map<string, (response: Response) => void>();
    const textResponse = (content: string) => new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') return saveResponse;
      if (url.includes('/api/projects/project-1/raw/')) {
        if (init?.cache === 'no-store') return Promise.resolve(textResponse(SOURCE));
        const name = url.includes('/second.html') ? 'second.html' : 'preview.html';
        return new Promise<Response>((resolve) => rawResponseResolvers.set(name, resolve));
      }
      return Promise.resolve(textResponse(SOURCE));
    });
    vi.stubGlobal('fetch', fetchMock);
    const firstFile = htmlPreviewFile();
    const secondFile = htmlPreviewFile('second.html');
    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={firstFile} />,
    );

    await waitFor(() => expect(rawResponseResolvers.has('preview.html')).toBe(true));
    await act(async () => {
      rawResponseResolvers.get('preview.html')!(textResponse(SOURCE));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 81, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 81, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 81, clientX: 340, clientY: 170 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    ));

    rerender(
      <FileViewer projectId="project-1" projectKind="prototype" file={secondFile} />,
    );
    await waitFor(() => expect(rawResponseResolvers.has('second.html')).toBe(true));
    const resolveSaveResponse = async () => {
      await act(async () => {
        resolveSave(new Response(JSON.stringify({ file: firstFile }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
        await Promise.resolve();
      });
    };
    const resolveSecondSource = async () => {
      await act(async () => {
        rawResponseResolvers.get('second.html')!(textResponse(secondSource));
        await Promise.resolve();
      });
    };
    if (saveFirst) {
      await resolveSaveResponse();
      await resolveSecondSource();
    } else {
      await resolveSecondSource();
      await resolveSaveResponse();
    }

    const frame = await previewFrame();
    await waitFor(() => expect(frame.srcdoc).toContain('Second file'));
  });

  it.each([
    ['before', true],
    ['after', false],
  ])('keeps an external source when its watcher response arrives %s the save response', async (_order, watcherFirst) => {
    let persistedSource = SOURCE;
    let savedSource = '';
    let resolveSave!: (response: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const rawResponseResolvers: Array<(response: Response) => void> = [];
    const textResponse = (content: string) => new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        savedSource = JSON.parse(String(init.body)).content as string;
        persistedSource = savedSource;
        return saveResponse;
      }
      if (url.includes('/api/projects/project-1/raw/')) {
        if (init?.cache === 'no-store') return Promise.resolve(textResponse(persistedSource));
        return new Promise<Response>((resolve) => rawResponseResolvers.push(resolve));
      }
      return Promise.resolve(textResponse(persistedSource));
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = htmlPreviewFile();
    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={file} />,
    );

    await waitFor(() => expect(rawResponseResolvers).toHaveLength(1));
    await act(async () => {
      rawResponseResolvers.shift()!(textResponse(SOURCE));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const frame = await previewFrame();
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: watcherFirst ? 82 : 83, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: watcherFirst ? 82 : 83, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: watcherFirst ? 82 : 83, clientX: 340, clientY: 170 });
    await waitFor(() => expect(savedSource).toMatch(/width:\s*200px/));

    const externalSource = SOURCE.replace('>Hero</main>', '>Externally changed</main>');
    persistedSource = externalSource;
    rerender(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={file}
        filesRefreshKey={1}
      />,
    );
    await waitFor(() => expect(rawResponseResolvers).toHaveLength(1));
    const resolveWatcher = async () => {
      await act(async () => {
        rawResponseResolvers.shift()!(textResponse(externalSource));
        await Promise.resolve();
      });
    };
    const resolvePost = async () => {
      await act(async () => {
        resolveSave(new Response(JSON.stringify({ file }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
        await Promise.resolve();
      });
    };

    if (watcherFirst) {
      await resolveWatcher();
      await waitFor(() => expect(frame.srcdoc).toContain('Externally changed'));
      await resolvePost();
    } else {
      await act(async () => {
        resolveSave(new Response(JSON.stringify({ file }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
        rawResponseResolvers.shift()!(textResponse(externalSource));
        await Promise.resolve();
      });
    }

    await waitFor(() => expect(frame.srcdoc).toContain('Externally changed'));
  });

  it('blocks a second resize until the first resize commit finishes saving', async () => {
    let releaseSave: (() => void) | undefined;
    const savePending = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        await savePending;
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 62, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 62, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 62, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(se.disabled).toBe(true);
    });

    postSpy.mockClear();
    fireEvent.pointerDown(se, { pointerId: 63, clientX: 340, clientY: 170 });
    fireEvent.pointerMove(se, { pointerId: 63, clientX: 380, clientY: 190 });
    fireEvent.pointerUp(se, { pointerId: 63, clientX: 380, clientY: 190 });
    expect(postSpy).not.toHaveBeenCalled();

    releaseSave?.();
    await waitFor(() => {
      expect(se.disabled).toBe(false);
    });
  });

  it('commits CSS-space px, not rect-space px, for targets under an ancestor transform', async () => {
    // Deck fit-to-canvas transforms make rect px = CSS px * k. The drag delta
    // must be divided back by k and applied to the element's CSS size, or every
    // commit inflates the element and repeated resizes compound the drift.
    let savedContent = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        savedContent = JSON.parse(String(init.body)).content as string;
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget({
      ...heroTarget(),
      // Visual (rect) box 500x100 under a 1.25x ancestor scale; CSS box 400x80.
      rect: { x: 24, y: 24, width: 500, height: 100 },
      styles: { ...emptyManualEditStyles(), width: '400px', height: '80px' },
      rectScale: { x: 1.25, y: 1.25 },
    });

    const se = seHandle();
    fireEvent.pointerDown(se, { pointerId: 30, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 30, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 30, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // +40/+20 rect px at k=1.25 is +32/+16 CSS px on top of 400x80.
    expect(savedContent).toMatch(/data-readable-id="hero"[^>]*style="[^"]*width:\s*432px/);
    expect(savedContent).toMatch(/height:\s*96px/);
  });

  it('commits a margin-left compensation on a west drag so the grabbed edge holds', async () => {
    // Width alone grows an in-flow element eastward: the west edge (and the
    // handle the user is holding) would not move. The commit must shift the
    // box back by the same CSS delta via margin-left.
    let savedContent = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        savedContent = JSON.parse(String(init.body)).content as string;
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget({
      ...heroTarget(),
      styles: { ...emptyManualEditStyles(), width: '160px', marginLeft: '0px' },
    });

    const w = screen.getByLabelText('Resize left edge') as HTMLButtonElement;
    fireEvent.pointerDown(w, { pointerId: 50, clientX: 100, clientY: 150 });
    fireEvent.pointerMove(w, { pointerId: 50, clientX: 60, clientY: 150 });
    fireEvent.pointerUp(w, { pointerId: 50, clientX: 60, clientY: 150 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(savedContent).toMatch(/data-readable-id="hero"[^>]*style="[^"]*width:\s*200px/);
    expect(savedContent).toMatch(/margin-left:\s*-40px/);
  });

  it('anchors the next drag on the ack-reported computed size, not a clamped commit', async () => {
    // Drag 1 requests 200px but layout clamps the element at 180px (the ack
    // carries cssSize). Committing folds the requested 200px into the target
    // styles; without the computed anchor, drag 2 inward would spend its first
    // 20px inside a dead zone where nothing moves.
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const se = seHandle();

    // Drag 1: mouse implies 200x68; layout clamps at 180x60. The mid-drag ack
    // must NOT shift drag 1's own baseline (it is snapshotted at pointerdown).
    const midDragSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    fireEvent.pointerDown(se, { pointerId: 51, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 51, clientX: 340, clientY: 170 });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 60 },
          cssSize: { width: '180px', height: '60px' },
        },
        source: frame.contentWindow,
      }));
    });
    // A further move after the ack still previews from the pointerdown
    // baseline: 300->350 implies 210, not computed(180) + delta(50) = 230.
    midDragSpy.mockClear();
    fireEvent.pointerMove(se, { pointerId: 51, clientX: 350, clientY: 170 });
    await waitFor(() => {
      expect(midDragSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          styles: expect.objectContaining({ width: '210px' }),
        }),
        '*',
      );
    });
    fireEvent.pointerUp(se, { pointerId: 51, clientX: 340, clientY: 170 });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Drag 2: 20px inward from the measured 180px box must preview 160px
    // immediately (anchor = computed 180), not 180px (anchor = folded 200).
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    fireEvent.pointerDown(se, { pointerId: 52, clientX: 340, clientY: 170 });
    fireEvent.pointerMove(se, { pointerId: 52, clientX: 320, clientY: 170 });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style',
          id: 'hero',
          styles: expect.objectContaining({ width: '160px' }),
        }),
        '*',
      );
    });
    fireEvent.keyDown(se, { key: 'Escape' });
  });

  it('reverts a second drag to the just-committed size, not the pre-drag one', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const se = seHandle();

    // First drag: commit a new size.
    fireEvent.pointerDown(se, { pointerId: 20, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 20, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(se, { pointerId: 20, clientX: 340, clientY: 170 });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Second drag on the still-selected element, cancelled via Escape.
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    fireEvent.pointerDown(se, { pointerId: 21, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 21, clientX: 360, clientY: 190 });
    postSpy.mockClear();
    fireEvent.keyDown(se, { key: 'Escape' });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'readable-edit-preview-style', id: 'hero' }),
        '*',
      );
    });
    const revertCall = postSpy.mock.calls.find((call) => (
      (call[0] as { type?: string }).type === 'readable-edit-preview-style'
    ));
    // Revert restores the committed size (non-empty), not the pre-first-drag empty styles.
    // Margins revert too: a west/north drag preview may have shifted them.
    expect((revertCall?.[0] as { styles?: Record<string, string> }).styles).toEqual({
      width: '200px',
      height: '68px',
      marginLeft: '',
      marginRight: '',
      marginTop: '',
      marginBottom: '',
    });
  });

  it('tracks the element measured box from preview acks while dragging', async () => {
    // Flex/grid/min-content constraints can clamp or ignore the streamed
    // width/height, so mid-drag the handles must render the element's REAL box
    // (fed back through the readable-edit-preview-style-applied ack), not the
    // mouse-implied one.
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const se = seHandle();

    fireEvent.pointerDown(se, { pointerId: 40, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 40, clientX: 340, clientY: 170 });

    // The iframe reports the applied layout result: the element only reached
    // 180x60 at (30,28), not the mouse-implied 200x68 at the original anchor.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 30, y: 28, width: 180, height: 60 },
        },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      const container = seHandle().parentElement as HTMLElement;
      expect(container.style.left).toBe('30px');
      expect(container.style.top).toBe('28px');
      expect(seHandle().style.left).toBe('180px');
      expect(seHandle().style.top).toBe('60px');
    });

    fireEvent.keyDown(seHandle(), { key: 'Escape' });
  });

  it('keeps the ack-measured rect after commit instead of the mouse-derived size', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const se = seHandle();

    // Drag to a mouse-implied 200x68; layout clamps the element at 180x60.
    fireEvent.pointerDown(se, { pointerId: 41, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 41, clientX: 340, clientY: 170 });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: true,
          rect: { x: 24, y: 24, width: 180, height: 60 },
        },
        source: frame.contentWindow,
      }));
    });
    fireEvent.pointerUp(se, { pointerId: 41, clientX: 340, clientY: 170 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // The overlay must keep the measured 180x60, not snap to the requested 200x68.
    await waitFor(() => {
      expect(seHandle().style.left).toBe('180px');
      expect(seHandle().style.top).toBe('60px');
    });
  });

  it('reverts the preview and does not write the file on Escape mid-drag', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();

    fireEvent.pointerDown(se, { pointerId: 3, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 3, clientX: 340, clientY: 170 });
    postSpy.mockClear();
    fireEvent.keyDown(se, { key: 'Escape' });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'readable-edit-preview-style', id: 'hero' }),
        '*',
      );
    });
    const revertCall = postSpy.mock.calls.find((call) => (
      (call[0] as { type?: string }).type === 'readable-edit-preview-style'
    ));
    expect((revertCall?.[0] as { styles?: Record<string, unknown> }).styles).toEqual({
      width: '', height: '', marginLeft: '', marginRight: '', marginTop: '', marginBottom: '',
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.pointerUp(se, { pointerId: 3, clientX: 340, clientY: 170 });
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reverts the preview and does not write the file on pointercancel mid-drag', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const se = seHandle();

    fireEvent.pointerDown(se, { pointerId: 4, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 4, clientX: 340, clientY: 170 });
    postSpy.mockClear();
    fireEvent.pointerCancel(se, { pointerId: 4 });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'readable-edit-preview-style', id: 'hero' }),
        '*',
      );
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps the selected target panel-free while live geometry updates', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={SOURCE} />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    const frame = await previewFrame();
    // A geometry refresh (not a user selection) reporting the same element
    // moved far away — this is what the deferred readable-edit-targets re-broadcast
    // after a layout mutation looks like.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-targets',
          targets: [{ ...heroTarget(), rect: { x: 500, y: 500, width: 160, height: 48 } }],
        },
        source: frame.contentWindow,
      }));
    });

    // The live path stays live: the resize-handle overlay tracks the moved rect.
    await waitFor(() => {
      expect(seHandle().parentElement?.style.left).toBe('500px');
    });
    expect(seHandle().parentElement?.style.top).toBe('500px');

    expect(document.querySelector('.manual-edit-right')).toBeNull();
  });
});

function heroTarget(): ManualEditTarget {
  return {
    id: 'hero',
    kind: 'text',
    label: 'Hero',
    tagName: 'main',
    className: '',
    text: 'Hero',
    rect: { x: 24, y: 24, width: 160, height: 48 },
    fields: { text: 'Hero' },
    attributes: { 'data-readable-id': 'hero' },
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<main data-readable-id="hero">Hero</main>',
  };
}

function htmlPreviewFile(name = 'preview.html'): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1',
      kind: 'html',
      title: 'Preview',
      entry: name,
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function manualEditDocumentRevision(srcDoc: string): number {
  const match = srcDoc.match(/readable-studio:manual-edit-document-revision=(\d+)/);
  if (!match) throw new Error('Expected a Manual Edit document revision marker.');
  return Number(match[1]);
}
