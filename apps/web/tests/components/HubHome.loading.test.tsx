// @vitest-environment jsdom

// One slow project must not hide every other project's sessions, and run-state
// changes must refresh the tree instead of leaving it stale after first load.

import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('prioritizes live work without launching a request for every project at once', async () => {
    const projects: Project[] = Array.from({ length: 525 }, (_, index) => ({
      id: `idle-${index}`,
      name: `Idle project ${index}`,
      skillId: null,
      designSystemId: null,
      createdAt: index,
      updatedAt: index,
    }));
    projects.push({
      id: 'live-project',
      name: 'Live project',
      skillId: null,
      designSystemId: null,
      createdAt: 0,
      updatedAt: 0,
      status: { value: 'running', updatedAt: 1 },
    });
    listConversations.mockImplementation(async (projectId: string) => {
      if (projectId !== 'live-project') return new Promise(() => undefined);
      return [{
        id: 'live-session',
        projectId,
        title: 'Live session',
        createdAt: 1,
        updatedAt: 1,
        latestRun: { status: 'running' },
      }];
    });

    renderHub({ projects });
    await act(async () => undefined);

    expect(listConversations).toHaveBeenCalledTimes(7);
    expect(listConversations.mock.calls[0]?.[0]).toBe('live-project');
    expect(screen.getByTestId('hub-live-time')).toBeTruthy();
  });

  it('aborts a superseded 501-project read wave instead of clogging the request queue', () => {
    const projects = Array.from({ length: 501 }, (_, index) => ({
      id: `scale-${index}`,
      name: `Scale project ${index}`,
      skillId: null,
      designSystemId: null,
      createdAt: index,
      updatedAt: index,
    }));
    listConversations.mockImplementation(() => new Promise(() => undefined));

    render(
      <StrictMode>
        <HubHome
          projects={projects}
          projectsLoading={false}
          onOpenSession={vi.fn()}
          onSubmitPrompt={vi.fn()}
          onNewProject={vi.fn()}
        />
      </StrictMode>,
    );

    expect(listConversations).toHaveBeenCalledTimes(12);
    const firstWaveSignals = listConversations.mock.calls
      .slice(0, 6)
      .map((call) => call[1]?.signal as AbortSignal | undefined);
    const currentWaveSignals = listConversations.mock.calls
      .slice(6)
      .map((call) => call[1]?.signal as AbortSignal | undefined);
    expect(firstWaveSignals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(currentWaveSignals.every((signal) => signal?.aborted === false)).toBe(true);
  });
});
