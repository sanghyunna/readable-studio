// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

function project(id: string, name: string, updatedAt: number): Project {
  return {
    id,
    name,
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt,
  };
}

function conversation(id: string, projectId: string, title: string, status?: string) {
  return {
    id,
    projectId,
    title,
    createdAt: 1,
    updatedAt: 10,
    ...(status ? { latestRun: { status } } : {}),
  };
}

const PROJECTS = [project('p1', '분기 보고서', 900), project('p2', '가격 페이지', 100)];

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

describe('HubHome', () => {
  it('renders the start surface instead of a wall of past projects', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    expect(await screen.findByTestId('hub-composer')).toBeTruthy();
    expect(screen.queryByTestId('recent-projects-strip')).toBeNull();
    expect(screen.getByTestId('hub-nav')).toBeTruthy();
  });

  it('loads each project session into the tree', async () => {
    listConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? [conversation('c1', 'p1', '차트 팔레트 정리', 'running')]
        : [conversation('c2', 'p2', '요금제 비교표')],
    );
    renderHub();
    expect(await screen.findByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.getByTestId('hub-session-c1').getAttribute('data-state')).toBe('running');
    expect(screen.getByTestId('hub-session-c2').getAttribute('data-state')).toBe('idle');
  });

  it('hands a session straight to the caller without an intermediate view', async () => {
    const onOpenSession = vi.fn();
    listConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? [conversation('c1', 'p1', '차트 팔레트 정리')] : [],
    );
    renderHub({ onOpenSession });
    fireEvent.click(await screen.findByTestId('hub-session-c1'));
    expect(onOpenSession).toHaveBeenCalledWith('p1', 'c1');
  });

  it('submits the composer prompt', async () => {
    const onSubmitPrompt = vi.fn();
    listConversations.mockResolvedValue([]);
    renderHub({ onSubmitPrompt });
    const box = (await screen.findByTestId('hub-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '분기 리포트를 만들어 주세요' } });
    fireEvent.click(screen.getByTestId('hub-send'));
    // The composer carries the design-system choice alongside the prompt.
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트를 만들어 주세요', {
      designSystemId: null,
    });
  });

  it('announces state changes through a live region', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    const live = await screen.findByTestId('hub-live-region');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });
});
