// @vitest-environment jsdom

// Row actions must act on the row they were opened from. A menu that opens is
// worth nothing if "delete" deletes the neighbour, so every assertion here
// pins the TARGET, not merely that a menu appeared.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubProjectNode } from '../../src/components/hub/types';

afterEach(() => {
  cleanup();
});

const PROJECTS: HubProjectNode[] = [
  {
    id: 'p1',
    name: '분기 보고서',
    updatedAt: 900,
    sessions: [
      { id: 's1', projectId: 'p1', title: '차트 팔레트 정리', updatedAt: 900, state: 'running' },
      { id: 's2', projectId: 'p1', title: '범례 겹침 수정', updatedAt: 800, state: 'idle' },
    ],
  },
  {
    id: 'p2',
    name: '가격 페이지',
    updatedAt: 100,
    sessions: [{ id: 's3', projectId: 'p2', title: '요금제 비교표', updatedAt: 100, state: 'idle' }],
  },
];

function renderTree(overrides: Partial<Parameters<typeof HubSessionTree>[0]> = {}) {
  const props = {
    projects: PROJECTS,
    currentSessionId: null,
    onOpenSession: vi.fn(),
    onPeekSession: vi.fn(),
    onNewSession: vi.fn(),
    onRenameProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
  render(<HubSessionTree {...props} />);
  return props;
}

describe('HubSessionTree row actions', () => {
  it('exposes rename, new session and delete on a project row and hits that project', () => {
    const props = renderTree();
    fireEvent.click(screen.getByTestId('hub-menu-project-p2'));
    expect(screen.getByTestId('hub-row-menu-rename')).toBeTruthy();
    expect(screen.getByTestId('hub-row-menu-new-session')).toBeTruthy();

    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(props.onDeleteProject).toHaveBeenCalledTimes(1);
    expect(props.onDeleteProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('creates a new session in the project whose menu was opened', () => {
    const props = renderTree();
    fireEvent.click(screen.getByTestId('hub-menu-project-p1'));
    fireEvent.click(screen.getByTestId('hub-row-menu-new-session'));
    expect(props.onNewSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('exposes rename, info and delete on a session row and hits that session', () => {
    const props = renderTree();
    fireEvent.click(screen.getByTestId('hub-menu-session-s2'));
    expect(screen.getByTestId('hub-row-menu-rename')).toBeTruthy();
    expect(screen.getByTestId('hub-row-menu-info')).toBeTruthy();

    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(props.onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    expect(props.onDeleteProject).not.toHaveBeenCalled();
  });

  it('renames the row the menu was opened from, not the focused one', () => {
    const props = renderTree();
    screen.getByTestId('hub-session-s1').focus();
    fireEvent.click(screen.getByTestId('hub-menu-session-s2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-rename'));
    const field = screen.getByTestId('hub-rename-s-s2') as HTMLInputElement;
    expect(field.value).toBe('범례 겹침 수정');
    fireEvent.change(field, { target: { value: '범례 정리' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onRenameSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's2' }),
      '범례 정리',
    );
  });

  it('restores focus to the row when the menu is dismissed with Escape', () => {
    renderTree();
    const row = screen.getByTestId('hub-session-s2');
    fireEvent.click(screen.getByTestId('hub-menu-session-s2'));
    const menu = screen.getByTestId('hub-row-menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('peeks a session from its info button and from Space on the focused row', () => {
    const props = renderTree();
    fireEvent.click(screen.getByTestId('hub-peek-s1'));
    expect(props.onPeekSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));

    const row = screen.getByTestId('hub-session-s3');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(props.onPeekSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's3' }));
    // Peeking must not navigate.
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it('keeps Space toggling a project row, which has nothing to peek', () => {
    const props = renderTree();
    const project = screen.getByTestId('hub-project-p1');
    project.focus();
    fireEvent.keyDown(project, { key: ' ' });
    expect(project.getAttribute('aria-expanded')).toBe('false');
    expect(props.onPeekSession).not.toHaveBeenCalled();
  });

  it('labels the result group and counts what the list is showing', () => {
    renderTree();
    expect(screen.getByTestId('hub-group-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('hub-filter-running'));
    // Filtered views count matching sessions, not projects.
    expect(screen.getByTestId('hub-group-count').textContent).toBe('1');
  });

  it('renders relative last activity on a settled session', () => {
    render(
      <HubSessionTree
        projects={[
          {
            id: 'p9',
            name: 'p9',
            updatedAt: Date.now(),
            sessions: [
              {
                id: 's9',
                projectId: 'p9',
                title: 'done',
                updatedAt: Date.now() - 2 * 60 * 60 * 1000,
                state: 'idle',
              },
            ],
          },
        ]}
        currentSessionId={null}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByTestId('hub-when-s9').textContent).toBe('2h');
  });
});
