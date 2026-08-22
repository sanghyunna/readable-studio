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

async function selectHero() {
  const frame = await waitFor(() => {
    const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    if (!node.contentWindow) throw new Error('Preview frame not ready');
    return node;
  });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'readable-edit-select', target: heroTarget() },
      source: frame.contentWindow,
    }));
  });
  await waitFor(() => expect(toolbarState.props).not.toBeNull());
}

afterEach(() => {
  cleanup();
  toolbarState.props = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer manual edit undo keyboard shortcut', () => {
  it('undoes and redoes manual edits with Ctrl+Z / Ctrl+Shift+Z while editing', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    act(() => {
      toolbarState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Edited hero' },
        'Content: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('Edited hero');

    // Ctrl+Z on the host undoes the committed manual edit.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(2));
    expect(savedSources[1]).toBe(initialSource);

    // Ctrl+Shift+Z redoes it.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(3));
    expect(savedSources[2]).toContain('Edited hero');
  });

  it('undoes a rich set-inner-html commit with Ctrl+Z', async () => {
    const initialSource = '<!doctype html><html><body><p data-readable-id="hero">Plain copy</p></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = await waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      if (!node.contentWindow) throw new Error('Preview frame not ready');
      return node;
    });

    // Bridge posts readable-edit-html-commit for rich (Ctrl+B) edits.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-html-commit', id: 'hero', html: '<strong>Plain</strong> copy' },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('<strong>Plain</strong> copy');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(2));
    expect(savedSources[1]).toBe(initialSource);
  });

  it('ignores Ctrl+Z that originates from an input field', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    act(() => {
      toolbarState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Edited hero' },
        'Content: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));

    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    // No undo save should have been triggered from inside the input.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(savedSources).toHaveLength(1);
    input.remove();
  });

  it('undoes and redoes a multi-step manual edit stack in order', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    vi.stubGlobal('fetch', historyFetchMock(() => persistedSource, (next) => {
      persistedSource = next;
      savedSources.push(next);
    }));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    for (const value of ['Alpha', 'Bravo', 'Charlie']) {
      const before = savedSources.length;
      act(() => {
        toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value }, 'Content: Hero');
      });
      await waitFor(() => expect(savedSources.length).toBe(before + 1));
    }
    expect(savedSources[0]).toContain('Alpha');
    expect(savedSources[1]).toContain('Bravo');
    expect(savedSources[2]).toContain('Charlie');

    const undo = async (length: number) => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      });
      await waitFor(() => expect(savedSources).toHaveLength(length));
    };
    // Walk the stack back: Charlie -> Bravo -> Alpha -> initial.
    await undo(4);
    expect(savedSources[3]).toContain('Bravo');
    await undo(5);
    expect(savedSources[4]).toContain('Alpha');
    await undo(6);
    expect(savedSources[5]).toBe(initialSource);

    const redo = async (length: number) => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
      });
      await waitFor(() => expect(savedSources).toHaveLength(length));
    };
    // Replay forward: Alpha -> Bravo -> Charlie.
    await redo(7);
    expect(savedSources[6]).toContain('Alpha');
    await redo(8);
    expect(savedSources[7]).toContain('Bravo');
    await redo(9);
    expect(savedSources[8]).toContain('Charlie');
  });

  it('drops undo history when the viewed file/context changes', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    vi.stubGlobal('fetch', historyFetchMock(() => persistedSource, (next) => {
      persistedSource = next;
      savedSources.push(next);
    }));

    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    act(() => {
      toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero');
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));

    // Switching the viewed file resets manual-edit history (the [file.name]
    // effect). The previous file's undo entry must not be replayable.
    rerender(
      <FileViewer projectId="project-1" projectKind="prototype" file={otherPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // No undo save: the stale history was cleared on the context switch.
    expect(savedSources).toHaveLength(1);
  });

  it('undoes and redoes via the bridge-forwarded readable-edit-undo message (Ctrl+Z inside the iframe)', async () => {
    // The bridge (apps/web/src/edit-mode/bridge.ts) posts this message when
    // Ctrl+Z/Ctrl+Y fires inside the srcDoc iframe and no inline edit session
    // is active, because keydown events never bubble out of a cross-document
    // iframe to the host's window-level listener above.
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    vi.stubGlobal('fetch', historyFetchMock(() => persistedSource, (next) => {
      persistedSource = next;
      savedSources.push(next);
    }));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = await waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      if (!node.contentWindow) throw new Error('Preview frame not ready');
      return node;
    });
    const frameWindow = frame.contentWindow;
    await selectHero();

    act(() => {
      toolbarState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Edited hero' },
        'Content: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('Edited hero');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-undo', redo: false },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(2));
    expect(savedSources[1]).toBe(initialSource);
    await waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(node).toBe(frame);
      expect(node.contentWindow).toBe(frameWindow);
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'readable-edit-undo', redo: true },
        source: frameWindow,
      }));
    });
    await waitFor(() => expect(savedSources).toHaveLength(3));
    expect(savedSources[2]).toContain('Edited hero');
  });

  it('ignores Ctrl+Z dispatched from a contentEditable host element', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-readable-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    vi.stubGlobal('fetch', historyFetchMock(() => persistedSource, (next) => {
      persistedSource = next;
      savedSources.push(next);
    }));

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectHero();

    act(() => {
      toolbarState.props?.onApplyPatch({ id: 'hero', kind: 'set-text', value: 'Edited hero' }, 'Content: Hero');
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    act(() => {
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // contentEditable hosts (e.g. the chat composer) keep native typing-undo.
    expect(savedSources).toHaveLength(1);
    editable.remove();
  });
});

function historyFetchMock(getPersisted: () => string, onSave: (next: string) => void) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { content: string };
      onSave(payload.content);
      return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/raw/')) {
      return new Response(getPersisted(), { status: 200 });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
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

function otherPreviewFile(): ProjectFile {
  return {
    name: 'other.html',
    path: 'other.html',
    type: 'file',
    size: 1024,
    mtime: 1710000001,
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1',
      kind: 'html',
      title: 'Other',
      entry: 'other.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function heroTarget(): ManualEditTarget {
  return {
    id: 'hero',
    kind: 'text',
    label: 'Hero',
    tagName: 'h1',
    className: '',
    text: 'Hero',
    rect: { x: 0, y: 0, width: 120, height: 40 },
    fields: { text: 'Hero' },
    attributes: { 'data-readable-id': 'hero' },
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<h1 data-readable-id="hero">Hero</h1>',
  };
}
