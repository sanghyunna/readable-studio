// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeHubSessionSurface,
  HubSessionTree,
  queueHubSessionSurface,
} from '../../src/components/hub/HubSessionTree';
import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { HubProjectNode } from '../../src/components/hub/types';
import { createTerminal } from '../../src/state/projects';

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createTerminal: vi.fn(),
    killTerminal: vi.fn(),
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return { ...actual, fetchProjectFolders: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-viewer">{terminalId}</div>
  ),
}));

const PROJECT: HubProjectNode = {
  id: 'p1',
  name: 'Quarterly report',
  updatedAt: 10,
  sessions: [
    { id: 'c1', projectId: 'p1', title: 'Chart cleanup', updatedAt: 9, state: 'idle' },
    { id: 'c2', projectId: 'p1', title: 'Copy review', updatedAt: 8, state: 'idle' },
  ],
};

const workspaceProps = {
  projectId: 'p1',
  projectKind: 'prototype' as const,
  files: [],
  onRefreshFiles: vi.fn(),
  isDeck: false,
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('Hub session surface handoff', () => {
  it('exposes project-scoped terminal and side-chat entries in the session tree', () => {
    const onOpenProject = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <HubSessionTree
        projects={[PROJECT]}
        currentSessionId={null}
        onOpenProject={onOpenProject}
        onOpenSession={onOpenSession}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.getByTestId('hub-new-session-p1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hub-new-terminal-p1'));
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT);
    expect(consumeHubSessionSurface('p1')).toEqual({ projectId: 'p1', kind: 'terminal' });

    fireEvent.click(screen.getByTestId('hub-open-side-chat-c1'));
    expect(onOpenSession).toHaveBeenCalledWith(PROJECT.sessions[0]);
    expect(consumeHubSessionSurface('p1')).toEqual({
      projectId: 'p1',
      kind: 'side-chat',
      conversationId: 'c1',
    });
  });

  it('opens tree handoffs in the established workspace hosts', async () => {
    vi.mocked(createTerminal).mockResolvedValue({
      id: 'term-tree',
      projectId: 'p1',
      cwd: 'D:/project',
      shell: 'powershell.exe',
      cols: 80,
      rows: 24,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      exitCode: null,
      signal: null,
    });
    const terminalState = vi.fn();
    queueHubSessionSurface({ projectId: 'p1', kind: 'terminal' });
    const terminalView = render(
      <FileWorkspace
        {...workspaceProps}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={terminalState}
      />,
    );
    terminalView.rerender(
      <FileWorkspace
        {...workspaceProps}
        tabsState={{ tabs: [], active: null, hasSavedState: true }}
        onTabsStateChange={terminalState}
      />,
    );
    await waitFor(() => {
      expect(terminalState).toHaveBeenCalledWith({
        tabs: ['terminal:term-tree'],
        active: 'terminal:term-tree',
      });
    });
    terminalView.unmount();

    const sideChatState = vi.fn();
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c2' });
    const sideChatView = render(
      <FileWorkspace
        {...workspaceProps}
        tabsState={{ tabs: ['terminal:term-tree'], active: 'terminal:term-tree' }}
        onTabsStateChange={sideChatState}
      />,
    );
    sideChatView.rerender(
      <FileWorkspace
        {...workspaceProps}
        tabsState={{ tabs: ['terminal:term-tree'], active: 'terminal:term-tree', hasSavedState: true }}
        onTabsStateChange={sideChatState}
      />,
    );
    await waitFor(() => {
      expect(sideChatState).toHaveBeenCalledWith({
        tabs: ['terminal:term-tree', 'chat:c2'],
        active: 'chat:c2',
      });
    });
  });

  it('keeps multiple concurrent terminal and side-chat sessions switchable and closable', () => {
    render(
      <FileWorkspace
        {...workspaceProps}
        tabsState={{
          tabs: ['terminal:t1', 'terminal:t2', 'chat:c1', 'chat:c2'],
          active: 'terminal:t2',
        }}
        conversations={PROJECT.sessions.map((session) => ({
          id: session.id,
          projectId: 'p1',
          title: session.title,
          createdAt: 1,
          updatedAt: session.updatedAt,
        }))}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'New Terminal' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'New Terminal 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Chart cleanup' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Copy review' })).toBeTruthy();
    expect(screen.getAllByLabelText('Close tab')).toHaveLength(4);
  });
});
