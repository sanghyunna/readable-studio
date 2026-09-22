// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import { navigate } from '../../src/router';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  cacheTabsLocally,
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import { fetchPreviewComments, fetchProjectFiles } from '../../src/providers/registry';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (key: string) => key,
  }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    cacheTabsLocally: vi.fn((_projectId: string, state: { tabs: string[]; active: string | null }) => state),
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadMessagePage: async (projectId: string, conversationId: string) => ({ messages: await listMessages(projectId, conversationId), nextPosition: null }),
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    persistTabsToDaemonNow: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: ({ tabsState, onTabsStateChange, headerActions }: {
    tabsState: { tabs: string[]; active: string | null };
    onTabsStateChange: (state: { tabs: string[]; active: string | null }) => void;
    headerActions?: ReactNode;
  }) => (
    <div data-testid="file-workspace">
      <div data-testid="preview-header-actions">{headerActions}</div>
      <output data-testid="workspace-active-tab">{tabsState.active ?? ''}</output>
      <button
        type="button"
        data-testid="close-all-tabs"
        onClick={() => onTabsStateChange({ tabs: [], active: null })}
      >
        close all tabs
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

const chatSurface = vi.hoisted(() => ({ real: false }));
vi.mock('../../src/components/ChatPane', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/components/ChatPane')>();
  return { ChatPane: (props: ComponentProps<typeof actual.ChatPane>) => {
    if (chatSurface.real) return <actual.ChatPane {...props} />;
    const { agents, daemonLive, onModeChange, onAgentChange, onAgentModelChange, projectHeader } = props;
    return (
    <div data-testid="chat-pane">
      {projectHeader}
      <output data-testid="execution-wiring">
        {agents && daemonLive && onModeChange && onAgentChange && onAgentModelChange ? 'wired' : 'missing'}
      </output>
      <button type="button" onClick={() => onAgentModelChange?.('claude', { model: 'opus' })}>
        choose opus
      </button>
    </div>
    );
  } };
});

const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedCacheTabsLocally = vi.mocked(cacheTabsLocally);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedNavigate = vi.mocked(navigate);

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const conversation: Conversation = {
  id: 'conv-1',
  projectId: project.id,
  title: null,
  createdAt: 1,
  updatedAt: 1,
};

function renderProjectView(options: {
  project?: Project;
  agents?: AgentInfo[];
  onAgentModelChange?: (id: string, choice: { model?: string; reasoning?: string }) => void;
} = {}) {
  return render(
    <ProjectView
      project={options.project ?? project}
      routeFileName={null}
      config={config}
      agents={options.agents ?? []}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={options.onAgentModelChange ?? vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
    />,
  );
}

describe('ProjectView tab URL hydration', () => {
  beforeEach(() => {
    mockedListConversations.mockResolvedValue([conversation]);
    mockedCreateConversation.mockResolvedValue(conversation);
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    chatSurface.real = false;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('threads live execution wiring into the workspace ChatPane and model picks reach the app callback', async () => {
    const onAgentModelChange = vi.fn();
    renderProjectView({
      agents: [{ id: 'claude', name: 'Claude Code', bin: 'claude', available: true, models: [] }],
      onAgentModelChange,
    });

    expect((await screen.findByTestId('execution-wiring')).textContent).toBe('wired');
    fireEvent.click(screen.getByRole('button', { name: 'choose opus' }));
    expect(onAgentModelChange).toHaveBeenCalledWith('claude', { model: 'opus' });
  });

  it('hydrates the chat-header assumption ledger from persisted metadata without a form or preview-header Brief', async () => {
    chatSurface.real = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    await act(async () => { renderProjectView({
      project: {
        ...project,
        metadata: {
          kind: 'prototype',
          brief: {
            updatedAt: 10,
            assumptions: [
              { id: 'audience', label: 'Audience', value: 'security leaders', provenance: 'stated' },
            ],
          },
        } as Project['metadata'] & { brief: {
          updatedAt: number;
          assumptions: Array<{
            id: string;
            label: string;
            value: string;
            provenance: 'stated';
          }>;
        } },
      },
    }); });

    expect(mockedListMessages).toHaveBeenCalledWith(project.id, conversation.id);
    expect(screen.queryByTestId('questions-panel')).toBeNull();
    expect(screen.queryByTestId('questions-tab')).toBeNull();
    const trigger = screen.getByTestId('assumption-ledger-trigger');
    expect(trigger.closest('.chat-project-header')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog')).toBe(screen.getByTestId('assumption-ledger-menu'));
    const previewActions = screen.getByTestId('preview-header-actions');
    expect(previewActions.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.queryByTestId('brief-card')).toBeNull();
    expect(within(screen.getByTestId('assumption-ledger-menu')).getByRole('listitem').textContent).toContain('security leaders');
    expect(screen.getByTestId('assumption-ledger-influence').dataset).toMatchObject({ count: '1', confirmed: '1' });
  });

  it('syncs a persisted active tab to the URL before the file list has hydrated', async () => {
    renderProjectView();

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        // The active conversation id is threaded into the URL alongside
        // the active tab so a reload / share preserves the conversation
        // segment of `/projects/:id/conversations/:cid/files/...`
        // (PerishCode + Codex P1 on PR #1508).
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });

  it('re-pushes /conversations/:cid when activeConversationId hydrates after the active tab has already synced (lefarcen P1 on PR #1508)', async () => {
    // Race shape: `loadTabs` resolves and sets the active tab BEFORE
    // `listConversations` resolves and sets `activeConversationId`.
    // The first navigate fires with `conversationId: null` because
    // the conversation hasn't loaded yet; the second navigate must
    // fire with `conversationId: 'conv-1'` even though the active
    // tab is identical. A ref guard that keys only on the file
    // target skips the second call and the URL never gains the
    // `/conversations/:cid` segment. The composite-key guard
    // (`${activeConversationId}:${target}`) catches it.
    let resolveConversations: (value: Conversation[]) => void = () => {};
    const conversationsPromise = new Promise<Conversation[]>((resolve) => {
      resolveConversations = resolve;
    });
    mockedListConversations.mockReturnValue(conversationsPromise);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });

    renderProjectView();

    // First navigate: active tab synced, conversation still loading.
    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: null,
          fileName: 'index.html',
        },
        { replace: true },
      );
    });

    // Now resolve the conversation list. The active tab is unchanged
    // but `activeConversationId` flips from `null` to `'conv-1'`, so
    // a second navigate must fire.
    resolveConversations([conversation]);

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });

  it('does not reopen the primary file after the user closes the last tab', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    mockedFetchProjectFiles.mockResolvedValue([
      {
        name: 'index.html',
        path: 'index.html',
        type: 'file',
        size: 1,
        mtime: 1,
        mime: 'text/html',
        kind: 'html',
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'html',
          title: 'Index',
          entry: 'index.html',
          renderer: 'html',
          primary: true,
          exports: ['html'],
        },
      },
    ]);

    renderProjectView();

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe('index.html'));
    // Tab state persists synchronously through cacheTabsLocally (the daemon PUT
    // is debounced via persistTabsToDaemonNow); assert on the synchronous cache
    // write so the test stays deterministic without driving the debounce timer.
    expect(mockedCacheTabsLocally).toHaveBeenCalledWith(project.id, { tabs: ['index.html'], active: 'index.html' });

    fireEvent.click(screen.getByTestId('close-all-tabs'));

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe(''));
    await waitFor(() => {
      expect(mockedCacheTabsLocally.mock.calls.at(-1)).toEqual([project.id, { tabs: [], active: null }]);
    });
    // Exactly two writes — the initial primary open and the close-all — proving
    // the primary file is not silently reopened after the last tab closes.
    expect(mockedCacheTabsLocally).toHaveBeenCalledTimes(2);
  });

  it('does not auto-open the primary file when saved tabs were explicitly empty', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null, hasSavedState: true });
    mockedFetchProjectFiles.mockResolvedValue([
      {
        name: 'index.html',
        path: 'index.html',
        type: 'file',
        size: 1,
        mtime: 1,
        mime: 'text/html',
        kind: 'html',
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'html',
          title: 'Index',
          entry: 'index.html',
          renderer: 'html',
          primary: true,
          exports: ['html'],
        },
      },
    ]);

    renderProjectView();

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe(''));
    expect(mockedCacheTabsLocally).not.toHaveBeenCalled();
  });
});
