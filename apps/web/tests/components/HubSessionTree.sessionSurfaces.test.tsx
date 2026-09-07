// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { HubProjectNode } from '../../src/components/hub/types';

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
  it('omits terminal and side-chat launchers while retaining ordinary sessions', () => {
    render(
      <HubSessionTree
        projects={[PROJECT]}
        currentSessionId={null}
        onOpenProject={vi.fn()}
        onOpenSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.getByTestId('hub-new-session-p1')).toBeTruthy();
    expect(screen.queryByTestId('hub-new-terminal-p1')).toBeNull();
    expect(screen.queryByTestId('hub-open-side-chat-c1')).toBeNull();
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.getByTestId('hub-session-c2')).toBeTruthy();
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
