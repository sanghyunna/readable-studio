// @vitest-environment jsdom

// The hub used to render "no sessions" for a project whose read had failed,
// because `listConversations()` flattened every error into `[]`. These lock the
// four states the result-returning reader made expressible - loading, known
// empty, stale-with-cache, unavailable-without-cache - plus the per-project
// retry, the generation guard that drops a late older response, and the
// new-session action that creates a real conversation before navigating.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readConversations = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  readConversations,
  createConversation,
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Conversation, Project } from '../../src/types';

afterEach(() => {
  cleanup();
  readConversations.mockReset();
  createConversation.mockReset();
});

const P1: Project = {
  id: 'p1',
  name: '분기 보고서',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 900,
};
const P2: Project = {
  id: 'p2',
  name: '가격 페이지',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 100,
};

function conversation(id: string, projectId: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    projectId,
    title: `세션 ${id}`,
    createdAt: 1,
    updatedAt: 5,
    ...over,
  } as Conversation;
}

function ok(conversations: Conversation[]) {
  return { ok: true as const, conversations };
}

function fail(retryable = true) {
  return {
    ok: false as const,
    error: { code: 'network' as const, message: 'daemon unreachable', retryable },
  };
}

function renderHub(projects: Project[], overrides: Record<string, unknown> = {}) {
  return render(
    <HubHome
      projects={projects}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
      {...overrides}
    />,
  );
}

describe('hub session read states', () => {
  it('starts in loading rather than claiming the project is empty', async () => {
    readConversations.mockImplementation(() => new Promise(() => undefined));
    renderHub([P1]);
    await waitFor(() => expect(screen.getByTestId('hub-sessions-loading-p1')).toBeTruthy());
    expect(screen.queryByTestId('hub-sessions-error-p1')).toBeNull();
  });

  it('treats a successful empty read as known-empty, not as a failure', async () => {
    readConversations.mockResolvedValue(ok([]));
    renderHub([P1]);
    await waitFor(() => expect(screen.queryByTestId('hub-sessions-loading-p1')).toBeNull());
    expect(screen.queryByTestId('hub-sessions-error-p1')).toBeNull();
    expect(screen.getByTestId('hub-sessions-status').getAttribute('hidden')).not.toBeNull();
  });

  it('renders "unavailable" with no cache and never claims there are no sessions', async () => {
    readConversations.mockResolvedValue(fail());
    renderHub([P1]);
    const note = await screen.findByTestId('hub-sessions-error-p1');
    expect(note.getAttribute('data-status')).toBe('unavailable');
    expect(note.textContent).toContain('Sessions unavailable');
    expect(note.textContent).not.toContain('No sessions');
  });

  it('keeps cached rows and marks them stale when a later read fails', async () => {
    readConversations
      .mockResolvedValueOnce(ok([conversation('c1', 'p1')]))
      .mockResolvedValue(fail());
    renderHub([P1]);
    await waitFor(() => expect(screen.getByTestId('hub-session-c1')).toBeTruthy());

    window.dispatchEvent(new CustomEvent('readable-studio:runs-changed'));
    const note = await screen.findByTestId('hub-sessions-error-p1');
    expect(note.getAttribute('data-status')).toBe('stale');
    // The rows the user was reading are still there.
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
  });

  it('lets one project fail without erasing a sibling', async () => {
    readConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? fail() : ok([conversation('c2', 'p2')]),
    );
    renderHub([P1, P2]);
    await screen.findByTestId('hub-sessions-error-p1');
    expect(screen.getByTestId('hub-session-c2')).toBeTruthy();
    expect(screen.queryByTestId('hub-sessions-error-p2')).toBeNull();
  });

  it('announces the aggregate failure count as text, not colour', async () => {
    readConversations.mockResolvedValue(fail());
    renderHub([P1, P2]);
    await screen.findByTestId('hub-sessions-error-p1');
    const status = screen.getByTestId('hub-sessions-status');
    await waitFor(() => expect(status.textContent).toContain('2'));
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('hidden')).toBeNull();
  });

  it('retries only the failing project and recovers its rows', async () => {
    readConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? fail() : ok([conversation('c2', 'p2')]),
    );
    renderHub([P1, P2]);
    await screen.findByTestId('hub-sessions-error-p1');
    const callsBefore = readConversations.mock.calls.filter((call) => call[0] === 'p2').length;

    readConversations.mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? ok([conversation('c1', 'p1')]) : ok([conversation('c2', 'p2')]),
    );
    fireEvent.click(screen.getByTestId('hub-sessions-retry-p1'));

    await waitFor(() => expect(screen.getByTestId('hub-session-c1')).toBeTruthy());
    expect(screen.queryByTestId('hub-sessions-error-p1')).toBeNull();
    const callsAfter = readConversations.mock.calls.filter((call) => call[0] === 'p2').length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('ignores a late response from a superseded generation', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    readConversations
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(ok([conversation('fresh', 'p1')]));

    renderHub([P1]);
    await waitFor(() => expect(screen.getByTestId('hub-sessions-loading-p1')).toBeTruthy());

    // A second read supersedes the first, then the ORIGINAL request finally
    // answers with older data. The newer result must win.
    window.dispatchEvent(new CustomEvent('readable-studio:runs-changed'));
    await waitFor(() => expect(screen.getByTestId('hub-session-fresh')).toBeTruthy());

    releaseFirst?.(ok([conversation('stale-row', 'p1')]));
    await Promise.resolve();
    await waitFor(() => expect(screen.getByTestId('hub-session-fresh')).toBeTruthy());
    expect(screen.queryByTestId('hub-session-stale-row')).toBeNull();
  });
});

describe('hub new-session action', () => {
  it('creates a conversation and hands it to the workspace', async () => {
    readConversations.mockResolvedValue(ok([]));
    createConversation.mockResolvedValue(conversation('new-1', 'p1'));
    const onOpenSession = vi.fn();
    renderHub([P1], { onOpenSession });

    fireEvent.click(await screen.findByTestId('hub-new-session-p1'));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('p1', 'new-1'));
    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('fires one create when the action is clicked repeatedly', async () => {
    readConversations.mockResolvedValue(ok([]));
    let release: ((value: Conversation) => void) | undefined;
    createConversation.mockImplementation(
      () =>
        new Promise<Conversation>((resolve) => {
          release = resolve;
        }),
    );
    renderHub([P1]);

    const action = await screen.findByTestId('hub-new-session-p1');
    fireEvent.click(action);
    fireEvent.click(action);
    fireEvent.click(action);
    expect(createConversation).toHaveBeenCalledTimes(1);

    release?.(conversation('new-1', 'p1'));
    await waitFor(() => expect(screen.getByTestId('hub-session-new-1')).toBeTruthy());
  });

  it('opens an existing empty session instead of creating another one', async () => {
    readConversations.mockResolvedValue(ok([conversation('c1', 'p1', { messageCount: 0 })]));
    const onOpenSession = vi.fn();
    renderHub([P1], { onOpenSession });

    await screen.findByTestId('hub-session-c1');
    fireEvent.click(screen.getByTestId('hub-new-session-p1'));

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('p1', 'c1'));
    expect(createConversation).not.toHaveBeenCalled();
  });
});

describe('hub session metadata', () => {
  it('shows relative last activity on a completed session row', async () => {
    const updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    readConversations.mockResolvedValue(ok([conversation('c1', 'p1', { updatedAt })]));
    renderHub([P1]);

    const meta = await screen.findByTestId('hub-row-time-c1');
    expect(meta.textContent).toMatch(/2/);
  });

  it('keeps the state badge instead of a timestamp while a session runs', async () => {
    readConversations.mockResolvedValue(
      ok([conversation('c1', 'p1', { latestRun: { status: 'running' } } as Partial<Conversation>)]),
    );
    renderHub([P1]);

    await screen.findByTestId('hub-session-c1');
    expect(screen.queryByTestId('hub-row-time-c1')).toBeNull();
  });
});

describe('hub starters', () => {
  it('omits the folder starter when no import route is available', async () => {
    readConversations.mockResolvedValue(ok([]));
    renderHub([P1]);
    await waitFor(() => expect(screen.queryByTestId('hub-import-folder')).toBeNull());
  });

  it('renders a starter failure as a visible alert', async () => {
    readConversations.mockResolvedValue(ok([]));
    renderHub([P1], { starterError: { message: 'Import failed: bad zip' } });
    const alert = await screen.findByTestId('hub-starter-error');
    expect(alert.textContent).toContain('Import failed: bad zip');
    expect(alert.getAttribute('role')).toBe('alert');
  });
});
