// @vitest-environment jsdom

// "Awaiting input" is a ProjectDisplayStatus, not a ChatRunStatus: the
// conversation contract's latestRun.status can never carry it. The hub must
// read project.status so the "needs you" filter actually finds those projects.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  {
    id: 'p1',
    name: '분기 보고서',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 900,
    status: { value: 'awaiting_input' },
  },
  {
    id: 'p2',
    name: '가격 페이지',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 100,
    status: { value: 'succeeded' },
  },
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

describe('hub project status', () => {
  it('marks a project awaiting input from project.status', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    const row = await screen.findByTestId('hub-project-p1');
    expect(row.getAttribute('data-state')).toBe('awaiting');
    expect(screen.getByTestId('hub-project-p2').getAttribute('data-state')).toBe('idle');
  });

  it('counts awaiting projects in the needs-you filter', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    await screen.findByTestId('hub-project-p1');
    expect(screen.getByTestId('hub-filter-attention').textContent).toContain('1');
  });

  it('keeps the awaiting project visible under the needs-you filter', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    await screen.findByTestId('hub-project-p1');
    fireEvent.click(screen.getByTestId('hub-filter-attention'));
    expect(screen.getByTestId('hub-project-p1')).toBeTruthy();
    expect(screen.queryByTestId('hub-project-p2')).toBeNull();
  });
});
