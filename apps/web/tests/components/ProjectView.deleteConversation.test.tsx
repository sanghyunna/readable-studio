// @vitest-environment jsdom

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useHubRailController } from '../../src/components/hub/useHubRailController';
import type { Project } from '../../src/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';

const listConversations = vi.fn();
const readConversations = vi.fn();
const listMessages = vi.fn();
const fetchPreviewComments = vi.fn();
const loadTabs = vi.fn();
const fetchProjectFiles = vi.fn();
const fetchLiveArtifacts = vi.fn();
const fetchSkill = vi.fn();
const fetchDesignSystem = vi.fn();
const getTemplate = vi.fn();
const fetchChatRunStatus = vi.fn();
const listActiveChatRuns = vi.fn();
const listProjectRuns = vi.fn();
const reattachDaemonRun = vi.fn();
const deleteConversation = vi.fn();
const createConversation = vi.fn();
const patchConversation = vi.fn();
const patchProject = vi.fn();
const saveMessage = vi.fn();
const saveTabs = vi.fn();
const navigate = vi.fn();

// Capture the props ChatPane receives so the test can drive
// `onDeleteConversation` directly — ChatPane itself is mocked to a
// no-op renderer (the real component pulls in markdown + chat
// streaming machinery that isn't relevant to the projects-refresh
// regression we want to pin).
const chatPaneProps: {
  onDeleteConversation?: (id: string) => Promise<void> | void;
  activeConversationId?: string | null;
  conversations?: Array<{ id: string; title?: string | null }>;
  messages?: Array<{ id: string; content?: string }>;
  onForkFromMessage?: (message: { id: string; content: string; role: 'assistant' }) => void;
} = {};

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (value: string) => value,
  }),
  useT: () => ((value: string) => value),
}));

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: (...args: unknown[]) => fetchChatRunStatus(...args),
  listActiveChatRuns: (...args: unknown[]) => listActiveChatRuns(...args),
  listProjectRuns: (...args: unknown[]) => listProjectRuns(...args),
  reattachDaemonRun: (...args: unknown[]) => reattachDaemonRun(...args),
  streamViaDaemon: vi.fn(),
  RUNS_CHANGED_EVENT: 'readable-studio:runs-changed',
}));

vi.mock('../../src/providers/registry', () => ({
  deletePreviewComment: vi.fn(),
  fetchPreviewComments: (...args: unknown[]) => fetchPreviewComments(...args),
  fetchDesignSystem: (...args: unknown[]) => fetchDesignSystem(...args),
  fetchLiveArtifacts: (...args: unknown[]) => fetchLiveArtifacts(...args),
  fetchProjectFiles: (...args: unknown[]) => fetchProjectFiles(...args),
  fetchSkill: (...args: unknown[]) => fetchSkill(...args),
  patchPreviewCommentStatus: vi.fn(),
  upsertPreviewComment: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock('../../src/router', () => ({
  navigate: (...args: unknown[]) => navigate(...args),
}));

vi.mock('../../src/state/projects', () => ({
  createConversation: (...args: unknown[]) => createConversation(...args),
  deleteConversation: (...args: unknown[]) => deleteConversation(...args),
  getTemplate: (...args: unknown[]) => getTemplate(...args),
  listConversations: (...args: unknown[]) => listConversations(...args),
  readConversations: (...args: unknown[]) => readConversations(...args),
  listMessages: (...args: unknown[]) => listMessages(...args),
  loadMessagePage: async (projectId: string, conversationId: string) => ({ messages: await listMessages(projectId, conversationId), nextPosition: null }),
  loadTabs: (...args: unknown[]) => loadTabs(...args),
  patchConversation: (...args: unknown[]) => patchConversation(...args),
  patchProject: (...args: unknown[]) => patchProject(...args),
  saveMessage: (...args: unknown[]) => saveMessage(...args),
  saveTabs: (...args: unknown[]) => saveTabs(...args),
}));

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: () => null,
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: {
    onDeleteConversation?: (id: string) => Promise<void> | void;
    activeConversationId?: string | null;
    conversations?: Array<{ id: string; title?: string | null }>;
    messages?: Array<{ id: string; content?: string }>;
    onForkFromMessage?: (message: { id: string; content: string; role: 'assistant' }) => void;
  }) => {
    chatPaneProps.onDeleteConversation = props.onDeleteConversation;
    chatPaneProps.activeConversationId = props.activeConversationId;
    chatPaneProps.conversations = props.conversations;
    chatPaneProps.messages = props.messages;
    chatPaneProps.onForkFromMessage = props.onForkFromMessage;
    return null;
  },
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: () => null,
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => null,
}));

function renderProjectView(onProjectsRefresh: () => void, routeConversationId: string | null = null) {
  return render(
    <ProjectView
      project={{ id: 'project-1', name: 'Project', skillId: null, designSystemId: null } as never}
      routeFileName={null}
      routeConversationId={routeConversationId}
      config={{ mode: 'daemon', agentId: 'agent-1', notifications: undefined, agentModels: {} } as never}
      agents={[{ id: 'agent-1', name: 'OpenCode', models: [] } as never]}
      skills={[]}
      designTemplates={[]}
      designSystems={[]}
      daemonLive
      onModeChange={() => {}}
      onAgentChange={() => {}}
      onAgentModelChange={() => {}}
      onRefreshAgents={() => {}}
      onOpenSettings={() => {}}
      onBack={() => {}}
      onClearPendingPrompt={() => {}}
      onTouchProject={() => {}}
      onProjectChange={() => {}}
      onProjectsRefresh={onProjectsRefresh}
    />,
  );
}

describe('ProjectView conversation delete', () => {
  beforeEach(() => {
    listProjectRuns.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    chatPaneProps.onDeleteConversation = undefined;
    chatPaneProps.activeConversationId = undefined;
    chatPaneProps.conversations = undefined;
    chatPaneProps.messages = undefined;
    chatPaneProps.onForkFromMessage = undefined;
  });

  // Issue #1202: the home `Needs input` badge is rendered from the
  // cached `/api/projects` payload (App.tsx owns the `projects` state).
  // Deleting a conversation that owned an unanswered question-form
  // flips the daemon-side flag, but without calling onProjectsRefresh
  // here the home view keeps the stale flag until the next manual
  // reload. All the other state-changing branches in ProjectView
  // already call onProjectsRefresh (run end, live artifact events,
  // etc.) — this pins that the delete-conversation branch joins them.
  it.each(['fork', 'original'] as const)('keeps the sibling in the rail when deleting the %s after forking the last message', async (deletedSide) => {
    // Given: the workspace and the rail initially share the original conversation.
    const original = { id: 'original', projectId: 'project-1', title: 'Original', createdAt: 1, updatedAt: 1 };
    const fork = { ...original, id: 'fork', title: 'Original fork', updatedAt: 2 };
    const message = { id: 'last-message', role: 'assistant' as const, content: 'Last response' };
    let stored = [original];
    listConversations.mockImplementation(async () => stored);
    listMessages.mockResolvedValue([message]);
    readConversations.mockImplementation(async () => ({ ok: true, conversations: stored }));
    createConversation.mockImplementation(async () => { stored = [fork, original]; return fork; });
    deleteConversation.mockImplementation(async (_projectId: string, id: string) => {
      stored = stored.filter((row) => row.id !== id);
      return true;
    });
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    const railProject: Project = { id: 'project-1', name: 'Project', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 };
    const { result: rail, rerender } = renderHook(({ currentSessionId }: { currentSessionId: string }) =>
      useHubRailController({ projects: [railProject], currentSessionId, onOpenSession: vi.fn(), onNewProject: vi.fn() }),
      { initialProps: { currentSessionId: 'original' } },
    );
    renderProjectView(vi.fn(), 'original');
    await waitFor(() => expect(rail.current.allNodes[0]?.sessions.map((row) => row.id)).toEqual(['original']));
    await waitFor(() => expect(chatPaneProps.onForkFromMessage).toBeDefined());
    await waitFor(() => expect(chatPaneProps.messages?.some((row) => row.id === message.id)).toBe(true));

    // When: Fork is invoked on the last message, before any remount or reload.
    await act(async () => { chatPaneProps.onForkFromMessage?.(message); });
    await waitFor(() => expect(createConversation).toHaveBeenCalled());
    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('fork'));
    rerender({ currentSessionId: 'fork' });
    await waitFor(() => expect(rail.current.allNodes[0]?.sessions.map((row) => row.id)).toEqual(['fork', 'original']));
    expect(rail.current.currentSessionId).toBe('fork');
    expect(createConversation).toHaveBeenCalledWith('project-1', expect.anything(), expect.objectContaining({
      seedFromConversationId: 'original', forkAfterMessageId: message.id, seedMessages: [message],
    }));

    // Then: the actual rail action removes only the selected id; the sibling survives.
    const victim = rail.current.allNodes[0]?.sessions.find((row) => row.id === deletedSide);
    if (!victim) throw new Error('Fixture victim absent from rail');
    act(() => rail.current.deleteSession(victim));
    await act(async () => { rail.current.commitPendingSessionDeletion(); });
    const survivor = deletedSide === 'fork' ? 'original' : 'fork';
    expect(deleteConversation).toHaveBeenCalledExactlyOnceWith('project-1', deletedSide);
    expect(rail.current.allNodes[0]?.sessions.map((row) => row.id)).toEqual([survivor]);
  });

  it('triggers onProjectsRefresh after deleting a conversation', async () => {
    listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'Conversation 1' },
      { id: 'conv-2', title: 'Conversation 2' },
    ]);
    listMessages.mockResolvedValue([]);
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    deleteConversation.mockResolvedValue(true);

    const onProjectsRefresh = vi.fn();

    renderProjectView(onProjectsRefresh);

    // ChatPane mount is async (ProjectView loads conversations in an
    // effect, then renders chat). Wait for the mocked ChatPane to
    // surface its `onDeleteConversation` prop.
    await waitFor(() => expect(chatPaneProps.onDeleteConversation).toBeDefined());

    await act(async () => {
      await chatPaneProps.onDeleteConversation!('conv-1');
    });

    expect(deleteConversation).toHaveBeenCalledWith('project-1', 'conv-1');
    expect(onProjectsRefresh).toHaveBeenCalledTimes(1);
  });

  // Defensive complement: if the daemon delete fails, we must not
  // pretend it succeeded — onProjectsRefresh would feed the home view
  // a "deleted" state that isn't actually true on disk, putting the
  // cache MORE out of sync than the bug we're fixing.
  it('does not trigger onProjectsRefresh when the delete request fails', async () => {
    listConversations.mockResolvedValue([{ id: 'conv-1', title: 'Conversation 1' }]);
    listMessages.mockResolvedValue([]);
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    deleteConversation.mockResolvedValue(false);

    const onProjectsRefresh = vi.fn();

    renderProjectView(onProjectsRefresh);

    await waitFor(() => expect(chatPaneProps.onDeleteConversation).toBeDefined());

    await act(async () => {
      await chatPaneProps.onDeleteConversation!('conv-1');
    });

    expect(deleteConversation).toHaveBeenCalledWith('project-1', 'conv-1');
    expect(onProjectsRefresh).not.toHaveBeenCalled();
  });

  it('switches the active conversation to the next available history item after deleting the current one', async () => {
    listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'Conversation 1' },
      { id: 'conv-2', title: 'Conversation 2' },
    ]);
    listMessages.mockResolvedValue([]);
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    deleteConversation.mockResolvedValue(true);

    renderProjectView(vi.fn());

    await waitFor(() => expect(chatPaneProps.onDeleteConversation).toBeDefined());
    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await chatPaneProps.onDeleteConversation!('conv-1');
    });

    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('conv-2'));
    expect(chatPaneProps.conversations?.map((conversation) => conversation.id)).toEqual(['conv-2']);
  });

  it('clears the deleted active conversation and renders the routed fallback messages', async () => {
    listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'Conversation 1' },
      { id: 'conv-2', title: 'Conversation 2' },
    ]);
    listMessages.mockImplementation((_projectId: string, conversationId: string) =>
      Promise.resolve(conversationId === 'conv-1'
        ? [{ id: 'deleted-message', role: 'user', content: 'Deleted conversation content' }]
        : [{ id: 'fallback-message', role: 'user', content: 'Fallback conversation content' }]),
    );
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    deleteConversation.mockResolvedValue(true);

    renderProjectView(vi.fn(), 'conv-1');

    await waitFor(() => expect(chatPaneProps.messages?.[0]?.id).toBe('deleted-message'));
    await act(async () => {
      await chatPaneProps.onDeleteConversation!('conv-1');
    });

    expect(navigate).toHaveBeenCalledWith(
      {
        kind: 'project',
        projectId: 'project-1',
        conversationId: 'conv-2',
        fileName: null,
      },
      { replace: true },
    );
    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('conv-2'));
    await waitFor(() => expect(chatPaneProps.messages?.[0]?.id).toBe('fallback-message'));
    expect(chatPaneProps.messages?.some((message) => message.id === 'deleted-message')).toBe(false);
  });

  it('re-seeds a fresh conversation when deleting the last remaining history item', async () => {
    listConversations.mockResolvedValue([{ id: 'conv-1', title: 'Conversation 1' }]);
    listMessages.mockResolvedValue([]);
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    fetchChatRunStatus.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    reattachDaemonRun.mockResolvedValue(undefined);
    deleteConversation.mockResolvedValue(true);
    createConversation.mockResolvedValue({ id: 'conv-fresh', title: 'Fresh conversation' });

    renderProjectView(vi.fn());

    await waitFor(() => expect(chatPaneProps.onDeleteConversation).toBeDefined());
    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await chatPaneProps.onDeleteConversation!('conv-1');
    });

    await waitFor(() => expect(createConversation).toHaveBeenCalledWith('project-1'));
    await waitFor(() => expect(chatPaneProps.activeConversationId).toBe('conv-fresh'));
    expect(chatPaneProps.conversations?.map((conversation) => conversation.id)).toEqual(['conv-fresh']);
  });
});
