// @vitest-environment jsdom

// The rail is ONE `GET /api/rail` read: the tree must say "loading" until it
// lands (never "empty"), run-state changes must refresh it instead of leaving it
// stale after first load, a failed refresh must not erase what is already shown,
// and the read count must not scale with the number of projects.

import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailResponse, RailSession } from '@readable-studio/contracts';

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { RUNS_CHANGED_EVENT } from '../../src/providers/daemon';
import type { Project } from '../../src/types';

type RailAnswer = RailResponse | 'fail' | Promise<RailResponse>;

interface RailRead {
  signal: AbortSignal | undefined;
}

let reads: RailRead[] = [];
let answer: (index: number) => RailAnswer;

beforeEach(() => {
  reads = [];
  answer = () => railBody([], []);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/rail') return { ok: false, status: 404, json: async () => ({}) } as Response;
      const index = reads.length;
      reads.push({ signal: init?.signal ?? undefined });
      const next = answer(index);
      if (next === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
      const body = await next;
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function railSession(id: string, over: Partial<RailSession> = {}): RailSession {
  return {
    id,
    workspaceId: `w-${id}`,
    folderId: null,
    title: `세션 ${id}`,
    createdAt: 1,
    updatedAt: 5,
    messageCount: 2,
    state: 'idle',
    workspaceSessionCount: 1,
    ...over,
  };
}

function railBody(folderSessions: RailSession[], recents: RailSession[]): RailResponse {
  return {
    folders: folderSessions.length
      ? [{ id: 'fast', name: '빠른 프로젝트', createdAt: 1, updatedAt: 100, sessions: folderSessions }]
      : [],
    recents,
    pinned: [], generatedAt: 1,
  };
}

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
  it('says loading, not empty, until the single rail read lands, then shows every session at once', async () => {
    let release: (body: RailResponse) => void = () => undefined;
    answer = () => new Promise<RailResponse>((resolve) => { release = resolve; });
    renderHub();

    await waitFor(() => expect(screen.getByTestId('hub-sessions-loading')).toBeTruthy());
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
    expect(screen.queryByTestId('hub-session-cf')).toBeNull();

    await act(async () => {
      release(railBody([railSession('cf', { folderId: 'fast', title: '빠른 세션' })], [railSession('cr')]));
    });
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());
    expect(screen.getByTestId('hub-session-cr')).toBeTruthy();
    expect(screen.queryByTestId('hub-sessions-loading')).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it('refreshes sessions when a run changes', async () => {
    answer = (index) =>
      railBody(
        [railSession('cf', { folderId: 'fast', title: '빠른 세션', state: index === 0 ? 'idle' : 'running' })],
        [],
      );
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());
    expect(screen.getByTestId('hub-session-cf').getAttribute('data-state')).toBe('idle');

    window.dispatchEvent(new CustomEvent(RUNS_CHANGED_EVENT));
    await waitFor(() =>
      expect(screen.getByTestId('hub-session-cf').getAttribute('data-state')).toBe('running'),
    );
    expect(reads).toHaveLength(2);
  });

  it('keeps the sessions already shown when a later rail read fails', async () => {
    answer = (index) =>
      index === 0
        ? railBody([railSession('cf', { folderId: 'fast', title: '빠른 세션' })], [])
        : 'fail';
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-cf')).toBeTruthy());

    window.dispatchEvent(new CustomEvent(RUNS_CHANGED_EVENT));
    await waitFor(() =>
      expect(screen.getByTestId('hub-sessions-error').getAttribute('data-status')).toBe('stale'),
    );
    expect(screen.getByTestId('hub-session-cf')).toBeTruthy();
  });

  it('reads the rail once however many projects exist, and still surfaces live work', async () => {
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
    answer = () =>
      railBody(
        [railSession('live-session', {
          folderId: 'fast',
          title: 'Live session',
          state: 'running',
          latestRun: { status: 'running' },
        })],
        [],
      );

    renderHub({ projects });
    await waitFor(() => expect(screen.getByTestId('hub-live-time')).toBeTruthy());

    expect(reads).toHaveLength(1);
  });

  it('aborts a superseded rail read instead of clogging the request queue', () => {
    answer = () => new Promise<RailResponse>(() => undefined);

    render(
      <StrictMode>
        <HubHome
          projects={PROJECTS}
          projectsLoading={false}
          onOpenSession={vi.fn()}
          onSubmitPrompt={vi.fn()}
          onNewProject={vi.fn()}
        />
      </StrictMode>,
    );

    // StrictMode mounts the effect twice: the first read is superseded.
    expect(reads).toHaveLength(2);
    expect(reads[0]?.signal?.aborted).toBe(true);
    expect(reads[1]?.signal?.aborted).toBe(false);
  });
});
