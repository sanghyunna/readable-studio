// @vitest-environment jsdom

// The objective puts ALL navigation in the left panel: brand/home, the
// project -> session tree, filters, sort AND search. Search must narrow the
// same rows the tree already renders rather than introducing a second list.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
  { id: 'p2', name: '가격 페이지', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 100 },
];

function renderHub(overrides = {}) {
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

describe('hub left panel navigation', () => {
  it('shows the product brand as a home affordance', async () => {
    listConversations.mockResolvedValue([]);
    const onGoHome = vi.fn();
    renderHub({ onGoHome });
    fireEvent.click(await screen.findByTestId('hub-brand'));
    expect(onGoHome).toHaveBeenCalled();
  });

  it('narrows the tree to matching sessions', async () => {
    listConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? [
            { id: 'c1', projectId: 'p1', title: '차트 팔레트 정리', createdAt: 1, updatedAt: 9 },
            { id: 'c2', projectId: 'p1', title: '각주 정리', createdAt: 1, updatedAt: 8 },
          ]
        : [{ id: 'c3', projectId: 'p2', title: '요금제 비교표', createdAt: 1, updatedAt: 7 }],
    );
    renderHub();
    expect(await screen.findByTestId('hub-session-c1')).toBeTruthy();

    fireEvent.change(screen.getByTestId('hub-search'), { target: { value: '각주' } });
    expect(screen.queryByTestId('hub-session-c1')).toBeNull();
    expect(screen.getByTestId('hub-session-c2')).toBeTruthy();
    expect(screen.queryByTestId('hub-session-c3')).toBeNull();
  });

  it('matches on the project name too', async () => {
    listConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p2'
        ? [{ id: 'c3', projectId: 'p2', title: '요금제 비교표', createdAt: 1, updatedAt: 7 }]
        : [],
    );
    renderHub();
    await screen.findByTestId('hub-project-p2');
    fireEvent.change(screen.getByTestId('hub-search'), { target: { value: '가격' } });
    expect(screen.getByTestId('hub-project-p2')).toBeTruthy();
    expect(screen.queryByTestId('hub-project-p1')).toBeNull();
  });

  it('reports when a query matches nothing', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    await screen.findByTestId('hub-search');
    fireEvent.change(screen.getByTestId('hub-search'), { target: { value: 'zzzz-없음' } });
    expect(screen.getByTestId('hub-tree-empty')).toBeTruthy();
  });
});
