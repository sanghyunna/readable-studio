// @vitest-environment jsdom

// One slow project must not hide every other project's sessions, and run-state
// changes must refresh the tree instead of leaving it stale after first load.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'slow', name: '느린 프로젝트', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
  { id: 'fast', name: '빠른 프로젝트', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 100 },
];

function renderHub(overrides = {}) {
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

describe('hub session loading', () => {
  it('shows a fast project even while another is still loading', async () => {
    listConversations.mockImplementation(async (projectId: string) => {
      if (projectId === 'slow') return new Promise(() => undefined);
      return [{ id: 'cf', projectId: 'fast', title: '빠른 세션', createdAt: 1, updatedAt: 5 }];
    });
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());
  });

  it('refreshes sessions when a run changes', async () => {
    let call = 0;
    listConversations.mockImplementation(async (projectId: string) => {
      call += 1;
      if (projectId !== 'fast') return [];
      return call > 2
        ? [
            {
              id: 'cf',
              projectId: 'fast',
              title: '빠른 세션',
              createdAt: 1,
              updatedAt: 5,
              latestRun: { status: 'running' },
            },
          ]
        : [{ id: 'cf', projectId: 'fast', title: '빠른 세션', createdAt: 1, updatedAt: 5 }];
    });
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());
    expect(screen.getByTestId('hub-session-cf').getAttribute('data-state')).toBe('idle');

    window.dispatchEvent(new CustomEvent('readable-studio:runs-changed'));
    await waitFor(() =>
      expect(screen.getByTestId('hub-session-cf').getAttribute('data-state')).toBe('running'),
    );
  });

  it('keeps a failing project from erasing the others', async () => {
    listConversations.mockImplementation(async (projectId: string) => {
      if (projectId === 'slow') throw new Error('daemon down');
      return [{ id: 'cf', projectId: 'fast', title: '빠른 세션', createdAt: 1, updatedAt: 5 }];
    });
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());
  });
});
