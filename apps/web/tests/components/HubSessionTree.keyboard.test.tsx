// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubFolderNode } from '../../src/components/hub/types';

afterEach(() => {
  cleanup();
});

const PROJECTS: HubFolderNode[] = [
  {
    id: 'p1',
    name: '분기 보고서',
    updatedAt: 900,
    sessions: [
      { id: 's1', workspaceId: 'p1', folderId: 'p1', workspaceSessionCount: 1, title: '차트 팔레트 정리', updatedAt: 900, state: 'running' },
      { id: 's2', workspaceId: 'p1', folderId: 'p1', workspaceSessionCount: 1, title: '범례 겹침 수정', updatedAt: 800, state: 'awaiting' },
    ],
  },
  {
    id: 'p2',
    name: '가격 페이지',
    updatedAt: 100,
    sessions: [
      { id: 's3', workspaceId: 'p2', folderId: 'p2', workspaceSessionCount: 1, title: '요금제 비교표', updatedAt: 100, state: 'idle' },
    ],
  },
];

describe('HubSessionTree keyboard and semantics', () => {
  it('exposes the ARIA tree pattern', () => {
    render(<HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId={null} onOpenSession={vi.fn()} />);
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(2);
    const project = screen.getByTestId('hub-project-p1');
    expect(project.getAttribute('aria-expanded')).toBe('true');
    expect(project.getAttribute('aria-level')).toBe('1');
    expect(screen.getByTestId('hub-session-s1').getAttribute('aria-level')).toBe('2');
    expect(within(screen.getByRole('tree')).getAllByRole('group')).toHaveLength(2);
  });

  it('keeps exactly one tab stop (roving tabindex)', () => {
    render(<HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId={null} onOpenSession={vi.fn()} />);
    const stops = screen
      .getAllByRole('treeitem')
      .filter((el) => el.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
  });

  it('moves focus with ArrowDown and collapses with ArrowLeft', () => {
    render(<HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId={null} onOpenSession={vi.fn()} />);
    const project = screen.getByTestId('hub-project-p1');
    project.focus();
    fireEvent.keyDown(project, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('hub-session-s1'));

    fireEvent.keyDown(screen.getByTestId('hub-session-s1'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('hub-project-p1'));

    fireEvent.keyDown(screen.getByTestId('hub-project-p1'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('hub-project-p1').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the focused session with Enter', () => {
    const onOpenSession = vi.fn();
    render(
      <HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId={null} onOpenSession={onOpenSession} />,
    );
    const row = screen.getByTestId('hub-session-s2');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
  });

  it.each(['Enter', ' '])('leaves %s on row action buttons to native activation', (key) => {
    const onOpenSession = vi.fn();
    const onPeekSession = vi.fn();
    const onNewSession = vi.fn();
    const onSelectFolder = vi.fn();
    render(
      <HubSessionTree
        tree={{ folders: PROJECTS, recents: [] }}
        currentSessionId={null}
        onOpenSession={onOpenSession}
        onPeekSession={onPeekSession}
        onNewSession={onNewSession}
        onSelectFolder={onSelectFolder}
        onRenameSession={vi.fn()}
        onRenameFolder={vi.fn()}
      />,
    );
    for (const id of ['hub-peek-s1', 'hub-menu-session-s1', 'hub-new-session-p1', 'hub-menu-folder-p1']) {
      const button = screen.getByTestId(id);
      button.focus();
      expect(fireEvent.keyDown(button, { key })).toBe(true);
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(onPeekSession).not.toHaveBeenCalled();
      expect(onSelectFolder).not.toHaveBeenCalled();
      expect(screen.getByTestId('hub-project-p1').getAttribute('aria-expanded')).toBe('true');
      // jsdom does not synthesize native keyboard clicks; exercise that click
      // separately after proving the key's default action was not cancelled.
      fireEvent.click(button);
      if (id === 'hub-peek-s1') expect(onPeekSession).toHaveBeenCalledTimes(1);
      if (id === 'hub-new-session-p1') expect(onNewSession).toHaveBeenCalledWith(PROJECTS[0]);
      if (id.includes('menu')) {
        expect(screen.getByRole('menu')).toBeTruthy();
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      }
      onPeekSession.mockClear();
    }
    expect(screen.getAllByRole('treeitem').filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('renames and deletes the focused row without changing the existing activation model', () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <HubSessionTree
        tree={{ folders: PROJECTS, recents: [] }}
        currentSessionId={null}
        onOpenSession={vi.fn()}
        onRenameSession={onRename}
        onDeleteSession={onDelete}
      />,
    );
    const row = screen.getByTestId('hub-session-s1');
    row.focus();
    fireEvent.keyDown(row, { key: 'F2' });
    const input = screen.getByTestId('hub-rename-s-s1');
    fireEvent.change(input, { target: { value: '새 세션 이름' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), '새 세션 이름');

    const deleteRow = screen.getByTestId('hub-session-s2');
    fireEvent.keyDown(deleteRow, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
  });

  it('uses printable-key type-ahead to focus a matching visible row', () => {
    render(<HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId={null} onOpenSession={vi.fn()} />);
    const first = screen.getByTestId('hub-project-p1');
    first.focus();
    fireEvent.keyDown(first, { key: '가' });
    expect(document.activeElement).toBe(screen.getByTestId('hub-project-p2'));
  });

  it('marks the current session for assistive tech', () => {
    render(<HubSessionTree tree={{ folders: PROJECTS, recents: [] }} currentSessionId="s2" onOpenSession={vi.fn()} />);
    expect(screen.getByTestId('hub-session-s2').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('hub-session-s1').getAttribute('aria-current')).toBeNull();
  });
});
