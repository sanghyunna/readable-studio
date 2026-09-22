// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePetTaskCenter } from '../../src/hooks/usePetTaskCenter';
import { listProjectRuns, RUNS_CHANGED_EVENT } from '../../src/providers/daemon';
import type { Project } from '../../src/types';
import type { ChatRunStatusResponse } from '@readable-studio/contracts';

vi.mock('../../src/providers/daemon', () => ({
  RUNS_CHANGED_EVENT: 'readable-studio:runs-changed',
  listProjectRuns: vi.fn().mockResolvedValue([]),
}));
const projects: Project[] = [
  { id: 'p1', name: 'External task', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 },
];
const running: ChatRunStatusResponse = {
  id: 'r1', projectId: 'p1', conversationId: null, assistantMessageId: null,
  agentId: null, status: 'running', createdAt: 1, updatedAt: 1,
};
function pendingRuns() {
  let resolve: (runs: []) => void = () => { throw new Error('Promise executor did not run'); };
  const promise = new Promise<[]>((complete) => { resolve = complete; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([false, true])('pauses hidden polling and refreshes on visibility when lowSpec=%s', async (lowSpec) => {
  // Given a hidden page.
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  renderHook(() => usePetTaskCenter({ enabled: true, lowSpec, projects }));
  // When the polling period elapses in the background.
  await act(async () => { vi.advanceTimersByTime(45000); });
  // Then no request is made until visibility returns.
  expect(listProjectRuns).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(listProjectRuns).toHaveBeenCalledTimes(1);
});

it.each([false, true])('coalesces in-flight changes without losing the last update when lowSpec=%s', async (lowSpec) => {
  // Given a pending request.
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const pending = pendingRuns();
  vi.mocked(listProjectRuns).mockReturnValueOnce(pending.promise);
  renderHook(() => usePetTaskCenter({ enabled: true, lowSpec, projects }));
  // When several run changes arrive during that request.
  await act(async () => {
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
    vi.advanceTimersByTime(45000);
  });
  expect(listProjectRuns).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve([]); });
  // Then exactly one trailing request captures the changes.
  expect(listProjectRuns).toHaveBeenCalledTimes(2);
});

it.each([
  { lowSpec: false, interval: 2000 },
  { lowSpec: true, interval: 15000 },
])('publishes external run completion without a local event when lowSpec=$lowSpec', async ({ lowSpec, interval }) => {
  // Given a consumed running task.
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.mocked(listProjectRuns).mockResolvedValueOnce([running]);
  const hook = renderHook(() => usePetTaskCenter({ enabled: true, lowSpec, projects }));
  await act(async () => {});
  expect(hook.result.current.running).toEqual([
    { projectId: 'p1', projectName: 'External task', status: 'running', count: 1 },
  ]);
  vi.mocked(listProjectRuns).mockResolvedValueOnce([{ ...running, status: 'succeeded', updatedAt: 2 }]);
  // When another client completes the run and the visible fallback fires.
  await act(async () => { vi.advanceTimersByTime(interval); });
  // Then the same truth reaches pet state in either profile.
  expect(hook.result.current).toEqual({
    running: [], queued: [],
    recent: [{ projectId: 'p1', projectName: 'External task', status: 'succeeded', updatedAt: 2 }],
  });
});

it.each([false, true])('does no work without a consumer when lowSpec=%s', async (lowSpec) => {
  // Given an inactive source on a visible page.
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  renderHook(() => usePetTaskCenter({ enabled: false, lowSpec, projects }));
  // When fallback deadlines and local events arrive.
  await act(async () => {
    vi.advanceTimersByTime(45000);
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Then no request is started in either profile.
  expect(listProjectRuns).not.toHaveBeenCalled();
});

it('preserves the two-second refresh cadence in full mode', async () => {
  // Given a visible full-profile pet with an initial response.
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { renderHook(() => usePetTaskCenter({ enabled: true, lowSpec: false, projects })); });
  vi.mocked(listProjectRuns).mockClear();
  // When the full-profile fallback deadline arrives.
  await act(async () => { vi.advanceTimersByTime(2000); });
  // Then external runs remain discoverable without a local event.
  expect(listProjectRuns).toHaveBeenCalledTimes(1);
});

it('retains task identity when a fallback poll finds no changes', async () => {
  // Given an already loaded empty task center.
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const hook = renderHook(() => usePetTaskCenter({ enabled: true, lowSpec: false, projects }));
  await act(async () => {});
  const previous = hook.result.current;
  // When the fallback receives an identical snapshot.
  await act(async () => { vi.advanceTimersByTime(2000); });
  // Then App does not re-render its subtree for unchanged pet state.
  expect(hook.result.current).toBe(previous);
});

it('does not publish or re-fetch after unmount', async () => {
  // Given a pending request and a queued change.
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const pending = pendingRuns();
  vi.mocked(listProjectRuns).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => usePetTaskCenter({ enabled: true, lowSpec: false, projects }));
  window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
  // When the owner unmounts before completion.
  hook.unmount();
  await act(async () => { pending.resolve([]); });
  // Then cleanup prevents trailing work.
  expect(listProjectRuns).toHaveBeenCalledTimes(1);
});
