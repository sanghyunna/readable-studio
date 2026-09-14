// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESIGN_FILES_TAB,
  FileWorkspace,
  scrollWorkspaceTabsWithWheel,
} from '../../src/components/FileWorkspace';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { projectSplitClassName, projectSplitStyle } from '../../src/components/ProjectView';
import {
  fetchProjectFileText,
  fetchProjectDeployments,
  uploadProjectFiles,
  writeProjectTextFile,
  fetchProjectFolders,
} from '../../src/providers/registry';
import type { ChatMessage, ProjectFile, ProjectFolder } from '../../src/types';
import { stubMissingCanvasContext } from '../helpers/canvas';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectFileText: vi.fn(),
    fetchProjectDeployments: vi.fn().mockResolvedValue([]),
    uploadProjectFiles: vi.fn(),
    writeProjectTextFile: vi.fn(),
    fetchProjectFolders: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../src/components/DesignBrowserPanel', () => ({
  DesignBrowserPanel: ({
    initialIconUrl,
    initialTitle,
    initialUrl,
  }: {
    initialIconUrl?: string;
    initialTitle?: string;
    initialUrl?: string;
  }) => (
    <div
      data-testid="design-browser-panel"
      data-initial-icon-url={initialIconUrl ?? ''}
      data-initial-title={initialTitle ?? ''}
      data-initial-url={initialUrl ?? ''}
    />
  ),
}));

vi.mock('../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-viewer">{terminalId}</div>
  ),
}));

// Records the `folders` prop DesignFilesPanel receives on EVERY render (still
// renders the real component). Lets a test observe the first render after a
// project switch — the pre-paint frame RTL's post-rerender DOM assertion can't
// see — to prove no stale folders ever reach the new panel.
const { designFilesPanelRenders } = vi.hoisted(() => ({
  designFilesPanelRenders: [] as { projectId: string; folderCount: number }[],
}));
vi.mock('../../src/components/DesignFilesPanel', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/DesignFilesPanel')>(
    '../../src/components/DesignFilesPanel',
  );
  const Real = actual.DesignFilesPanel;
  return {
    ...actual,
    DesignFilesPanel: (props: Parameters<typeof Real>[0]) => {
      designFilesPanelRenders.push({
        projectId: props.projectId,
        folderCount: props.folders?.length ?? 0,
      });
      return <Real {...props} />;
    },
  };
});

const mockedFetchProjectFileText = vi.mocked(fetchProjectFileText);
const mockedUploadProjectFiles = vi.mocked(uploadProjectFiles);
const mockedWriteProjectTextFile = vi.mocked(writeProjectTextFile);

// Needed else the ResizeObserver in SketchEditor crashes the test
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

beforeEach(() => {
  mockedFetchProjectFileText.mockResolvedValue('');
  stubMissingCanvasContext();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function baseFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'mock.png',
    path: 'mock.png',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'image',
    mime: 'image/png',
    ...overrides,
  };
}

function workspaceFile(name: string): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1700000000,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: name.endsWith('.html') ? 'text/html' : 'text/plain',
  };
}

async function settleWorkspaceLoads() {
  // Mounting (or switching file tabs) starts folder, source and deployment
  // requests. Await those exact requests in act so their state updates and
  // the resulting HtmlViewer/PreviewDrawOverlay effects commit together.
  await act(async () => {
    await Promise.all([
      ...vi.mocked(fetchProjectFolders).mock.results,
      ...mockedFetchProjectFileText.mock.results,
      ...vi.mocked(fetchProjectDeployments).mock.results,
    ].map((result) => result.value));
  });
}

async function renderWorkspace(element: React.ReactElement) {
  const view = render(element);
  await settleWorkspaceLoads();
  return view;
}

function getTabByName(container: HTMLElement, name: RegExp): HTMLElement {
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  const tab = tabs.find((node) => name.test(node.textContent ?? ''));
  if (!tab) throw new Error(`Could not find tab matching ${name}`);
  return tab;
}

function renderedTabLabels(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent?.trim() ?? '');
}

function createDragDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    getData: vi.fn((type: string) => store.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
  };
}

function dispatchDragEvent(
  target: HTMLElement,
  type: string,
  dataTransfer = createDragDataTransfer(),
  clientX = 0,
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return dataTransfer;
}

function stubTabRect(tab: HTMLElement, left = 0, width = 100) {
  tab.getBoundingClientRect = vi.fn(() => ({
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 20,
    width,
    height: 20,
    toJSON: () => ({}),
  }));
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderDesignFilesPanel(overrides: Partial<React.ComponentProps<typeof DesignFilesPanel>> = {}) {
  const props: React.ComponentProps<typeof DesignFilesPanel> = {
    projectId: 'project-1',
    files: [],
    onRefreshFiles: vi.fn(),
    onOpenFile: vi.fn(),
    onRenameFile: vi.fn(),
    onDeleteFile: vi.fn(),
    onDeleteFiles: vi.fn(),
    onUpload: vi.fn(),
    onUploadFiles: vi.fn(),
    onPaste: vi.fn(),
    onNewSketch: vi.fn(),
    ...overrides,
  };
  return render(<DesignFilesPanel {...props} />);
}

function unreadableDropDataTransfer(fallbackFiles: File[] = []) {
  return {
    files: fallbackFiles,
    items: [
      {
        webkitGetAsEntry: () => ({
          isFile: true,
          isDirectory: false,
          name: 'stale.png',
          file: (_done: (file: File) => void, fail?: (error: DOMException) => void) => {
            fail?.(new DOMException('missing', 'NotFoundError'));
          },
        }),
      },
    ],
  };
}

describe('FileWorkspace upload input', () => {
  it('keeps the Design Files picker aligned with drag-and-drop file support', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="design-files-upload-input"');
    expect(markup).not.toContain('accept=');
  });

  it('hides upload failure details during in-panel preview and restores them after closing preview', async () => {
    mockedUploadProjectFiles.mockRejectedValueOnce(new Error('storage offline'));

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile()]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('design-files-upload-input'), {
      target: { files: [new File(['mock'], 'mock.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'storage offline',
      );
    });

    const row = screen.getByTestId('design-file-row-mock.png');
    const nameButton = row.querySelector<HTMLButtonElement>('.df-row-name-btn');
    if (!nameButton) throw new Error('Could not find file name button');
    fireEvent.click(nameButton);

    expect(screen.getByTestId('design-file-preview')).toBeTruthy();
    expect(screen.queryByTestId('upload-error-banner')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'storage offline',
      );
    });

    fireEvent.click(screen.getByTestId('upload-error-dismiss'));

    expect(screen.queryByTestId('upload-error-banner')).toBeNull();
  });

  it('keeps partial upload failures visible after a successful file opens', async () => {
    mockedUploadProjectFiles.mockResolvedValueOnce({
      uploaded: [
        {
          path: 'uploaded.png',
          name: 'uploaded.png',
          kind: 'image',
          size: 1024,
        },
      ],
      failed: [{ name: 'failed.png', error: 'permission denied' }],
      error: 'permission denied',
    });

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile({ name: 'uploaded.png', path: 'uploaded.png' })]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('design-files-upload-input'), {
      target: {
        files: [
          new File(['uploaded'], 'uploaded.png', { type: 'image/png' }),
          new File(['failed'], 'failed.png', { type: 'image/png' }),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'Uploaded 1 file(s), but 1 failed (permission denied).',
      );
    });
  });

  it('starts Design Files navigation fresh when switching projects', async () => {
    const baseProps: React.ComponentProps<typeof FileWorkspace> = {
      projectId: 'project-a',
      projectKind: 'prototype',
      files: [
        workspaceFile('assets/logo.png'),
        workspaceFile('top.html'),
      ],
      onRefreshFiles: vi.fn(),
      isDeck: false,
      tabsState: { tabs: [], active: null },
      onTabsStateChange: vi.fn(),
    };

    const { container, rerender } = await renderWorkspace(<FileWorkspace {...baseProps} />);

    fireEvent.click(container.querySelector('.df-dir-row .df-row-name-btn')!);
    expect(container.querySelector('.df-breadcrumb-current')?.textContent).toBe('assets');

    rerender(
      <FileWorkspace
        {...baseProps}
        projectId="project-b"
        files={[
          workspaceFile('beta-assets/logo.png'),
          workspaceFile('home.html'),
        ]}
      />,
    );

    expect(container.querySelector('.df-breadcrumb-current')?.textContent).toBe('project');
    expect(screen.getByTestId('design-file-row-home.html')).toBeTruthy();
    await settleWorkspaceLoads();
  });

  it('drops the previous project folders when switching, before the new fetch resolves', async () => {
    const folder = (path: string): ProjectFolder => ({
      name: path.split('/').pop() ?? path,
      path,
      type: 'dir',
      size: 0,
      mtime: 1700000000,
    });
    const mockedFolders = vi.mocked(fetchProjectFolders);
    // project-a has an empty persisted folder; project-b's fetch stays pending.
    // (One-time values take precedence over the factory default `[]`; no reset,
    // so later tests keep that default.)
    mockedFolders.mockResolvedValueOnce([folder('assets')]);
    mockedFolders.mockReturnValueOnce(new Promise<ProjectFolder[]>(() => {}));

    const baseProps: React.ComponentProps<typeof FileWorkspace> = {
      projectId: 'project-a',
      projectKind: 'prototype',
      files: [],
      onRefreshFiles: vi.fn(),
      isDeck: false,
      tabsState: { tabs: [], active: null },
      onTabsStateChange: vi.fn(),
    };
    const { container, rerender } = await renderWorkspace(<FileWorkspace {...baseProps} />);
    // project-a's empty folder shows once its fetch resolves.
    await waitFor(() => {
      expect(
        [...container.querySelectorAll('.df-dir-row .df-row-name')].some(
          (e) => e.textContent === 'assets',
        ),
      ).toBe(true);
    });

    // Switch to project-b; its folder fetch is still pending. The previous
    // project's 'assets' folder must be gone immediately (reset synchronously),
    // not linger and suppress the new project's empty state.
    designFilesPanelRenders.length = 0;
    rerender(<FileWorkspace {...baseProps} projectId="project-b" files={[]} />);
    expect(
      [...container.querySelectorAll('.df-dir-row .df-row-name')].some(
        (e) => e.textContent === 'assets',
      ),
    ).toBe(false);

    // The reset happens during render, not in an effect — so the new panel's
    // FIRST render (and every render thereafter) already sees zero folders.
    // An effect-based reset would let project-b's first render observe the
    // stale 'assets' folder before the effect cleared it; RTL's post-rerender
    // DOM check above can't catch that frame, this can.
    const projectBRenders = designFilesPanelRenders.filter((r) => r.projectId === 'project-b');
    expect(projectBRenders.length).toBeGreaterThan(0);
    expect(projectBRenders.every((r) => r.folderCount === 0)).toBe(true);
  });

  it('clears a prior upload failure after a later successful upload', async () => {
    mockedUploadProjectFiles
      .mockRejectedValueOnce(new Error('storage offline'))
      .mockResolvedValueOnce({
        uploaded: [
          {
            path: 'retry.png',
            name: 'retry.png',
            kind: 'image',
            size: 1024,
          },
        ],
        failed: [],
      });

    const onRefreshFiles = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile({ name: 'retry.png', path: 'retry.png' })]}
        onRefreshFiles={onRefreshFiles}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const input = screen.getByTestId('design-files-upload-input');
    fireEvent.change(input, {
      target: { files: [new File(['failed'], 'failed.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain('storage offline');
    });

    fireEvent.change(input, {
      target: { files: [new File(['retry'], 'retry.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(onRefreshFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('upload-error-banner')).toBeNull());
  });

  it('falls back to the browser file list when a dragged entry cannot be read', async () => {
    const fallbackFile = new File(['mock'], 'fallback.png', { type: 'image/png' });
    const onUploadFiles = vi.fn();
    const { container } = renderDesignFilesPanel({ onUploadFiles });

    fireEvent.drop(container.querySelector('.df-body')!, {
      dataTransfer: unreadableDropDataTransfer([fallbackFile]),
    });

    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledWith([fallbackFile]));
    expect(screen.queryByTestId('upload-error-banner')).toBeNull();
  });

  it('shows a recoverable read error when a dragged entry disappears before import', async () => {
    const onUploadFiles = vi.fn();
    const { container } = renderDesignFilesPanel({ onUploadFiles });

    fireEvent.drop(container.querySelector('.df-body')!, {
      dataTransfer: unreadableDropDataTransfer(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'Could not read one or more dropped files or folders',
      );
    });
    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it('hides the workspace focus control while the chat pane is open', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode={false}
        onFocusModeChange={vi.fn()}
      />,
    );

    // While chat is visible the collapse trigger lives in ChatPane.
    // FileWorkspace only renders an expand control once chat is hidden.
    expect(markup).not.toContain('data-testid="workspace-focus-toggle"');
  });

  it('renders the expand control on the LEFT of the tab bar while focused', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="ws-tabs-shell"');
    expect(markup).toContain('data-testid="workspace-focus-toggle"');
    // The expand control sits before the tabs bar (left side) so its
    // direction matches where the chat pane re-emerges from.
    expect(markup).toMatch(
      /<div class="ws-tabs-shell">\s*<button[^>]*data-testid="workspace-focus-toggle"[\s\S]*?<\/button>\s*<div class="ws-tabs-bar"/,
    );
  });

  it('labels the same workspace control as chat restore while focused', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Show chat');
  });
});

describe('FileWorkspace launcher tab creation', () => {
  it('does not report a Design Files context for an empty project', async () => {
    // A brand-new project has no files, live artifacts, or folders. The
    // composer must not auto-stage a "Design files" chip that points at
    // nothing, so the active workspace context stays null.
    const onActiveContextChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        resolvedDir="/tmp/readable-studio/project-1"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        onActiveContextChange={onActiveContextChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveContextChange).toHaveBeenCalled();
    });
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);
  });

  it('reports the active Design Files tab as workspace context once files exist', async () => {
    const onActiveContextChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        resolvedDir="/tmp/readable-studio/project-1"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        onActiveContextChange={onActiveContextChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveContextChange).toHaveBeenLastCalledWith({
        id: 'workspace:design-files',
        kind: 'design-files',
        label: 'Design Files',
        tabId: '__design_files__',
        absolutePath: '/tmp/readable-studio/project-1',
      });
    });
  });

  it('hides terminal creation while keeping browser creation available', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('workspace-add-tab'));

    expect(screen.queryByRole('button', { name: /New Terminal/i })).toBeNull();
    expect(screen.getByRole('button', { name: /New Browser/i })).toBeTruthy();
    expect(screen.getByText('Create new')).toBeTruthy();
  });

  it('renders terminal and side chat tabs after a Design Files-anchored browser tab', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['terminal:term-1', 'chat:conversation-1'],
          active: 'chat:conversation-1',
          browserTabs: [
            {
              id: '__browser__:1',
              insertAfter: '__design_files__',
              label: 'Browser',
            },
          ],
        }}
        conversations={[
          {
            id: 'conversation-1',
            projectId: 'project-1',
            title: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(renderedTabLabels()).toEqual([
      'Design Files',
      'Browser',
      'New Terminal',
      'Side chat',
    ]);
  });

  it('anchors a new browser after the visible tab tail', async () => {
    const onTabsStateChange = vi.fn();
    const rootBrowserTab = {
      id: '__browser__:1',
      insertAfter: '__design_files__',
      label: 'Browser',
    };

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['terminal:term-1'],
          active: 'terminal:term-1',
          browserTabs: [rootBrowserTab],
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    fireEvent.click(screen.getByTestId('workspace-add-tab'));
    fireEvent.click(await screen.findByRole('button', { name: /New Browser/i }));

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['terminal:term-1'],
        active: '__browser__:2',
        browserTabs: [
          rootBrowserTab,
          {
            id: '__browser__:2',
            insertAfter: 'terminal:term-1',
            label: 'Browser 2',
          },
        ],
      });
    });
  });

  it('reanchors stale browser tabs before appending a file from the launcher', async () => {
    const onTabsStateChange = vi.fn();
    const staleBrowserTab = {
      id: '__browser__:1',
      insertAfter: 'deleted.html',
      label: 'Browser',
    };

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html'), workspaceFile('notes.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['cover.html'],
          active: 'cover.html',
          browserTabs: [staleBrowserTab],
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    fireEvent.click(screen.getByTestId('workspace-add-tab'));
    fireEvent.click(await screen.findByRole('button', { name: /notes\.html/i }));

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html', 'notes.html'],
        active: 'notes.html',
        browserTabs: [
          {
            ...staleBrowserTab,
            insertAfter: 'cover.html',
          },
        ],
      });
    });
  });

  it('opens the Design Files tab launcher with the browser new-tab shortcut', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const allowedDefault = fireEvent.keyDown(window, {
      key: 't',
      metaKey: true,
    });

    expect(allowedDefault).toBe(false);
    expect(screen.getByTestId('workspace-add-tab').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(await screen.findByRole('dialog', { name: /New tab/i })).toBeTruthy();
    expect(screen.getByTestId('tab-launcher-search')).toBe(document.activeElement);
  });

  it('names a file tab by its title without folding in the close control', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('alpha-file.png')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['alpha-file.png'], active: 'alpha-file.png' }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'alpha-file.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close tab' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /alpha-file\.png Close tab/i })).toBeNull();
  });

  it('closes the active Design Files workspace tab with the browser close-tab shortcut', async () => {
    const onTabsStateChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['analysis.html', 'notes.html'], active: 'notes.html' }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const allowedDefault = fireEvent.keyDown(window, {
      key: 'w',
      ctrlKey: true,
    });
    await settleWorkspaceLoads();

    expect(allowedDefault).toBe(false);
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html'],
      active: 'analysis.html',
    });
  });

  it('switches Design Files workspace tabs with browser-style next and previous shortcuts', async () => {
    const onTabsStateChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['analysis.html', 'notes.html'], active: 'analysis.html' }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const nextAllowedDefault = fireEvent.keyDown(window, {
      key: 'Tab',
      ctrlKey: true,
    });
    await settleWorkspaceLoads();

    expect(nextAllowedDefault).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /notes\.html/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html', 'notes.html'],
      active: 'notes.html',
    });

    const previousAllowedDefault = fireEvent.keyDown(window, {
      key: 'Tab',
      ctrlKey: true,
      shiftKey: true,
    });
    await settleWorkspaceLoads();

    expect(previousAllowedDefault).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /analysis\.html/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html', 'notes.html'],
      active: 'analysis.html',
    });
  });

  it('focuses a browser open request without adding it to file tabs', async () => {
    const onTabsStateChange = vi.fn();
    const browserTabs = [
      {
        id: '__browser__:1',
        label: 'Browser 1',
        title: 'Dribbble',
        url: 'https://dribbble.com/',
      },
    ];

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['cover.html'], active: 'cover.html', browserTabs }}
        openRequest={{ name: '__browser__:1', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html'],
        active: '__browser__:1',
        browserTabs,
      });
    });
  });

  it('opens a share request without dropping existing browser tabs', async () => {
    const onTabsStateChange = vi.fn();
    const browserTabs = [
      {
        id: '__browser__:1',
        label: 'Browser 1',
        title: 'Dribbble',
        url: 'https://dribbble.com/',
      },
    ];

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html'), workspaceFile('landing.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['cover.html'], active: '__browser__:1', browserTabs }}
        shareRequest={{ name: 'landing.html', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html', 'landing.html'],
        active: 'landing.html',
        browserTabs,
      });
    });
  });

  it('opens and activates the target file for a download request', async () => {
    const onTabsStateChange = vi.fn();
    const browserTabs = [
      { id: '__browser__:1', label: 'Browser 1', title: 'Dribbble', url: 'https://dribbble.com/' },
    ];

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html'), workspaceFile('landing.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['cover.html'], active: '__browser__:1', browserTabs }}
        downloadRequest={{ name: 'landing.html', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html', 'landing.html'],
        active: 'landing.html',
        browserTabs,
      });
    });
  });

  it('focuses the design-system workspace tab without adding it to file tabs', async () => {
    const onTabsStateChange = vi.fn();

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['cover.html'], active: 'cover.html' }}
        openRequest={{ name: '__design_system__', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
        designSystemProject={{
          id: 'neutral-modern',
          title: 'Neutral Modern',
          category: 'Starter',
          source: 'bundled',
          updatedAt: 1,
        } as never}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html'],
        active: '__design_system__',
      });
    });
  });

  it('focuses an already-open file tab without adding a duplicate tab', async () => {
    const onTabsStateChange = vi.fn();

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('Web Prototype mutuals-v2.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['Web Prototype mutuals-v2.html'],
          active: 'notes.html',
        }}
        openRequest={{ name: 'Web Prototype mutuals-v2.html', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['Web Prototype mutuals-v2.html'],
        active: 'Web Prototype mutuals-v2.html',
      });
    });
  });
});

describe('DesignFilesPanel plugin folders', () => {
  it('surfaces generated plugin folders with agent-routed CLI actions', async () => {
    const onPluginFolderAgentAction = vi.fn();
    const { container } = await renderWorkspace(
      <DesignFilesPanel
        projectId="project-1"
        files={[
          workspaceFile('generated-plugin/readable-studio.json'),
          workspaceFile('generated-plugin/SKILL.md'),
          workspaceFile('generated-plugin/examples/demo.md'),
        ]}
        onRefreshFiles={vi.fn()}
        onOpenFile={vi.fn()}
        onDeleteFile={vi.fn()}
        onDeleteFiles={vi.fn()}
        onRenameFile={vi.fn()}
        onUpload={vi.fn()}
        onUploadFiles={vi.fn()}
        onPaste={vi.fn()}
        onNewSketch={vi.fn()}
        onPluginFolderAgentAction={onPluginFolderAgentAction}
      />,
    );

    expect(container.querySelector('[data-testid="design-plugin-folder-generated-plugin"]')).toBeTruthy();
    const install = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-install-generated-plugin"]',
    );
    expect(install).toBeTruthy();
    await act(async () => {
      install?.click();
    });
    expect(onPluginFolderAgentAction).toHaveBeenCalledWith('generated-plugin', 'install');

    const publish = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-publish-generated-plugin"]',
    );
    const contribute = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-contribute-generated-plugin"]',
    );
    expect(publish).toBeTruthy();
    expect(contribute).toBeTruthy();
    await act(async () => {
      publish?.click();
    });
    expect(onPluginFolderAgentAction).toHaveBeenCalledWith('generated-plugin', 'publish');
    await act(async () => {
      contribute?.click();
    });
    expect(onPluginFolderAgentAction).toHaveBeenCalledWith('generated-plugin', 'contribute');
    expect(container.textContent).not.toContain(
      'Sent to the agent. The CLI run will continue in chat.',
    );
  });
});

describe('FileWorkspace tab reordering', () => {
  it('persists a dragged file tab before the tab it is dropped on', async () => {
    const onTabsStateChange = vi.fn();

    const { container } = await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[
          workspaceFile('analysis.html'),
          workspaceFile('notes.md'),
          workspaceFile('summary.html'),
        ]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md', 'summary.html'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const source = getTabByName(container, /summary\.html/i);
    const target = getTabByName(container, /analysis\.html/i);
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'dragover', dataTransfer));
    act(() => dispatchDragEvent(target, 'drop', dataTransfer));

    expect(onTabsStateChange).toHaveBeenCalledWith({
      tabs: ['summary.html', 'analysis.html', 'notes.md'],
      active: null,
    });
  });

  it('persists a dragged file tab after the tab when dropped on its right side', async () => {
    const onTabsStateChange = vi.fn();

    const { container } = await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[
          workspaceFile('analysis.html'),
          workspaceFile('notes.md'),
          workspaceFile('summary.html'),
        ]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md', 'summary.html'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const source = getTabByName(container, /analysis\.html/i);
    const target = getTabByName(container, /summary\.html/i);
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'drop', dataTransfer, 75));

    expect(onTabsStateChange).toHaveBeenCalledWith({
      tabs: ['notes.md', 'summary.html', 'analysis.html'],
      active: null,
    });
  });

  it('does not persist when a tab is dropped on itself', async () => {
    const onTabsStateChange = vi.fn();

    const { container } = await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.md')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const tab = getTabByName(container, /analysis\.html/i);
    stubTabRect(tab);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(tab, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(tab, 'drop', dataTransfer));

    expect(onTabsStateChange).not.toHaveBeenCalled();
  });

  it('clears the drop indicator when the drag leaves the tab bar', async () => {
    const { container } = await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.md')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md'],
          active: null,
        }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const source = getTabByName(container, /analysis\.html/i);
    const target = getTabByName(container, /notes\.md/i);
    const tabBar = container.querySelector<HTMLElement>('.ws-tabs-bar');
    if (!tabBar) throw new Error('Could not find tabs bar');
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'dragover', dataTransfer));

    expect(target.className).toContain('drag-over-before');

    act(() => dispatchDragEvent(tabBar, 'dragleave', dataTransfer, 0, document.body));

    expect(target.className).not.toContain('drag-over-before');
    expect(target.className).not.toContain('drag-over-after');
  });
});

describe('projectSplitClassName', () => {
  it('marks the project split as focused so the chat pane can collapse globally', () => {
    expect(projectSplitClassName(false)).toBe('split');
    expect(projectSplitClassName(true)).toBe('split split-focus');
  });

  it('uses CSS variables for split widths so pointer resize can update layout without rerendering workspace content', () => {
    expect(projectSplitStyle(false, 512, 'minmax(420px, 1fr)')).toEqual({
      '--project-chat-panel-width': '512px',
      '--project-workspace-panel-track': 'minmax(420px, 1fr)',
      gridTemplateColumns: '512px 8px minmax(420px, 1fr)',
    });
    expect(projectSplitStyle(true, 512, 'minmax(420px, 1fr)')).toBeUndefined();
  });
});

describe('scrollWorkspaceTabsWithWheel', () => {
  function makeTabBar(scrollLeft: number, scrollWidth = 400, clientWidth = 200) {
    return { scrollLeft, scrollWidth, clientWidth } as HTMLDivElement;
  }

  function makeClampedTabBar(scrollLeft: number, scrollWidth = 400, clientWidth = 200) {
    let value = scrollLeft;
    return {
      scrollWidth,
      clientWidth,
      get scrollLeft() {
        return value;
      },
      set scrollLeft(next: number) {
        value = Math.min(Math.max(next, 0), scrollWidth - clientWidth);
      },
    } as HTMLDivElement;
  }

  it('maps vertical mouse wheel movement to horizontal tab scrolling', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(52);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('supports reverse vertical wheel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(52);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('normalizes line-based wheel deltas to useful pixel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 1,
      deltaX: 0,
      deltaY: 3,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(60);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('normalizes page-based wheel deltas to useful pixel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12, 600, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 2,
      deltaX: 0,
      deltaY: 1,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(172);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves native horizontal wheel gestures alone', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 50,
      deltaY: 10,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('leaves ctrl-wheel zoom gestures alone', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not intercept vertical wheel movement when tabs do not overflow', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12, 200, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('lets page scrolling continue when the tab bar is already at the wheel boundary', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeClampedTabBar(200, 400, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(200);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('FileWorkspace sketch save', () => {
  it('keeps saving state visible for at least 500ms', async () => {
    // Simulate user doing some edits in the workspace
    const file: ProjectFile = {
      name: 'test.sketch.json',
      path: 'test.sketch.json',
      type: 'file',
      size: 100,
      mtime: 1700000000,
      kind: 'sketch',
      mime: 'application/json',
    };

    mockedFetchProjectFileText.mockResolvedValue(
      JSON.stringify({
        version: 1,
        items: [
          { kind: 'pen', points: [{ x: 10, y: 20 }], color: '#000', size: 2 },
        ],
      }),
    );
    mockedWriteProjectTextFile.mockResolvedValue(file);

    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[file]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['test.sketch.json'], active: 'test.sketch.json' }}
        onTabsStateChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('canvas')).not.toBeNull();
    });

    vi.useFakeTimers();

    const btn = screen.getByText('Save') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(btn.textContent).toBe('Saving…');
    expect(btn.disabled).toBe(true);

    // Before the 500ms floor is reached, still saving
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(btn.textContent).toBe('Saving…');
    expect(btn.disabled).toBe(true);

    // After 500ms total, saving should end and the checkmark should appear
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(btn.textContent).not.toBe('Saving…');
    expect(btn.querySelector('svg')).not.toBeNull();
  });
});

describe('FileWorkspace add-module menu', () => {
  it('opens the add-module menu with Browser available and Terminal hidden', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const addButton = screen.getByTestId('workspace-add-tab');
    expect(addButton.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      fireEvent.click(addButton);
    });

    expect(addButton.getAttribute('aria-expanded')).toBe('true');
    const browserItem = screen.getByRole('button', { name: /New Browser/ });
    const menu = browserItem.closest('[data-testid="tab-launcher-menu"]');
    expect(menu).not.toBeNull();
    expect(screen.queryByRole('button', { name: /New Terminal/ })).toBeNull();

    // The tab strip is a horizontal scroll container that also clips
    // vertically, so the "+" button lives outside it in `.ws-add-tab`
    // and the launcher menu is portaled to <body> -- neither can be clipped
    // by the scrolling bar.
    const tabsBar = document.querySelector('.ws-tabs-bar');
    expect(tabsBar).not.toBeNull();
    expect(tabsBar!.contains(addButton)).toBe(false);
    expect(tabsBar!.contains(menu)).toBe(false);
    expect(addButton.closest('.ws-add-tab')).not.toBeNull();
  });

  it('orders launcher sections as create new, files, then tabs in one scroll body', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['cover.html'],
          active: 'cover.html',
          browserTabs: [
            {
              id: '__browser__:1',
              label: 'Reference Browser',
              title: 'Behance',
              url: 'https://www.behance.net/',
            },
          ],
        }}
        onTabsStateChange={vi.fn()}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByTestId('workspace-add-tab'));
    });

    const scrollBody = screen.getByTestId('tab-launcher-scroll-body');
    const createHeader = screen.getByText('Create new');
    const fileHeader = screen.getByText('Open a file');
    const tabsHeader = screen.getByText('Open tabs');

    expect(scrollBody.contains(createHeader)).toBe(true);
    expect(scrollBody.contains(fileHeader)).toBe(true);
    expect(scrollBody.contains(tabsHeader)).toBe(true);
    expect(createHeader.compareDocumentPosition(fileHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fileHeader.compareDocumentPosition(tabsHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('adds a new browser tab every time the Browser module is selected', async () => {
    const onTabsStateChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const addButton = screen.getByTestId('workspace-add-tab');
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        fireEvent.click(addButton);
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: /New Browser/ }));
      });
    }

    const browserTabs = screen
      .getAllByRole('tab')
      .filter((tab) => /Browser(?: \d+)?/.test(tab.textContent ?? ''));
    expect(browserTabs).toHaveLength(3);
    expect(browserTabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Browser',
      'Browser 2',
      'Browser 3',
    ]);
    expect(browserTabs[2]!.getAttribute('aria-selected')).toBe('true');

    const browserPanels = screen
      .getAllByTestId('design-browser-panel')
      .map((panel) => panel.closest('.ws-browser-panel'));
    expect(browserPanels).toHaveLength(3);
    expect(browserPanels[0]!.className).not.toContain('active');
    expect(browserPanels[1]!.className).not.toContain('active');
    expect(browserPanels[2]!.className).toContain('active');
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: [],
      active: '__browser__:3',
      browserTabs: [
        { id: '__browser__:1', insertAfter: '__design_files__', label: 'Browser' },
        { id: '__browser__:2', insertAfter: '__browser__:1', label: 'Browser 2' },
        { id: '__browser__:3', insertAfter: '__browser__:2', label: 'Browser 3' },
      ],
    });
  });

  it('restores persisted browser tabs with their active URL state', async () => {
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: [],
          active: '__browser__:2',
          browserTabs: [
            {
              id: '__browser__:2',
              insertAfter: '__design_files__',
              label: 'Browser 2',
              title: 'SVG Repo',
              url: 'https://www.svgrepo.com/',
              iconUrl: 'https://www.svgrepo.com/favicon.ico',
            },
          ],
        }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const restoredTab = screen.getByRole('tab', { name: /SVG Repo/ });
    expect(restoredTab.getAttribute('aria-selected')).toBe('true');
    const browserPanel = screen.getByTestId('design-browser-panel');
    expect(browserPanel.dataset.initialUrl).toBe('https://www.svgrepo.com/');
    expect(browserPanel.dataset.initialTitle).toBe('SVG Repo');
    expect(browserPanel.dataset.initialIconUrl).toBe('https://www.svgrepo.com/favicon.ico');
  });

  it('persists browser-tab removal when a browser tab is closed', async () => {
    const onTabsStateChange = vi.fn();
    await renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: [],
          active: '__browser__:1',
          browserTabs: [
            { id: '__browser__:1', insertAfter: '__design_files__', label: 'Browser' },
          ],
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const restoredTab = screen.getByRole('tab', { name: /Browser/ });
    const closeButton = restoredTab.querySelector<HTMLButtonElement>('.ws-tab-close');
    expect(closeButton).not.toBeNull();
    act(() => {
      fireEvent.click(closeButton!);
    });

    expect(screen.queryByRole('tab', { name: /Browser/ })).toBeNull();
    expect(screen.queryByTestId('design-browser-panel')).toBeNull();
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: [],
      active: '__design_files__',
    });
  });

});

describe('FileWorkspace empty-project generation contract', () => {
  function assistantMessage(runStatus: 'running' | 'failed'): ChatMessage {
    return {
      id: `msg-${runStatus}`,
      role: 'assistant',
      content: '',
      createdAt: 1700000000,
      startedAt: 1700000000,
      runId: `run-${runStatus}`,
      runStatus,
      agentId: 'claude',
      preTurnFileNames: [],
      events: [{ kind: 'status', label: runStatus === 'failed' ? 'error' : 'thinking' }],
    };
  }

  // The generation-preview card / transient `generating-tab` were removed: an
  // empty project keeps the plain `design-files-empty` placeholder for running
  // AND failed turns, with no card hijacking the surface.
  it.each(['running', 'failed'] as const)(
    'keeps the design-files empty placeholder and shows no generation card for a %s turn',
    async (runStatus) => {
      await renderWorkspace(
        <FileWorkspace
          projectId="project-1"
          projectKind="prototype"
          files={[]}
          onRefreshFiles={vi.fn()}
          isDeck={false}
          streaming={runStatus === 'running'}
          tabsState={{ tabs: [], active: DESIGN_FILES_TAB }}
          onTabsStateChange={vi.fn()}
          messages={[assistantMessage(runStatus)]}
        />,
      );

      expect(screen.queryByTestId('generating-tab')).toBeNull();
      expect(screen.queryByTestId('generation-preview-stage')).toBeNull();
      expect(screen.getByTestId('design-files-empty')).toBeTruthy();
    },
  );
});
