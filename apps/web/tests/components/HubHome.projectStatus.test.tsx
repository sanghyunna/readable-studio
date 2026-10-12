// @vitest-environment jsdom

// "Awaiting input" is a session state the daemon attributes from workspace
// status, not a ChatRunStatus: `latestRun.status` can never carry it. The hub
// must read the rail session's `state` so the "needs you" filter counts the
// sessions (not folders) that need the user and keeps their folders visible.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailResponse, RailSession } from '@readable-studio/contracts';

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import type { Project } from '../../src/types';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/rail') return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => RAIL } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function railSession(id: string, folderId: string, state: RailSession['state']): RailSession {
  return {
    id,
    workspaceId: `w-${id}`,
    folderId,
    title: `세션 ${id}`,
    createdAt: 1,
    updatedAt: 5,
    messageCount: 2,
    // `awaiting` can never come from the run status.
    latestRun: { status: 'succeeded' },
    state,
    workspaceSessionCount: 1,
  };
}

const RAIL: RailResponse = {
  folders: [
    {
      id: 'p1',
      name: '분기 보고서',
      createdAt: 1,
      updatedAt: 900,
      sessions: [railSession('a1', 'p1', 'awaiting'), railSession('a2', 'p1', 'awaiting')],
    },
    {
      id: 'p2',
      name: '가격 페이지',
      createdAt: 1,
      updatedAt: 100,
      sessions: [railSession('b1', 'p2', 'idle')],
    },
  ],
  recents: [],
  pinned: [], generatedAt: 1,
};

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
  { id: 'p2', name: '가격 페이지', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 100 },
];

function renderHub() {
  return render(
    <HubHome
      projects={PROJECTS}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
    />,
  );
}

describe('hub awaiting-input state', () => {
  it('marks a folder and its sessions awaiting from the rail session state', async () => {
    renderHub();
    const row = await screen.findByTestId('hub-project-p1');
    expect(row.getAttribute('data-state')).toBe('awaiting');
    expect(screen.getByTestId('hub-session-a1').getAttribute('data-state')).toBe('awaiting');
    expect(screen.getByTestId('hub-project-p2').getAttribute('data-state')).toBe('idle');
    expect(screen.getByTestId('hub-session-b1').getAttribute('data-state')).toBe('idle');
  });

  it('counts awaiting sessions, not folders, in the needs-you filter', async () => {
    renderHub();
    await screen.findByTestId('hub-project-p1');
    expect(screen.getByTestId('hub-filter-attention').textContent).toContain('2');
  });

  it('keeps the folder with awaiting sessions visible under the needs-you filter', async () => {
    renderHub();
    await screen.findByTestId('hub-project-p1');
    fireEvent.click(screen.getByTestId('hub-filter-attention'));
    expect(screen.getByTestId('hub-project-p1')).toBeTruthy();
    expect(screen.getByTestId('hub-session-a1')).toBeTruthy();
    expect(screen.queryByTestId('hub-project-p2')).toBeNull();
    expect(screen.queryByTestId('hub-session-b1')).toBeNull();
  });
});
