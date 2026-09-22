// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileViewer,
  cancelManualEditPendingStyleSnapshot,
  manualEditSupersededStyleKeys,
} from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { getEn } from '../../src/i18n/locales/en';
const en = getEn();
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById('manual-edit-test-host')?.remove();
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
      expect(screen.getByLabelText('Width')).toBeTruthy();
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
      expect(screen.getByRole('alert').textContent).toBe(en['manualEdit.error.previewStyleFailed']);
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

  it('keeps the latest shape selection requested while style edits are pending', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section><aside data-readable-id="cta">CTA</aside></body></html>';
    const fetchMock = vi.fn(async () => new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    const frame = await previewFrame();
    for (const target of [
      containerTarget({ id: 'trend', label: 'Trend', styles: { ...emptyManualEditStyles(), width: '222px' } }),
      containerTarget({ id: 'cta', label: 'CTA', styles: { ...emptyManualEditStyles(), width: '333px' } }),
    ]) {
      act(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-select', target }, source: frame.contentWindow,
      })));
    }

    await waitFor(() => expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('333'));
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
  });

  it('blocks a background click while a shape edit is dirty', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section></body></html>';
    const fetchMock = vi.fn(async () => new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    await sendManualEditBackground();

    expect(screen.getByTestId('manual-edit-shape-toolbar')).toBeTruthy();
    expect(screen.queryByText('PAGE')).toBeNull();
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps manual edit mode active when saving through the edit toggle conflicts', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main><section data-readable-id="trend">Trend</section></body></html>';
    let resolveRequested!: () => void;
    const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        resolveRequested();
        return new Response(JSON.stringify({ code: 'CONFLICT' }), { status: 409 });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    await act(async () => { clickManualTool('manual-edit-mode-toggle'); await requested; });

    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('manual-edit-shape-toolbar')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps a text target selected when a background click occurs while dirty', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async () => new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '111' } });
    await sendManualEditBackground();

    expect(screen.getByTestId('manual-edit-shape-toolbar')).toBeTruthy();
    expect(screen.queryByText('PAGE')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
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

  it('clears a prior manual edit save error after a later explicit save succeeds', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    let saveAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        saveAttempts += 1;
        if (saveAttempts === 1) return new Response(JSON.stringify({ error: { message: 'Request failed (403).' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    host.id = 'manual-edit-test-host';
    document.body.appendChild(host);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} manualEditPortalId="manual-edit-test-host" />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();
    fireEvent.change(await findStyleInput('Width'), { target: { value: '18' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Could not save the edited file/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(screen.queryByText(/Could not save the edited file/)).toBeNull();
      expect(saveAttempts).toBe(2);
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('retries the actual save only when explicit Save is requested again after a failure', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    let postAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        postAttempts += 1;
        return new Response(JSON.stringify({ error: { message: 'Request failed (403).' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    host.id = 'manual-edit-test-host';
    document.body.appendChild(host);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} manualEditPortalId="manual-edit-test-host" />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();
    fireEvent.change(await findStyleInput('Width'), { target: { value: '18' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(postAttempts).toBe(1));
    await sendManualEditBackground();
    expect(postAttempts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(postAttempts).toBe(2));
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
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
      expect(screen.getByText(en['manualEdit.error.previewStyleFailed'])).toBeTruthy();
    });
  });

  it('keeps page styles open when selecting a target while page edits are dirty', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async () => new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();
    const baseSizeInput = screen.getByText('Base size').closest('label')?.querySelector('input');
    expect(baseSizeInput).toBeTruthy();
    fireEvent.change(baseSizeInput!, { target: { value: '18' } });
    const frame = await previewFrame();
    act(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'readable-edit-select', target: heroTarget() }, source: frame.contentWindow,
    })));

    expect(document.querySelector('.manual-edit-right')).not.toBeNull();
    expect(screen.queryByTestId('manual-edit-shape-toolbar')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
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

  it('applies page styles to the transaction and closes the card without persisting', async () => {
    const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
    const fetchMock = vi.fn(async () => new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);

    clickManualTool('manual-edit-mode-toggle');
    await clickManualEditBackground();
    const baseSizeInput = screen.getByText('Base size').closest('label')?.querySelector('input');
    expect(baseSizeInput).toBeTruthy();
    fireEvent.change(baseSizeInput!, { target: { value: '18' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(document.querySelector('.manual-edit-right')).toBeNull());
    expect(document.querySelector('.manual-edit-workspace')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1/files', expect.objectContaining({ method: 'POST' }),
    );
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
