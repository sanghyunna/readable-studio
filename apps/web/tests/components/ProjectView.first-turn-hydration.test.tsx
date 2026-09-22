// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, type ComponentProps, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { fetchChatRunStatus, listActiveChatRuns, reattachDaemonRun, streamViaDaemon } from '../../src/providers/daemon';
import { listConversations, listMessages, saveMessage } from '../../src/state/projects';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { ChatAttachment, Project } from '../../src/types';

const { chatPaneSpy } = vi.hoisted(() => ({ chatPaneSpy: vi.fn() }));
vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: vi.fn(), t: (key: string) => key }),
  useT: () => (key: string) => key,
}));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(), listActiveChatRuns: vi.fn(),
  listProjectRuns: vi.fn().mockResolvedValue([]), reattachDaemonRun: vi.fn(), streamViaDaemon: vi.fn(),
}));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]),
  fetchProjectFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn(), listMessages: vi.fn(),
  loadMessagePage: async (projectId: string, conversationId: string) => ({ messages: await listMessages(projectId, conversationId), nextPosition: null }),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), patchConversation: vi.fn(),
  patchProject: vi.fn(), saveMessage: vi.fn().mockResolvedValue(undefined), saveTabs: vi.fn(),
  persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: ComponentProps<typeof import('../../src/components/ChatPane').ChatPane>) => {
    chatPaneSpy(props);
    return null;
  },
}));

const project: Project = {
  id: 'home-hydration', name: 'Home project', skillId: null, designSystemId: null,
  createdAt: 1, updatedAt: 1, pendingPrompt: 'Create a landing page',
};
const flagKey = `readable:auto-send-first:${project.id}`;
const attachmentsKey = `readable:auto-send-attachments:${project.id}`;
const queueKey = `readable:chat-queued-sends:${project.id}:v1`;
const attachments: ChatAttachment[] = [{ path: 'brief.pdf', name: 'brief.pdf', kind: 'file', size: 5 }];
const heldRun = {
  id: 'held-run', projectId: project.id, conversationId: 'home-conv', assistantMessageId: 'held-assistant',
  agentId: 'claude', status: 'running' as const, createdAt: 1, updatedAt: 1, exitCode: null, signal: null,
};
type Runs = Awaited<ReturnType<typeof listActiveChatRuns>>;
type ChatProps = ComponentProps<typeof import('../../src/components/ChatPane').ChatPane>;
const chatProps = () => chatPaneSpy.mock.calls.at(-1)![0] as ChatProps;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const onClearPendingPrompt = vi.fn();
function HomeProject({ initialProject = project, daemonLive = true }: { initialProject?: Project; daemonLive?: boolean }) {
  const [current, setCurrent] = useState(initialProject);
  return <ProjectView project={current} routeFileName={null}
    config={{ ...DEFAULT_CONFIG, mode: 'daemon', agentId: 'claude', agentModels: { claude: { model: 'sonnet' } },
      notifications: { successSoundId: 'success', failureSoundId: 'failure', soundEnabled: false, desktopEnabled: false } }}
    agents={[{ id: 'claude', name: 'Claude', bin: 'claude', available: true, models: [{ id: 'sonnet', label: 'Sonnet' }] }]}
    skills={[]} designTemplates={[]} designSystems={[]} daemonLive={daemonLive}
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()}
    onOpenSettings={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()}
    onClearPendingPrompt={() => {
      onClearPendingPrompt();
      setCurrent(value => ({ ...value, pendingPrompt: undefined }));
    }} />;
}

beforeEach(() => {
  vi.mocked(listConversations).mockResolvedValue([{ id: 'home-conv', projectId: project.id, title: null, createdAt: 1, updatedAt: 1 }]);
  vi.mocked(listMessages).mockResolvedValue([]);
  vi.mocked(listActiveChatRuns).mockResolvedValue([]);
  vi.mocked(fetchChatRunStatus).mockResolvedValue(heldRun);
  vi.mocked(streamViaDaemon).mockImplementation(async input => { input.onRunCreated?.('home-run'); });
  window.sessionStorage.setItem(flagKey, '1');
  window.sessionStorage.setItem(attachmentsKey, JSON.stringify(attachments));
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('Home first-turn run hydration', () => {
  it.each(['prompt', 'attachments', 'both'] as const)('retains %s until idle hydration and dispatches exactly once under StrictMode', async kind => {
    const hydration = deferred<Runs>();
    vi.mocked(listActiveChatRuns).mockReturnValue(hydration.promise);
    if (kind === 'prompt') window.sessionStorage.removeItem(attachmentsKey);
    const initialProject = kind === 'attachments' ? { ...project, pendingPrompt: undefined } : project;
    const element = <StrictMode><HomeProject initialProject={initialProject} /></StrictMode>;
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(element); });
    expect(listActiveChatRuns).toHaveBeenCalledWith(project.id, 'home-conv', { requireSuccess: true });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(flagKey)).toBe('1');
    if (kind !== 'prompt') expect(JSON.parse(window.sessionStorage.getItem(attachmentsKey)!)).toEqual(attachments);
    expect(chatProps().sendDisabled).toBe(true);
    expect(chatPaneSpy.mock.calls.every(([props]) => props.initialDraft === undefined)).toBe(true);

    await act(async () => { hydration.resolve([]); await hydration.promise; });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    expect(onClearPendingPrompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamViaDaemon).mock.calls[0]![0]).toMatchObject({
      attachments: kind === 'prompt' ? [] : ['brief.pdf'], sessionMode: 'design',
      history: [expect.objectContaining({ role: 'user', content: kind === 'attachments' ? '' : project.pendingPrompt })],
    });
    expect(window.sessionStorage.getItem(flagKey)).toBeNull();
    expect(window.sessionStorage.getItem(attachmentsKey)).toBeNull();
    expect(window.localStorage.getItem(queueKey)).toBeNull();
    await act(async () => { view.rerender(<StrictMode><HomeProject initialProject={initialProject} /></StrictMode>); });
    view.unmount();
    // Even a stale server seed with an empty message snapshot cannot replay a consumed flag.
    await act(async () => { render(element); });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'interrupt'] as const)('queues behind an authoritative %s run and promotes once', async outcome => {
    const hydration = deferred<Runs>();
    vi.mocked(listActiveChatRuns).mockReturnValue(hydration.promise);
    const completion = deferred<void>();
    let attached!: Parameters<typeof reattachDaemonRun>[0];
    vi.mocked(reattachDaemonRun).mockImplementation(input => { attached = input; return completion.promise; });
    await act(async () => { render(<HomeProject />); });
    await act(async () => { hydration.resolve([heldRun]); await hydration.promise; });
    expect(attached.runId).toBe(heldRun.id);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    const queued = JSON.parse(window.localStorage.getItem(queueKey)!);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ prompt: project.pendingPrompt, attachments, meta: { sessionMode: 'design' } });
    expect(onClearPendingPrompt).toHaveBeenCalledTimes(1);
    if (outcome === 'interrupt') {
      await act(async () => { chatProps().onSendQueuedNow!(queued[0].id); });
      expect(attached.cancelSignal?.aborted).toBe(true);
    } else {
      expect(streamViaDaemon).not.toHaveBeenCalled();
    }
    await act(async () => { attached.handlers.onDone('Finished'); completion.resolve(); await completion.promise; });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamViaDaemon).mock.calls[0]![0].history.at(-1)).toMatchObject({
      role: 'user', content: project.pendingPrompt, attachments,
    });
    expect(window.localStorage.getItem(queueKey)).toBeNull();
    expect(saveMessage).toHaveBeenCalledWith(project.id, 'home-conv', expect.objectContaining({ role: 'user', attachments, sessionMode: 'design' }), undefined);
  });

  it('retains the Home handoff on failed hydration and recovers on remount', async () => {
    const hydration = deferred<Runs>();
    vi.mocked(listActiveChatRuns).mockReturnValue(hydration.promise);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<HomeProject />); });
    await act(async () => { hydration.reject(new Error('Hydration unavailable')); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(flagKey)).toBe('1');
    expect(JSON.parse(window.sessionStorage.getItem(attachmentsKey)!)).toEqual(attachments);
    expect(chatProps().sendDisabled).toBe(true);
    expect(chatProps().error).toBe('Hydration unavailable');
    await act(async () => { view.rerender(<HomeProject />); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    view.unmount();
    vi.mocked(listActiveChatRuns).mockResolvedValue([]);
    await act(async () => { render(<HomeProject />); });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
  });

  it('ignores a canceled mount hydration response and sends only from the remounted view', async () => {
    const firstHydration = deferred<Runs>();
    const secondHydration = deferred<Runs>();
    vi.mocked(listActiveChatRuns).mockReturnValueOnce(firstHydration.promise).mockReturnValueOnce(secondHydration.promise);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<HomeProject />); });
    view.unmount();
    await act(async () => { render(<HomeProject />); });
    await act(async () => { firstHydration.resolve([]); await firstHydration.promise; });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    await act(async () => { secondHydration.resolve([]); await secondHydration.promise; });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
  });

  it('restores the accepted Home queue after remount without its consumed prompt or session flag', async () => {
    vi.mocked(listActiveChatRuns).mockResolvedValue([heldRun]);
    const completion = deferred<void>();
    vi.mocked(reattachDaemonRun).mockReturnValue(completion.promise);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<HomeProject />); });
    const queued = JSON.parse(window.localStorage.getItem(queueKey)!);
    expect(queued).toHaveLength(1);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(flagKey)).toBeNull();
    view.unmount();
    vi.mocked(listActiveChatRuns).mockResolvedValue([]);
    await act(async () => { render(<HomeProject initialProject={{ ...project, pendingPrompt: undefined }} />); });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamViaDaemon).mock.calls[0]![0].history.at(-1)).toMatchObject({ role: 'user', content: project.pendingPrompt, attachments });
    expect(window.localStorage.getItem(queueKey)).toBeNull();
  });

  it('does not treat an offline daemon as idle', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<HomeProject daemonLive={false} />); });
    expect(listActiveChatRuns).not.toHaveBeenCalled();
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<HomeProject daemonLive />); });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
  });

  it.each(['no-flag', 'empty', 'already-sent'] as const)('does not dispatch the %s negative control', async kind => {
    if (kind === 'no-flag') window.sessionStorage.removeItem(flagKey);
    if (kind === 'empty') window.sessionStorage.removeItem(attachmentsKey);
    if (kind === 'already-sent') vi.mocked(listMessages).mockResolvedValue([{ id: 'existing-user', role: 'user', content: project.pendingPrompt!, createdAt: 1 }]);
    await act(async () => { render(<StrictMode><HomeProject initialProject={kind === 'empty' ? { ...project, pendingPrompt: undefined } : project} /></StrictMode>); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(queueKey)).toBeNull();
  });
});
