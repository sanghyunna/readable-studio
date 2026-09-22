// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { loadMessagePage, listMessages } from '../../src/state/projects';

const { pane } = vi.hoisted(() => ({ pane: vi.fn() }));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }), useT: () => (key: string) => key }));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({ listProjectRuns: vi.fn().mockResolvedValue([]), listActiveChatRuns: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/providers/registry', async original => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]), fetchProjectFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async original => ({
  ...await original<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn().mockResolvedValue([{ id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 }]),
  listMessages: vi.fn().mockResolvedValue([]), loadMessagePage: vi.fn(),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), saveTabs: vi.fn(), persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatPane', () => ({ ChatPane: (props: ComponentProps<typeof import('../../src/components/ChatPane').ChatPane>) => { pane(props); return null; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

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
