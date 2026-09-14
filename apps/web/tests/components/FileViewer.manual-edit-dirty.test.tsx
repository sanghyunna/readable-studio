// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById(PORTAL_ID)?.remove();
});

const PORTAL_ID = 'manual-edit-test-host';

function createInspectorHost() {
  const host = document.createElement('div');
  host.id = PORTAL_ID;
  document.body.appendChild(host);
  return host;
}

function clickManualTool(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

async function previewFrame() {
  return waitFor(() => {
    const node = screen.getByTestId('artifact-preview-frame');
    if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) {
      throw new Error('Preview frame not ready');
    }
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
}

async function selectManualEditTargetInInspector(target = heroTarget()) {
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
}

function fileSaveCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const input = call[0];
    const init = call[1];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const method = typeof init === 'object'
      && init !== null
      && 'method' in init
      && typeof init.method === 'string'
      ? init.method
      : undefined;
    return url.includes('/api/projects/project-1/files') && method === 'POST';
  });
}

function buildFetchMock({ saveStatus = 200 }: { saveStatus?: number } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
      if (saveStatus >= 200 && saveStatus < 300) {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        message: 'save failed',
        ...(saveStatus === 409 ? { code: 'CONFLICT' } : {}),
      }), {
        status: saveStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(htmlSource(), { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
}

function htmlSource() {
  return '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
}

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

describe('FileViewer manual edit dirty-state persistence', () => {
  it('updates preview on text edit without persisting until explicit save', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Updated hero' },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => expect(frame.srcdoc).toContain('Updated hero'));
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('persists and exits when re-clicking the edit tool while dirty', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    let resolveSaved!: () => void;
    const saved = new Promise<void>((resolve) => { resolveSaved = resolve; });
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} onFileSaved={() => resolveSaved()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await act(async () => { clickManualTool('manual-edit-mode-toggle'); await saved; });

    expect(fileSaveCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('explains the block with a toast when another tool is clicked while dirty', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });

    expect(screen.queryByRole('alert')).toBeNull();

    clickManualTool('board-mode-toggle');

    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('You have unsaved edits');
    // Still blocked: the tool switch must not have happened.
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('board-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('shows Save and Discard actions while dirty', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    createInspectorHost();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource()}
        manualEditPortalId={PORTAL_ID}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTargetInInspector(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('shows Save and Discard actions without a portal host when dirty', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
    });
  });

  it('preserves the local preview when a watcher refresh arrives while dirty', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Local hero' },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => expect(frame.srcdoc).toContain('Local hero'));

    view.rerender(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource().replace('Hero', 'Server hero')}
        filesRefreshKey={1}
      />,
    );

    await waitFor(() => {
      expect(frame.srcdoc).toContain('Local hero');
      expect(frame.srcdoc).not.toContain('Server hero');
    });
  });

  it('hides dirty actions after undo restores the exact original source', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Edited hero' },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('saves with exactly one POST and exits on success', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    createInspectorHost();
    const onFileSaved = vi.fn();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource()}
        manualEditPortalId={PORTAL_ID}
        onFileSaved={onFileSaved}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTargetInInspector(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Final hero' },
        source: frame.contentWindow,
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(frame.srcdoc).toContain('Final hero');
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(fileSaveCalls(fetchMock)).toHaveLength(1);
      expect(onFileSaved).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
    });
    const serializedSaveCall = JSON.stringify(fileSaveCalls(fetchMock)[0]);
    expect(serializedSaveCall).toContain('Final hero');
    expect(serializedSaveCall).toMatch(/width:\s*200px/);
    expect(serializedSaveCall).toContain('11d9fe0100057e5836181fac66c1ba75bb9e8fb1d0e457dc370ebef23cbf5b6c');
  });

  it('exits edit mode without a duplicate save when post-save refresh rejects', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const onFileSaved = vi.fn(async () => {
      throw new Error('refresh failed');
    });
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource()}
        onFileSaved={onFileSaved}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(heroTarget());
    const frame = await previewFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Edited hero' },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(fileSaveCalls(fetchMock)).toHaveLength(1);
      expect(onFileSaved).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
    });
  });

  it('discards without writing and restores the original preview', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    createInspectorHost();
    const onFileSaved = vi.fn();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource()}
        manualEditPortalId={PORTAL_ID}
        onFileSaved={onFileSaved}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTargetInInspector(heroTarget());
    const frame = await previewFrame();
    for (const value of ['First edit', 'Second edit']) {
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'readable-edit-text-commit', id: 'hero', value },
          source: frame.contentWindow,
        }));
      });
      await waitFor(() => expect(frame.srcdoc).toContain(value));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(frame.srcdoc).toContain('First edit');
      expect(screen.getByRole('button', { name: 'Redo' }).hasAttribute('disabled')).toBe(false);
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => {
      expect(fileSaveCalls(fetchMock)).toHaveLength(0);
      expect(onFileSaved).not.toHaveBeenCalled();
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
      expect(frame.srcdoc).toContain('>Hero</main>');
      expect(frame.srcdoc).not.toContain('First edit');
    });

    clickManualTool('manual-edit-mode-toggle');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Redo' }).hasAttribute('disabled')).toBe(true);
    });
  });

  it('retains edits and actions when Save conflicts', async () => {
    const fetchMock = buildFetchMock({ saveStatus: 409 });
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={htmlSource()} />);

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(fileSaveCalls(fetchMock)).toHaveLength(1);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
    });
    expect(screen.getByDisplayValue('200')).toBeTruthy();
  });

  it('keeps edit mode active and dirty when Save fails', async () => {
    const fetchMock = buildFetchMock({ saveStatus: 500 });
    vi.stubGlobal('fetch', fetchMock);
    createInspectorHost();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={htmlSource()}
        manualEditPortalId={PORTAL_ID}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTargetInInspector(containerTarget());
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(fileSaveCalls(fetchMock)).toHaveLength(1);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    });
  });
});
