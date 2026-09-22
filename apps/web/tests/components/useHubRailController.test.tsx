// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHubRailController } from '../../src/components/hub/useHubRailController';
import type { Project } from '../../src/types';

const readConversations = vi.hoisted(() => vi.fn<
  typeof import('../../src/state/projects').readConversations
>(() => new Promise(() => undefined)));

vi.mock('../../src/state/projects', () => ({
  readConversations,
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  patchConversation: vi.fn(),
}));
afterEach(() => {
  cleanup();
  readConversations.mockReset();
  window.sessionStorage.clear();
});

const project: Project = {
  id: 'one', name: 'One', skillId: null, designSystemId: null,
  createdAt: 1, updatedAt: 1,
};

it.each([{ projects: [] }, { projects: [project] }])('does not commit derived loading state when mounted with $projects', ({ projects }) => {
  // Given: session reads have not completed.
  let commits = 0;
  // When: the controller mounts.
  const { result } = renderHook(() => {
    const rail = useHubRailController({
      projects, currentSessionId: null,
      onOpenSession: vi.fn(), onNewProject: vi.fn(),
    });
    useLayoutEffect(() => { commits += 1; });
    return rail;
  });
  // Then: loading is already correct in the first commit.
  expect(result.current.allNodes.map((node) => node.sessionsStatus)).toEqual(projects.map(() => 'loading'));
  expect(commits).toBe(1);
});

const sibling: Project = { ...project, id: 'two', name: 'Two' };
const session = {
  id: 'session-one', projectId: project.id, title: 'Loaded session',
  createdAt: 1, updatedAt: 1,
  latestRun: { status: 'running' as const },
};

it.each([{ projects: [] }, { projects: [sibling] }])('removes cached project data from every rail surface when projects become $projects', async ({ projects }) => {
  // Given: a loaded project has an open and inspected running session.
  const loaded = Promise.resolve({ ok: true as const, conversations: [session] });
  readConversations.mockReturnValueOnce(loaded);
  const { result, rerender } = renderHook(({ projects }: { projects: Project[] }) =>
    useHubRailController({
      projects, currentSessionId: session.id,
      onOpenSession: vi.fn(), onNewProject: vi.fn(),
    }), { initialProps: { projects: [project, sibling] } });
  await act(async () => { await loaded; });
  const loadedSession = result.current.allNodes[0]?.sessions[0];
  expect(loadedSession?.id).toBe(session.id);
  if (!loadedSession) throw new Error('Fixture session did not load');
  act(() => {
    result.current.openSession(loadedSession);
    result.current.peekSession(loadedSession);
  });

  // When: the project is removed while new reads remain pending.
  rerender({ projects });

  // Then: no rail surface can expose the removed project's cached session.
  expect(result.current.allNodes.map((node) => node.id)).toEqual(projects.map((item) => item.id));
  expect(result.current.tree.flatMap((node) => node.sessions)).toEqual([]);
  expect(result.current.openWork).toEqual([]);
  expect(result.current.peeked).toBeNull();
  expect(result.current.running).toBeNull();
  expect(result.current.paletteEntries.some((entry) => entry.id === `session-${session.id}`)).toBe(false);
});

it.each([{ projects: [] }, { projects: [sibling] }])('loads a re-added project without its removed cache after projects became $projects', async ({ projects }) => {
  // Given: a formerly loaded project was removed while reads were paused.
  const loaded = Promise.resolve({ ok: true as const, conversations: [session] });
  readConversations.mockReturnValueOnce(loaded);
  const { result, rerender } = renderHook(
    ({ projects, pauseSessionReads }: { projects: Project[]; pauseSessionReads: boolean }) =>
      useHubRailController({
        projects, pauseSessionReads, currentSessionId: null,
        onOpenSession: vi.fn(), onNewProject: vi.fn(),
      }), { initialProps: { projects: [project, sibling], pauseSessionReads: false } });
  await act(async () => { await loaded; });
  expect(result.current.allNodes[0]?.sessions[0]?.id).toBe(session.id);
  rerender({ projects, pauseSessionReads: true });

  // When: the same project is re-added before any new read can complete.
  rerender({ projects: [project, sibling], pauseSessionReads: true });

  // Then: its cache was pruned, not merely hidden from the removed tree.
  expect(result.current.allNodes[0]?.sessionsStatus).toBe('loading');
  expect(result.current.allNodes[0]?.sessions).toEqual([]);
});
