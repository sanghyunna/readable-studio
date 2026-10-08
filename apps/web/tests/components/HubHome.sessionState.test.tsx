// @vitest-environment jsdom

// The hub must never render "no sessions" for a rail whose read failed. These
// lock the states the single `GET /api/rail` read makes expressible - loading,
// known empty, stale-with-cache, unavailable-without-cache - plus the rail-wide
// retry, the generation guard that drops a late older response, and the row
// metadata a session shows.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailResponse, RailSession } from '@readable-studio/contracts';

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { RUNS_CHANGED_EVENT } from '../../src/providers/daemon';
import type { Project } from '../../src/types';

type RailAnswer = RailResponse | 'fail' | Promise<RailResponse>;

let railReads = 0;
let answer: (index: number) => RailAnswer;

beforeEach(() => {
  railReads = 0;
  answer = () => rail([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/rail') return { ok: false, status: 404, json: async () => ({}) } as Response;
      const next = answer(railReads);
      railReads += 1;
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

const P1: Project = {
  id: 'p1',
  name: '분기 보고서',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 900,
};

function session(id: string, over: Partial<RailSession> = {}): RailSession {
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

function rail(recents: RailSession[]): RailResponse {
  return { folders: [], recents, generatedAt: 1 };
}

function renderHub() {
  return render(
    <HubHome
      projects={[P1]}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
    />,
  );
}

describe('hub session read states', () => {
  it('starts in loading rather than claiming there are no sessions', async () => {
    answer = () => new Promise<RailResponse>(() => undefined);
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-sessions-loading')).toBeTruthy());
    expect(screen.queryByTestId('hub-sessions-error')).toBeNull();
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
  });

  it('treats a successful empty read as known-empty, not as a failure', async () => {
    answer = () => rail([]);
    renderHub();
    await waitFor(() => expect(screen.queryByTestId('hub-sessions-loading')).toBeNull());
    expect(screen.queryByTestId('hub-sessions-error')).toBeNull();
    expect(screen.getByTestId('hub-tree-no-projects')).toBeTruthy();
  });

  it('renders "unavailable" with no cache and never claims there are no sessions', async () => {
    answer = () => 'fail';
    renderHub();
    const note = await screen.findByTestId('hub-sessions-error');
    expect(note.getAttribute('data-status')).toBe('unavailable');
    expect(note.textContent).toContain('Sessions unavailable');
    expect(note.textContent).not.toContain('No sessions');
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
    expect(screen.queryByTestId('hub-sessions-loading')).toBeNull();
  });

  it('keeps cached rows and marks them stale when a later read fails', async () => {
    answer = (index) => (index === 0 ? rail([session('c1')]) : 'fail');
    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-session-c1')).toBeTruthy());

    window.dispatchEvent(new CustomEvent(RUNS_CHANGED_EVENT));
    const note = await screen.findByTestId('hub-sessions-error');
    expect(note.getAttribute('data-status')).toBe('stale');
    // The rows the user was reading are still there.
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
  });

  it('states the failure as text with a retry control, not as colour alone', async () => {
    answer = () => 'fail';
    renderHub();
    const note = await screen.findByTestId('hub-sessions-error');
    expect(note.textContent?.trim().length).toBeGreaterThan(0);
    const retry = screen.getByTestId('hub-sessions-retry');
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('retries the whole rail with one read and recovers its rows', async () => {
    answer = () => 'fail';
    renderHub();
    await screen.findByTestId('hub-sessions-error');
    expect(railReads).toBe(1);

    answer = () => rail([session('c1')]);
    fireEvent.click(screen.getByTestId('hub-sessions-retry'));

    await waitFor(() => expect(screen.getByTestId('hub-session-c1')).toBeTruthy());
    expect(screen.queryByTestId('hub-sessions-error')).toBeNull();
    expect(railReads).toBe(2);
  });

  it('ignores a late response from a superseded generation', async () => {
    let releaseFirst: (body: RailResponse) => void = () => undefined;
    answer = (index) =>
      index === 0
        ? new Promise<RailResponse>((resolve) => {
            releaseFirst = resolve;
          })
        : rail([session('fresh')]);

    renderHub();
    await waitFor(() => expect(screen.getByTestId('hub-sessions-loading')).toBeTruthy());

    // A second read supersedes the first, then the ORIGINAL request finally
    // answers with older data. The newer result must win.
    window.dispatchEvent(new CustomEvent(RUNS_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByTestId('hub-session-fresh')).toBeTruthy());

    await act(async () => {
      releaseFirst(rail([session('stale-row')]));
    });
    expect(screen.getByTestId('hub-session-fresh')).toBeTruthy();
    expect(screen.queryByTestId('hub-session-stale-row')).toBeNull();
  });
});

describe('hub session metadata', () => {
  it('shows relative last activity on a completed session row', async () => {
    const updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    answer = () => rail([session('c1', { updatedAt })]);
    renderHub();

    const meta = await screen.findByTestId('hub-when-c1');
    expect(meta.textContent).toMatch(/2/);
  });

  it('keeps the state badge instead of a timestamp while a session runs', async () => {
    answer = () => rail([session('c1', { state: 'running', latestRun: { status: 'running' } })]);
    renderHub();

    const row = await screen.findByTestId('hub-session-c1');
    expect(row.getAttribute('data-state')).toBe('running');
    expect(screen.queryByTestId('hub-when-c1')).toBeNull();
  });
});
