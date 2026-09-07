// @vitest-environment jsdom

// The rail's stateful half: open work, the inspector, and the daemon-backed
// row mutations. A delete that leaves a ghost row or a stale count is the
// failure this file exists to catch.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());
const deleteConversation = vi.hoisted(() => vi.fn());
const patchConversation = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
  createConversation,
  deleteConversation,
  patchConversation,
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem('readable-studio:hub-open-work');
  window.localStorage.removeItem('readable-studio:hub-rail-collapsed');
  window.localStorage.removeItem('readable-studio:hub-rail-width');
  listConversations.mockReset();
  createConversation.mockReset();
  deleteConversation.mockReset();
  patchConversation.mockReset();
  vi.useRealTimers();
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
  // The collapse toggle was deliberately relocated into the 36px window-chrome
  // row, which is rendered ABOVE the shell body in App.tsx. ProjectRail portals
  // the toggle into `#app-window-chrome-rail-toggle`, so the toggle becomes the
  // document's FIRST tab stop and the brand the second - the exact inversion of
  // the order that held before the move.
  //
  // This asserts the shipped order (chrome control -> brand -> rail contents)
  // and, critically, that the relocation stranded nothing: every control still
  // appears exactly once in the keyboard sequence. e2e/ui/qa-task-13.test.ts
  // encodes the same contract against a real browser; this is its jsdom guard.
  it('portals the collapse toggle ahead of the brand without stranding either control', () => {
    const slot = document.createElement('div');
    slot.id = 'app-window-chrome-rail-toggle';
    document.body.append(slot);
    try {
      const { container } = renderHub();

      const toggle = screen.getByTestId('hub-rail-toggle');
      const brand = screen.getByTestId('hub-brand');
      const newProject = screen.getByTestId('hub-new-project');

      // The toggle really left the rail and now lives in the chrome slot.
      expect(toggle.parentElement).toBe(slot);
      expect(container.contains(toggle)).toBe(false);
      expect(screen.getAllByTestId('hub-rail-toggle')).toHaveLength(1);

      // Document order is what the browser walks for Tab, so compare positions.
      const ordered = [...document.querySelectorAll<HTMLElement>('[data-testid]')].filter(
        (node) => node === toggle || node === brand || node === newProject,
      );
      expect(ordered.map((node) => node.dataset['testid'])).toEqual([
        'hub-rail-toggle',
        'hub-brand',
        'hub-new-project',
      ]);

      // Nothing became unreachable: each control is focusable, enabled and not
      // removed from the tab sequence by a negative tabindex.
      for (const control of [toggle, brand, newProject]) {
        expect(control.tagName).toBe('BUTTON');
        expect((control as HTMLButtonElement).disabled).toBe(false);
        expect(control.tabIndex).toBeGreaterThanOrEqual(0);
        control.focus();
        expect(document.activeElement).toBe(control);
      }
    } finally {
      slot.remove();
    }
  });

  it('updates collapsed semantics and the rendered tree synchronously', () => {
    renderHub();
    const hub = screen.getByTestId('hub-nav').parentElement;
    const toggle = screen.getByTestId('hub-rail-toggle');

    expect(hub?.dataset['railCollapsed']).toBe('false');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    const expandedLabel = toggle.getAttribute('aria-label');

    fireEvent.click(toggle);

    expect(hub?.dataset['railCollapsed']).toBe('true');
    expect(hub?.classList.contains('hub--rail-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).not.toBe(expandedLabel);

    fireEvent.click(toggle);
    expect(hub?.dataset['railCollapsed']).toBe('false');
  });

  it('resizes within bounds by keyboard and preserves the expanded width through collapse and remount', () => {
    const first = renderHub();
    const hub = screen.getByTestId('hub-nav').parentElement as HTMLElement;
    const resizer = screen.getByTestId('hub-rail-resizer');
    const toggle = screen.getByTestId('hub-rail-toggle');

    expect(hub.style.getPropertyValue('--hub-rail-expanded')).toBe('292px');
    fireEvent.keyDown(resizer, { key: 'End' });
    expect(hub.style.getPropertyValue('--hub-rail-expanded')).toBe('420px');
    expect(resizer.getAttribute('aria-valuenow')).toBe('420');
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(hub.style.getPropertyValue('--hub-rail-expanded')).toBe('420px');

    fireEvent.click(toggle);
    expect(hub.dataset['railCollapsed']).toBe('true');
    expect(hub.style.getPropertyValue('--hub-rail-expanded')).toBe('420px');
    fireEvent.click(toggle);
    expect(hub.dataset['railCollapsed']).toBe('false');
    expect(hub.style.getPropertyValue('--hub-rail-expanded')).toBe('420px');

    first.unmount();
    renderHub();
    const restoredHub = screen.getByTestId('hub-nav').parentElement as HTMLElement;
    const restoredResizer = screen.getByTestId('hub-rail-resizer');
    expect(restoredHub.style.getPropertyValue('--hub-rail-expanded')).toBe('420px');
    fireEvent.keyDown(restoredResizer, { key: 'Home' });
    expect(restoredHub.style.getPropertyValue('--hub-rail-expanded')).toBe('262px');
  });

  it('calls New Project once when the current Hub trigger is clicked', () => {
    const onNewProject = vi.fn();
    renderHub({ onNewProject });

    fireEvent.click(screen.getByTestId('hub-new-project'));

    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

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

  it('defers daemon deletion until the undo window expires', async () => {
    seedTwoSessions();
    deleteConversation.mockResolvedValue(true);
    renderHub();
    await screen.findByTestId('hub-session-c2');
    vi.useFakeTimers();
    expect(screen.getByTestId('hub-group-count').textContent).toBe('2');

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));

    expect(deleteConversation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hub-session-c2')).toBeNull();
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    act(() => vi.advanceTimersByTime(6000));
    expect(deleteConversation).toHaveBeenCalledWith('p1', 'c2');
  });

  it('undoes an optimistic deletion without calling the daemon', async () => {
    seedTwoSessions();
    renderHub();
    await screen.findByTestId('hub-session-c2');
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('hub-session-c2'));
    fireEvent.click(screen.getByTestId('hub-peek-c2'));

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(screen.queryByTestId('hub-session-c2')).toBeNull();
    expect(screen.queryByTestId('hub-open-work-c2')).toBeNull();
    expect(screen.queryByTestId('hub-inspector')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('hub-session-c2')).toBeTruthy();
    expect(screen.getByTestId('hub-open-work-c2')).toBeTruthy();
    expect(screen.getByTestId('hub-inspector')).toBeTruthy();
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('commits a pending deletion when the hub unmounts', async () => {
    seedTwoSessions();
    deleteConversation.mockResolvedValue(true);
    const hub = renderHub();
    await screen.findByTestId('hub-session-c2');
    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));

    hub.unmount();
    expect(deleteConversation).toHaveBeenCalledWith('p1', 'c2');
  });

  it('commits the first back-to-back deletion and keeps the second undoable', async () => {
    seedTwoSessions();
    deleteConversation.mockResolvedValue(true);
    renderHub();
    await screen.findByTestId('hub-session-c2');
    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    fireEvent.click(screen.getByTestId('hub-menu-session-c1'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));

    expect(deleteConversation).toHaveBeenCalledTimes(1);
    expect(deleteConversation).toHaveBeenCalledWith('p1', 'c2');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.queryByTestId('hub-session-c2')).toBeNull();
    expect(deleteConversation).toHaveBeenCalledTimes(1);
  });

  it('restores a session the daemon refuses to delete', async () => {
    seedTwoSessions();
    let resolveDelete: ((result: boolean) => void) | undefined;
    deleteConversation.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveDelete = resolve;
    }));
    renderHub();
    await screen.findByTestId('hub-session-c2');
    vi.useFakeTimers();

    fireEvent.click(screen.getByTestId('hub-menu-session-c2'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    act(() => vi.advanceTimersByTime(6000));
    await act(async () => {
      resolveDelete?.(false);
      await Promise.resolve();
    });
    expect(screen.getByTestId('hub-session-c2')).toBeTruthy();
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
    // A project delete is unrecoverable, so it is confirmed first.
    expect(onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hub-delete-confirm-cta'));
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
