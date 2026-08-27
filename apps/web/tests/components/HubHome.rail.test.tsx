// @vitest-environment jsdom

// The rail's stateful half: open work, the inspector, and the daemon-backed
// row mutations. A delete that leaves a ghost row or a stale count is the
// failure this file exists to catch.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listConversations = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());
const deleteConversation = vi.hoisted(() => vi.fn());
const patchConversation = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  createConversation,
  deleteConversation,
  patchConversation,
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem('readable-studio:hub-open-work');
  listConversations.mockReset();
  createConversation.mockReset();
  deleteConversation.mockReset();
  patchConversation.mockReset();
});

function project(id: string, name: string, updatedAt: number): Project {
  return { id, name, skillId: null, designSystemId: null, createdAt: 1, updatedAt };
}

const PROJECTS = [project('p1', '분기 보고서', 900), project('p2', '가격 페이지', 100)];

function conversation(id: string, projectId: string, title: string, extra: object = {}) {
  return { id, projectId, title, createdAt: 1, updatedAt: 10, ...extra };
}

function renderHub(overrides: Partial<Parameters<typeof HubHome>[0]> = {}) {
  return render(
    <HubHome
      projects={PROJECTS}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
      onImportFolder={vi.fn()}
      {...overrides}
    />,
  );
}

function seedTwoSessions() {
  listConversations.mockImplementation(async (projectId: string) =>
    projectId === 'p1'
      ? [
          conversation('c1', 'p1', '차트 팔레트 정리', {
            latestRun: { status: 'running' },
            messageCount: 38,
            sessionMode: 'design',
          }),
          conversation('c2', 'p1', '경영 요약 초안', { messageCount: 4 }),
        ]
      : [conversation('c3', 'p2', '요금제 비교표', { messageCount: 2 })],
  );
}

describe('HubHome rail', () => {
  it('has no open-work section until a session is opened, then lists it', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-session-c1');
    expect(screen.queryByTestId('hub-open-work')).toBeNull();

    fireEvent.click(screen.getByTestId('hub-session-c1'));
    expect(screen.getByTestId('hub-open-work')).toBeTruthy();
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
  });

  it('restores open work after the hub unmounts for workspace navigation', async () => {
    seedTwoSessions();
    const first = renderHub();
    await screen.findByTestId('hub-session-c1');
    fireEvent.click(screen.getByTestId('hub-session-c1'));
    first.unmount();

    renderHub();
    await screen.findByTestId('hub-session-c1');
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
  });

  it('removes the row the close action names and leaves the others alone', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-session-c1');
    fireEvent.click(screen.getByTestId('hub-session-c1'));
    fireEvent.click(screen.getByTestId('hub-session-c2'));
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
    expect(screen.getByTestId('hub-open-work-c2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('hub-close-open-c1'));
    expect(screen.queryByTestId('hub-open-work-c1')).toBeNull();
    expect(screen.getByTestId('hub-open-work-c2')).toBeTruthy();
    // Closing open work is not deleting: the session stays in the tree.
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('peeks a session into the inspector without navigating', async () => {
    seedTwoSessions();
    const onOpenSession = vi.fn();
    renderHub({ onOpenSession });
    await screen.findByTestId('hub-session-c1');

    fireEvent.click(screen.getByTestId('hub-peek-c1'));
    expect(screen.getByTestId('hub-inspector-name').textContent).toBe('차트 팔레트 정리');
    expect(screen.getByTestId('hub-inspector-project').textContent).toBe('분기 보고서');
    expect(screen.getByTestId('hub-inspector-state').textContent).toBe('Running');
    expect(onOpenSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('hub-inspector-open'));
    expect(onOpenSession).toHaveBeenCalledWith('p1', 'c1');
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
  });

  it('closes the inspector on Escape and returns focus to the peeked row', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-session-c2');
    const row = screen.getByTestId('hub-session-c2');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.getByTestId('hub-inspector')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('lets an open row menu claim Escape before the inspector does', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-session-c2');
    const row = screen.getByTestId('hub-session-c2');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.getByTestId('hub-inspector')).toBeTruthy();

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.keyDown(screen.getByTestId('hub-row-menu'), { key: 'Escape' });
    // The menu closed; the inspector underneath it survived that Escape.
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
    expect(screen.getByTestId('hub-inspector')).toBeTruthy();
    expect(document.activeElement).toBe(row);
  });

  it('deletes the session the menu targeted, leaving no ghost row or stale count', async () => {
    seedTwoSessions();
    deleteConversation.mockResolvedValue(true);
    renderHub();
    await screen.findByTestId('hub-session-c2');
    expect(screen.getByTestId('hub-group-count').textContent).toBe('2');

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));

    expect(deleteConversation).toHaveBeenCalledWith('p1', 'c2');
    expect(screen.queryByTestId('hub-session-c2')).toBeNull();
    // The sibling survives and the tree is not rebuilt from a stale cache.
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hub-filter-running'));
    expect(screen.getByTestId('hub-group-count').textContent).toBe('1');
  });

  it('restores a session the daemon refused to delete', async () => {
    seedTwoSessions();
    deleteConversation.mockResolvedValue(false);
    renderHub();
    await screen.findByTestId('hub-session-c2');

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    await waitFor(() => expect(screen.getByTestId('hub-session-c2')).toBeTruthy());
  });

  it('renames the targeted session through the daemon', async () => {
    seedTwoSessions();
    patchConversation.mockResolvedValue(null);
    renderHub();
    await screen.findByTestId('hub-session-c2');

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-rename'));
    const field = screen.getByTestId('hub-rename-s-c2') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '요약 정리' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(patchConversation).toHaveBeenCalledWith('p1', 'c2', { title: '요약 정리' });
    expect(screen.getByTestId('hub-session-c2').textContent).toContain('요약 정리');
  });

  it('creates a session in the targeted project and reuses an untouched one', async () => {
    seedTwoSessions();
    createConversation.mockResolvedValue(
      conversation('c9', 'p2', '새 세션', { messageCount: 0 }),
    );
    const onOpenSession = vi.fn();
    renderHub({ onOpenSession });
    await screen.findByTestId('hub-session-c3');

    fireEvent.click(screen.getByTestId('hub-new-session-p2'));
    await waitFor(() => expect(createConversation).toHaveBeenCalledWith('p2'));
    await screen.findByTestId('hub-session-c9');

    // The freshly created session has no messages, so a second click reopens it
    // rather than stacking another empty session.
    fireEvent.click(screen.getByTestId('hub-new-session-p2'));
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('p2', 'c9');
  });

  it('renames and deletes a project through the callbacks the entry shell owns', async () => {
    seedTwoSessions();
    const onRenameProject = vi.fn();
    const onDeleteProject = vi.fn();
    renderHub({ onRenameProject, onDeleteProject });
    await screen.findByTestId('hub-session-c3');

    fireEvent.click(screen.getByTestId('hub-menu-project-p2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(onDeleteProject).toHaveBeenCalledWith('p2');

    fireEvent.click(screen.getByTestId('hub-menu-project-p1'));
    fireEvent.click(screen.getByTestId('hub-row-menu-rename'));
    const field = screen.getByTestId('hub-rename-p-p1') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '연간 보고서' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRenameProject).toHaveBeenCalledWith('p1', '연간 보고서');
  });

  it('carries elapsed time and a trailing arrow on the running strip', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-live-strip');
    expect(screen.getByTestId('hub-live-time').textContent).toBeTruthy();
    expect(screen.getByTestId('hub-live-strip').querySelector('.hub__live-arrow')).not.toBeNull();
  });
});
