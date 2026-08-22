// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileViewer,
  cancelManualEditPendingStyleSnapshot,
  manualEditSupersededStyleKeys,
} from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer manual edit regressions', () => {
  function clickManualTool(testId: string) {
    fireEvent.click(screen.getByTestId(testId));
  }

  async function previewFrame() {
    return waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      if (!node.contentWindow) throw new Error('Preview frame not ready');
      return node;
    });
  }

  async function hoverManualEditTarget(target = heroTarget()) {
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-hover', target },
        source: frame.contentWindow,
      }));
    });
    // Hover only surfaces the affordance; it must not open any panel.
    await waitFor(() => {
      expect(screen.getByTestId('manual-edit-hover-open')).toBeTruthy();
    });
  }

  // Clicking the empty canvas is the gesture that opens the compact page card.
  async function sendManualEditBackground() {
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-background' },
        source: frame.contentWindow,
      }));
    });
  }

  async function clickManualEditBackground() {
    await sendManualEditBackground();
    await waitFor(() => {
      expect(document.querySelector('.manual-edit-right')).not.toBeNull();
    });
  }

  // Hover only surfaces the "edit params" affordance; selecting a target pins
  // the docked toolbars without mounting the page-styles card.
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

  function deferredResponse() {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  async function findStyleInput(label: string) {
    return waitFor(() => {
      const input = screen.queryByLabelText(label) as HTMLInputElement | null;
      if (!input) throw new Error(`${label} input not found`);
      return input;
    });
  }

  it('removes invalid fields from pending manual edit style saves without dropping unrelated fields', () => {
    expect(cancelManualEditPendingStyleSnapshot({
      id: 'hero',
      label: 'Style: Hero',
      version: 1,
      styles: { fontSize: '4px', color: '#111111' },
    }, 'hero', ['fontSize'])).toEqual({
      id: 'hero',
      label: 'Style: Hero',
      version: 1,
      styles: { color: '#111111' },
    });

    expect(cancelManualEditPendingStyleSnapshot({
      id: 'hero',
      label: 'Style: Hero',
      version: 1,
      styles: { fontSize: '4px' },
    }, 'hero', ['fontSize'])).toBeNull();

    const otherTargetPending = {
      id: 'hero',
      label: 'Style: Hero',
      version: 1,
      styles: { fontSize: '4px' },
    };
    expect(cancelManualEditPendingStyleSnapshot(otherTargetPending, 'cta', ['fontSize'])).toBe(otherTargetPending);
  });

  it('does not treat the entry a save just persisted as superseding its own keys', () => {
    // flushManualEditStyleSave leaves the pending ref pointing at the exact
    // styles object it saved until the save resolves (needed so a failed
    // save can be retried). reconcileManualEditStyleSave must not mistake
    // that for "a newer edit arrived" — id-equality alone isn't enough once
    // the ref stays populated during the save.
    const savedStyles = { width: '120px' };
    const justSavedPending = { id: 'hero', label: 'Style: Hero', version: 1, styles: savedStyles };
    expect(manualEditSupersededStyleKeys(justSavedPending, 'hero', savedStyles)).toEqual({});
  });

  it('treats a newer unsaved pending edit for the same target as superseding the old saved keys', () => {
    const savedStyles = { width: '120px' };
    const newerStyles = { width: '140px' };
    const newerPending = { id: 'hero', label: 'Style: Hero', version: 2, styles: newerStyles };
    expect(manualEditSupersededStyleKeys(newerPending, 'hero', savedStyles)).toBe(newerStyles);
  });

  it('treats no pending entry, or a pending entry for a different target, as nothing superseded', () => {
    expect(manualEditSupersededStyleKeys(null, 'hero', { width: '120px' })).toEqual({});
    const otherTargetPending = { id: 'cta', label: 'Style: CTA', version: 1, styles: { width: '90px' } };
    expect(manualEditSupersededStyleKeys(otherTargetPending, 'hero', { width: '120px' })).toEqual({});
  });

  it('opens edit mode with a clean canvas and no docked panel', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    // No panel auto-pops; the canvas stays clean.
    expect(document.querySelector('.manual-edit-right')).toBeNull();
    expect(screen.queryByText('PAGE')).toBeNull();

    // Hovering surfaces only the click affordance, still no panel.
    await hoverManualEditTarget();
    expect(document.querySelector('.manual-edit-right')).toBeNull();
    expect(screen.queryByText('PAGE')).toBeNull();
    expect(screen.getByTestId('manual-edit-hover-open')).toBeTruthy();
  });

  it('removes the hover affordance when the bridge reports no hover target', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));
    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await hoverManualEditTarget();
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-hover', target: null },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('manual-edit-hover-open')).toBeNull();
    });
  });

  it('keeps the Desktop edit preview sized to the live canvas', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    const viewerBody = document.querySelector<HTMLElement>('.viewer-body');
    expect(viewerBody).not.toBeNull();
    Object.defineProperty(viewerBody, 'clientWidth', { configurable: true, value: 1_188 });

    clickManualTool('manual-edit-mode-toggle');

    const frame = await previewFrame();
    let previewShell = frame.parentElement;
    while (previewShell && !previewShell.style.transform) previewShell = previewShell.parentElement;

    expect(previewShell?.style.width).toBe('100%');
  });

  it('opens the compact page-styles card when the empty canvas is clicked', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();

    expect(screen.getByText('PAGE')).toBeTruthy();
    expect(document.querySelector('.manual-edit-page-card')).not.toBeNull();
  });

  it('pins docked controls to a target only after clicking the hover affordance', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    const frame = await previewFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    await hoverManualEditTarget();
    // No panel until the affordance is clicked.
    expect(document.querySelector('.manual-edit-right')).toBeNull();

    fireEvent.click(screen.getByTestId('manual-edit-hover-open'));

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'readable-edit-select-target',
        id: 'hero',
      }), '*');
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-select',
          target: { ...heroTarget(), authoredSize: { width: '', height: '' } },
        },
        source: frame.contentWindow,
      }));
    });
    // A pinned text target gets both docked typography and shape controls.
    await findStyleInput('Width');
    expect(document.querySelector('.manual-edit-right')).toBeNull();
    expect(screen.queryByText('PAGE')).toBeNull();
    // Affordance hides once its element is the pinned selection.
    expect(screen.queryByTestId('manual-edit-hover-open')).toBeNull();
  });

  it('docks the typography toolbar for a text selection and posts rich-format on Bold', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();

    const bold = await waitFor(() => {
      const btn = document.querySelector('button[aria-label="Bold"]') as HTMLButtonElement | null;
      if (!btn) throw new Error('Toolbar Bold button not found');
      return btn;
    });
    // B/I/U stay disabled until the iframe reports a live, non-collapsed selection.
    expect(bold.disabled).toBe(true);

    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-selection-state',
          editing: true, hasSelection: true, bold: false, italic: false, underline: false,
        },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      expect((document.querySelector('button[aria-label="Bold"]') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(document.querySelector('button[aria-label="Bold"]')!);
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-rich-format', command: 'bold' }),
      '*',
    );
  });

  it('docks shape controls for every selected target without mounting the floating panel', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><img data-readable-id="photo" src="/old.png" alt="Old"></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    const targets = [
      heroTarget(),
      { ...heroTarget(), id: 'link', kind: 'link' as const, tagName: 'a', fields: { text: 'Link', href: '/next' } },
      { ...heroTarget(), id: 'token', kind: 'token' as const },
      containerTarget({ textEditTargetId: 'hero' }),
      containerTarget(),
      imageTarget(),
    ];

    for (const target of targets) {
      await selectManualEditTarget(target);
      expect(screen.getByLabelText('Spacing')).toBeTruthy();
      expect(document.querySelector('.manual-edit-right')).toBeNull();
    }

    fireEvent.click(screen.getByLabelText('More'));
    expect(screen.getByText('Upload image')).toBeTruthy();
  });

  it('surfaces shape preview-style errors in the docked toolbar', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '18' } });

    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: false,
          error: 'Target not found',
        },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Target not found');
    });
  });

  it('updates per-side padding from the spacing popover', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');

    fireEvent.click(screen.getByLabelText('Spacing'));
    fireEvent.change(screen.getByLabelText('Padding top'), { target: { value: '16' } });

    await waitFor(() => {
      expect((screen.getByLabelText('Padding top') as HTMLInputElement).value).toBe('16');
    });
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { paddingTop: '16px' },
        includeAuthoredSize: true,
      }),
      '*',
    );
  });

  it('keeps the latest shape selection requested while a style save is in flight', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section><aside data-readable-id="cta">CTA</aside></body></html>';
    const save = deferredResponse();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') return save.promise;
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    const frame = await previewFrame();
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'readable-edit-preview-style', id: 'hero' }),
        '*',
      );
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target: containerTarget({ id: 'trend', label: 'Trend', styles: { ...emptyManualEditStyles(), width: '222px' } }) },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target: containerTarget({ id: 'cta', label: 'CTA', styles: { ...emptyManualEditStyles(), width: '333px' } }) },
        source: frame.contentWindow,
      }));
    });
    save.resolve(new Response(JSON.stringify({ file: htmlPreviewFile() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await waitFor(() => {
      expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('333');
    });
  });

  it('keeps a background click newer than a pending shape selection after the save resolves', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section></body></html>';
    const save = deferredResponse();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') return save.promise;
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    const frame = await previewFrame();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target: containerTarget({ id: 'trend', label: 'Trend', styles: { ...emptyManualEditStyles(), width: '222px' } }) },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-background' },
        source: frame.contentWindow,
      }));
    });
    save.resolve(new Response(JSON.stringify({ file: htmlPreviewFile() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('manual-edit-shape-toolbar')).toBeNull();
      expect(screen.getByText('PAGE')).toBeTruthy();
    });
  });

  it('keeps manual edit mode exited when exit is newer than a pending shape selection save', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section></body></html>';
    const save = deferredResponse();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') return save.promise;
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    const frame = await previewFrame();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target: containerTarget({ id: 'trend', label: 'Trend', styles: { ...emptyManualEditStyles(), width: '222px' } }) },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    clickManualTool('manual-edit-mode-toggle');
    save.resolve(new Response(JSON.stringify({ file: htmlPreviewFile() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('manual-edit-shape-toolbar')).toBeNull();
      expect(screen.queryByText('PAGE')).toBeNull();
    });
  });

  it('saves a pending text-target style edit before clearing selection on background click', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });

    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-background' },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(([input, init]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        return url.includes('/api/projects/project-1/files') && init?.method === 'POST';
      });
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(String((saveCall?.[1] as RequestInit).body));
      expect(body.content).toContain('width: 111px');
      expect(screen.getByText('PAGE')).toBeTruthy();
    });
  });

  it('does not let a pending manual edit style save survive a file switch', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('<!doctype html><html><body></body></html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = htmlPreviewFile();
    const second = { ...htmlPreviewFile(), name: 'second.html', path: 'second.html' };
    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={first}
        liveHtml='<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>'
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const baseSizeInput = await findStyleInput('Width');
    fireEvent.change(baseSizeInput, { target: { value: '18' } });

    rerender(
      <FileViewer projectId="project-1" projectKind="prototype" file={second}
        liveHtml='<!doctype html><html><body><main data-readable-id="second">Second</main></body></html>'
      />,
    );

    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('clears loaded source immediately on file switch without liveHtml before manual edit can save', async () => {
    let secondResolve!: (value: Response) => void;
    const secondFetch = new Promise<Response>((resolve) => {
      secondResolve = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/second.html')) return secondFetch;
      return new Response('<!doctype html><html><body><main data-readable-id="hero">First</main></body></html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const first = htmlPreviewFile();
      const second = { ...htmlPreviewFile(), name: 'second.html', path: 'second.html' };
      const { rerender } = render(<FileViewer projectId="project-1" projectKind="prototype" file={first} />);

      // The raw fetch is cache-busted on every mtime / reload / files-refresh
      // bump so srcDoc-mode previews see fresh HTML after agent edits.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/projects\/project-1\/raw\/preview\.html(\?|$)/),
        {},
      ));
      fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
      await selectManualEditTarget();
      const baseSizeInput = await findStyleInput('Width');
      fireEvent.change(baseSizeInput, { target: { value: '18' } });

      rerender(<FileViewer projectId="project-1" projectKind="prototype" file={second} />);
      fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });

      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
      secondResolve(new Response('<!doctype html><html><body><main data-readable-id="second">Second</main></body></html>', { status: 200 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a prior manual edit save error after a later successful save', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    let saveAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          return new Response(JSON.stringify({
            error: { code: 'FORBIDDEN', message: 'Request failed (403).' },
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(source, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();
    const baseSizeInput = await findStyleInput('Width');

    fireEvent.change(baseSizeInput, { target: { value: '18' } });
    await sendManualEditBackground();
    await waitFor(() => {
      expect(screen.getByText(/Could not save the edited file/)).toBeTruthy();
    });

    fireEvent.change(baseSizeInput, { target: { value: '19' } });
    await sendManualEditBackground();
    await waitFor(() => {
      expect(screen.queryByText(/Could not save the edited file/)).toBeNull();
      expect(saveAttempts).toBe(2);
    });
  });

  it('retries the actual save when background clear is requested again after a failure', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    let postAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        postAttempts += 1;
        return new Response(JSON.stringify({
          error: { code: 'FORBIDDEN', message: 'Request failed (403).' },
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(source, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();
    const baseSizeInput = await findStyleInput('Width');

    fireEvent.change(baseSizeInput, { target: { value: '18' } });
    await sendManualEditBackground();
    await waitFor(() => {
      expect(screen.getByText(/Could not save the edited file/)).toBeTruthy();
    });
    expect(postAttempts).toBe(1);

    // No further edits: requesting the clear again must retry the write, not
    // silently treat the still-unsaved change as done.
    await sendManualEditBackground();
    await waitFor(() => {
      expect(postAttempts).toBe(2);
    });
  });

  it('surfaces a preview-style-applied failure from the iframe as a manual edit error', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();
    const baseSizeInput = await findStyleInput('Width');
    fireEvent.change(baseSizeInput, { target: { value: '18' } });

    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style-applied',
          id: 'hero',
          version: 1,
          ok: false,
          error: 'Target not found',
        },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Target not found')).toBeTruthy();
    });
  });

  it('keeps page styles open when selecting a target fails to save, then selects it on retry', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    let saveAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Request failed (403).' } }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();
    const baseSizeInput = screen.getByText('Base size').closest('label')?.querySelector('input');
    expect(baseSizeInput).toBeTruthy();
    fireEvent.change(baseSizeInput!, { target: { value: '18' } });

    const frame = await previewFrame();
    const selectTarget = () => act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target: heroTarget() },
        source: frame.contentWindow,
      }));
    });
    selectTarget();

    await waitFor(() => {
      expect(saveAttempts).toBe(1);
      expect(screen.getByText(/Could not save the edited file/)).toBeTruthy();
    });
    expect(document.querySelector('.manual-edit-right')).not.toBeNull();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.queryByTestId('manual-edit-shape-toolbar')).toBeNull();

    selectTarget();

    await waitFor(() => {
      expect(saveAttempts).toBe(2);
      expect(screen.getByTestId('manual-edit-shape-toolbar')).toBeTruthy();
      expect(document.querySelector('.manual-edit-right')).toBeNull();
    });
  });

  it('closes the page-styles card without saving on cancel, staying in edit mode', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async () =>
      new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(document.querySelector('.manual-edit-right')).toBeNull();
    });
    expect(document.querySelector('.manual-edit-workspace')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('closes the page-styles card after save succeeds, staying in edit mode', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();
    const baseSizeInput = screen.getByText('Base size').closest('label')?.querySelector('input');
    expect(baseSizeInput).toBeTruthy();

    fireEvent.change(baseSizeInput!, { target: { value: '18' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/files',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(document.querySelector('.manual-edit-right')).toBeNull();
    });
    expect(document.querySelector('.manual-edit-workspace')).not.toBeNull();
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

function containerTarget(overrides: Partial<ManualEditTarget> = {}): ManualEditTarget {
  return {
    ...heroTarget(),
    kind: 'container',
    text: '',
    fields: {},
    outerHtml: '<main data-readable-id="hero">Hero</main>',
    ...overrides,
  };
}

function imageTarget(): ManualEditTarget {
  return {
    ...heroTarget(),
    id: 'photo',
    kind: 'image',
    label: 'Photo',
    tagName: 'img',
    text: '',
    fields: { src: '/old.png', alt: 'Old' },
    attributes: { 'data-readable-id': 'photo', src: '/old.png', alt: 'Old' },
    outerHtml: '<img data-readable-id="photo" src="/old.png" alt="Old">',
  };
}

function htmlPreviewFile(): ProjectFile {
  return {
    name: 'preview.html',
    path: 'preview.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1',
      kind: 'html',
      title: 'Preview',
      entry: 'preview.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}
