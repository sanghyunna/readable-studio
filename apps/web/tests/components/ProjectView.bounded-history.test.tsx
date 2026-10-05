// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { loadMessagePage, listMessages, listConversations, createConversation } from '../../src/state/projects';
import { getKo } from '../../src/i18n/locales/ko';

const { pane } = vi.hoisted(() => ({ pane: vi.fn() }));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'ko', t: (key: keyof ReturnType<typeof getKo>) => getKo()[key] }), useT: () => (key: string) => key }));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({ listProjectRuns: vi.fn().mockResolvedValue([]), listActiveChatRuns: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/providers/registry', async original => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]), fetchProjectFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async original => ({
  ...await original<typeof import('../../src/state/projects')>(),
  createConversation: vi.fn(),
  listConversations: vi.fn().mockResolvedValue([{ id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 }]),
  listMessages: vi.fn().mockResolvedValue([]), loadMessagePage: vi.fn(),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), saveTabs: vi.fn(), persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatPane', () => ({ ChatPane: (props: ComponentProps<typeof import('../../src/components/ChatPane').ChatPane>) => { pane(props); return null; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); localStorage.clear(); });

it('does not create on failed listing and retries with the shipped Korean reconnect state', async () => {
  vi.useFakeTimers();
  vi.mocked(listConversations).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce([{ id: 'existing', projectId: 'p', title: null, createdAt: 1, updatedAt: 1 }]);
  vi.mocked(loadMessagePage).mockResolvedValue({ messages: [], nextPosition: null });
  await act(async () => { render(<ProjectView project={{ id: 'p', name: 'p', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
    config={DEFAULT_CONFIG} agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()} onOpenSettings={vi.fn()}
    onClearPendingPrompt={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />); });
  expect(createConversation).not.toHaveBeenCalled();
  expect(pane.mock.lastCall?.[0].error).toBe(getKo()['connection.reconnecting']);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(listConversations).toHaveBeenCalledTimes(2);
  expect(createConversation).not.toHaveBeenCalled();
  expect(loadMessagePage).toHaveBeenCalledWith('p', 'existing', { beforePosition: Number.MAX_SAFE_INTEGER });
  expect(pane.mock.lastCall?.[0].error).toBeNull();
});

it('reuses a conversation committed before its create response was lost instead of posting twice', async () => {
  vi.useFakeTimers();
  vi.mocked(listConversations).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 'committed', projectId: 'p', title: null, createdAt: 1, updatedAt: 1 }]);
  vi.mocked(createConversation).mockResolvedValueOnce(null);
  vi.mocked(loadMessagePage).mockResolvedValue({ messages: [], nextPosition: null });
  await act(async () => { render(<ProjectView project={{ id: 'p', name: 'p', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
    config={DEFAULT_CONFIG} agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()} onOpenSettings={vi.fn()}
    onClearPendingPrompt={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />); });
  expect(pane.mock.lastCall?.[0].error).toBe(getKo()['connection.reconnecting']);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(createConversation).toHaveBeenCalledTimes(1);
  expect(loadMessagePage).toHaveBeenCalledWith('p', 'committed', { beforePosition: Number.MAX_SAFE_INTEGER });
});

it('renders the newest page without draining history and reaches the oldest only on scroll-back requests', async () => {
  // Given: three pages, with the newest available immediately.
  vi.mocked(loadMessagePage).mockResolvedValueOnce({ messages: [{ id: 'm2', role: 'user', content: 'newest' }], nextPosition: 2 })
    .mockResolvedValueOnce({ messages: [{ id: 'm1', role: 'user', content: 'middle' }], nextPosition: 1 })
    .mockResolvedValueOnce({ messages: [{ id: 'm0', role: 'user', content: 'oldest' }], nextPosition: null });
  // When: open the conversation.
  await act(async () => { render(<ProjectView project={{ id: 'p', name: 'p', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
    config={DEFAULT_CONFIG} agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()} onOpenSettings={vi.fn()}
    onClearPendingPrompt={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />); });
  // Then: only one page was requested and published.
  expect(loadMessagePage).toHaveBeenCalledTimes(1);
  expect(listMessages).not.toHaveBeenCalled();
  expect(pane.mock.lastCall?.[0].messages.map((m: { id: string }) => m.id)).toEqual(['m2']);
  await act(async () => { await pane.mock.lastCall?.[0].onLoadOlderMessages(); });
  await act(async () => { await pane.mock.lastCall?.[0].onLoadOlderMessages(); });
  expect(pane.mock.lastCall?.[0].messages.map((m: { id: string }) => m.id)).toEqual(['m0', 'm1', 'm2']);
  expect(pane.mock.lastCall?.[0].hasOlderMessages).toBe(false);
  expect(loadMessagePage).toHaveBeenNthCalledWith(3, 'p', 'c', { beforePosition: 1 });
});
