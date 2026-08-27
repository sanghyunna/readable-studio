// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';

const toolbarState = vi.hoisted(() => ({
  props: null as ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar> | null,
}));

vi.mock('../../src/components/ManualEditShapeToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ManualEditShapeToolbar')>();
  return {
    ...actual,
    ManualEditShapeToolbar: (props: ComponentProps<typeof actual.ManualEditShapeToolbar>) => {
      toolbarState.props = props;
      return <div data-testid="mock-manual-edit-shape-toolbar" />;
    },
  };
});

import { FileViewer } from '../../src/components/FileViewer';

const INITIAL_SOURCE = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';

async function previewFrame() {
  return waitFor(() => {
    const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    if (!node.contentWindow) throw new Error('Preview frame not ready');
    return node;
  });
}

async function selectHero() {
  const frame = await previewFrame();
  act(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'readable-edit-select', target: heroTarget() },
    source: frame.contentWindow,
  })));
  await waitFor(() => expect(toolbarState.props).not.toBeNull());
}

function buildFetchMock(source = INITIAL_SOURCE) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
      return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/deployments')) {
      return new Response(JSON.stringify({ deployments: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
}

function fileSaveCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    return url.includes('/api/projects/project-1/files') && init?.method === 'POST';
  });
}

function dispatchUndo(redo = false) {
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z', ctrlKey: true, shiftKey: redo, bubbles: true,
  })));
}

async function expectPreviewContains(value: string) {
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc).toContain(value));
}

afterEach(() => {
  cleanup();
  toolbarState.props = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer manual edit undo keyboard shortcut', () => {
  it('undoes and redoes manual edits with Ctrl+Z / Ctrl+Shift+Z while editing', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero'));
    await expectPreviewContains('Edited hero');
    dispatchUndo();
    await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc).not.toContain('Edited hero'));
    dispatchUndo(true);
    await expectPreviewContains('Edited hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('undoes a rich set-inner-html commit with Ctrl+Z', async () => {
    const source = '<!doctype html><html><body><p data-readable-id="hero">Plain copy</p></body></html>';
    const fetchMock = buildFetchMock(source);
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={source} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();
    act(() => toolbarState.props?.onApplyPatch({
      id: 'hero', kind: 'set-inner-html', html: '<strong>Plain</strong> copy',
    }, 'Edit text'));
    await waitFor(() => {
      const previewSource = (screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc;
      expect(previewSource).toMatch(/<strong(?:\s[^>]*)?>Plain<\/strong> copy/);
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    dispatchUndo();
    await waitFor(() => {
      const previewSource = (screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc
        .replace(/ data-readable-source-path="[^"]*"/g, '');
      expect(previewSource).toContain('<p data-readable-id="hero">Plain copy</p>');
      expect(previewSource).not.toContain('<strong');
    });
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('ignores Ctrl+Z that originates from an input field', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();
    act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero'));
    await expectPreviewContains('Edited hero');
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    expect((await previewFrame()).srcdoc).toContain('Edited hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    input.remove();
  });

  it('undoes and redoes a multi-step manual edit stack in order', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();
    for (const value of ['Alpha', 'Bravo', 'Charlie']) {
      act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value }, 'Content: Hero'));
      await expectPreviewContains(value);
    }
    for (const value of ['Bravo', 'Alpha', 'Hero']) {
      dispatchUndo();
      await expectPreviewContains(value);
    }
    for (const value of ['Alpha', 'Bravo', 'Charlie']) {
      dispatchUndo(true);
      await expectPreviewContains(value);
    }
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('drops undo history when the viewed file context changes', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();
    act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero'));
    await expectPreviewContains('Edited hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(fileSaveCalls(fetchMock)).toHaveLength(1));
    const otherSource = '<!doctype html><html><body><h1 data-readable-id="hero">Other hero</h1></body></html>';
    rerender(<FileViewer projectId="project-1" projectKind="prototype" file={otherPreviewFile()} liveHtml={otherSource} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await expectPreviewContains('Other hero');
    dispatchUndo();
    expect((await previewFrame()).srcdoc).toContain('Other hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(1);
  });

  it('undoes and redoes via the bridge-forwarded readable-edit-undo message', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = await previewFrame();
    const frameWindow = frame.contentWindow;
    await selectHero();
    act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero'));
    await expectPreviewContains('Edited hero');
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'readable-edit-undo', redo: false }, source: frameWindow })));
    await waitFor(() => expect(frame.srcdoc).not.toContain('Edited hero'));
    expect(frame.contentWindow).toBe(frameWindow);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'readable-edit-undo', redo: true }, source: frameWindow })));
    await expectPreviewContains('Edited hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
  });

  it('ignores Ctrl+Z dispatched from a contentEditable host element', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()} liveHtml={INITIAL_SOURCE} />);
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();
    act(() => toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero'));
    await expectPreviewContains('Edited hero');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    act(() => editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    expect((await previewFrame()).srcdoc).toContain('Edited hero');
    expect(fileSaveCalls(fetchMock)).toHaveLength(0);
    editable.remove();
  });
});

function htmlPreviewFile(): ProjectFile {
  return {
    name: 'preview.html', path: 'preview.html', type: 'file', size: 1024,
    mtime: 1710000000, mime: 'text/html', kind: 'html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: 'Preview',
      entry: 'preview.html', renderer: 'html', exports: ['html'],
    },
  };
}

function otherPreviewFile(): ProjectFile {
  return { ...htmlPreviewFile(), name: 'other.html', path: 'other.html', mtime: 1710000001 };
}

function heroTarget(): ManualEditTarget {
  return {
    id: 'hero', kind: 'text', label: 'Hero', tagName: 'h1', className: '', text: 'Hero',
    rect: { x: 0, y: 0, width: 120, height: 40 }, fields: { text: 'Hero' },
    attributes: { 'data-readable-id': 'hero' }, styles: emptyManualEditStyles(),
    isLayoutContainer: false, outerHtml: '<h1 data-readable-id="hero">Hero</h1>',
  };
}
