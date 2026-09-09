// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn().mockResolvedValue([]),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});
vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/Loading', () => ({ CenteredLoader: () => <div>loading</div> }));
vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-pane-rendered">
      <output data-testid="chat-pane-messages">{messages.map((message) => message.content).join('\n')}</output>
      <output data-testid="chat-pane-produced-count">
        {messages.reduce((count, message) => count + (message.producedFiles?.length ?? 0), 0)}
      </output>
    </div>
  ),
}));
vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="file-workspace-rendered">
      <output data-testid="file-workspace-messages">{messages.map((message) => message.content).join('\n')}</output>
      <output data-testid="file-workspace-produced-count">
        {messages.reduce((count, message) => count + (message.producedFiles?.length ?? 0), 0)}
      </output>
    </div>
  ),
}));

import { AssistantMessage } from '../../src/components/AssistantMessage';
import {
  ProjectView,
  briefReceiptMessageForDisplay,
  parseBriefReceipt,
  stripBriefReceiptsForDisplay,
} from '../../src/components/ProjectView';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  ChatMessage,
  Conversation,
  DesignSystemSummary,
  Project,
  ProjectFile,
  SkillSummary,
} from '../../src/types';
import { fetchProjectFiles } from '../../src/providers/registry';
import { createConversation, listConversations, listMessages } from '../../src/state/projects';

const receipt = `<brief-receipt>
{
  "assumptions": [
    { "id": "output", "label": "Output", "value": "Slide deck (논문 요약)", "provenance": "stated" },
    { "id": "audience", "label": "Audience", "value": "Research leaders", "provenance": "inferred" }
  ]
}
</brief-receipt>`;

function assistant(content: string, chunks: string[] = [content]): ChatMessage {
  return {
    id: 'brief-message',
    role: 'assistant',
    content,
    runStatus: 'running',
    events: chunks.map(text => ({ kind: 'text', text }) as AgentEvent),
  } as ChatMessage;
}

function renderMessage(message: ChatMessage, streaming = false) {
  return render(
    <AssistantMessage message={message} streaming={streaming} isLast projectId="project-brief" />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('brief receipt display boundary', () => {
  it('suppresses persisted receipt protocol at both ProjectView message boundaries', async () => {
    const project: Project = {
      id: 'project-brief',
      name: 'Brief project',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const conversation: Conversation = {
      id: 'conversation-brief',
      projectId: project.id,
      title: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const persisted = assistant(`Before receipt.\n${receipt}\nAfter receipt.`);
    vi.mocked(listConversations).mockResolvedValue([conversation]);
    vi.mocked(createConversation).mockResolvedValue(conversation);
    let deliverMessages!: (messages: ChatMessage[]) => void;
    const messageResponse = new Promise<ChatMessage[]>((resolve) => { deliverMessages = resolve; });
    vi.mocked(listMessages).mockReturnValue(messageResponse);
    const config: AppConfig = {
      mode: 'api', apiKey: '', baseUrl: '', model: '', agentId: null,
      skillId: null, designSystemId: null,
    };

    await act(async () => render(
      <ProjectView
        project={project}
        routeFileName={null}
        config={config}
        agents={[] as AgentInfo[]}
        skills={[] as SkillSummary[]}
        designTemplates={[] as SkillSummary[]}
        designSystems={[] as DesignSystemSummary[]}
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onRefreshAgents={vi.fn()}
        onOpenSettings={vi.fn()}
        onBack={vi.fn()}
        onClearPendingPrompt={vi.fn()}
        onTouchProject={vi.fn()}
        onProjectChange={vi.fn()}
        onProjectsRefresh={vi.fn()}
      />,
    ));

    expect(listMessages).toHaveBeenCalledWith(project.id, conversation.id);
    await act(async () => {
      deliverMessages([persisted]);
      await messageResponse;
    });
    for (const boundary of ['chat-pane-messages', 'file-workspace-messages']) {
      const content = screen.getByTestId(boundary).textContent ?? '';
      expect(content).toContain('Before receipt.');
      expect(content).toContain('After receipt.');
      expect(content).not.toContain('brief-receipt');
      expect(content).not.toContain('Slide deck (논문 요약)');
      expect(content).not.toContain('"assumptions"');
    }
  });

  it('keeps both workspace surfaces rendered when persisted producedFiles contains a filename string', async () => {
    const malformedProducedFiles: unknown[] = ['index.html'];
    expect((malformedProducedFiles[0] as { name?: unknown }).name).toBeUndefined();
    const project: Project = {
      id: 'project-malformed-produced-file',
      name: 'Malformed produced file project',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const conversation: Conversation = {
      id: 'conversation-malformed-produced-file',
      projectId: project.id,
      title: null,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(listConversations).mockResolvedValue([conversation]);
    vi.mocked(createConversation).mockResolvedValue(conversation);
    const persisted: ChatMessage = {
      ...assistant('The workspace remains available.'),
      runStatus: 'succeeded',
      producedFiles: malformedProducedFiles as ProjectFile[],
    };
    let deliverMessages!: (messages: ChatMessage[]) => void;
    const messageResponse = new Promise<ChatMessage[]>((resolve) => { deliverMessages = resolve; });
    vi.mocked(listMessages).mockReturnValue(messageResponse);
    vi.mocked(fetchProjectFiles).mockResolvedValueOnce([{
      name: 'index.html',
      path: 'index.html',
      size: 128,
      mtime: 2,
      kind: 'html',
      mime: 'text/html',
    }]);
    const config: AppConfig = {
      mode: 'api', apiKey: '', baseUrl: '', model: '', agentId: null,
      skillId: null, designSystemId: null,
    };

    await act(async () => render(
      <ProjectView
        project={project}
        routeFileName={null}
        config={config}
        agents={[] as AgentInfo[]}
        skills={[] as SkillSummary[]}
        designTemplates={[] as SkillSummary[]}
        designSystems={[] as DesignSystemSummary[]}
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onRefreshAgents={vi.fn()}
        onOpenSettings={vi.fn()}
        onBack={vi.fn()}
        onClearPendingPrompt={vi.fn()}
        onTouchProject={vi.fn()}
        onProjectChange={vi.fn()}
        onProjectsRefresh={vi.fn()}
      />,
    ));

    expect(listMessages).toHaveBeenCalledWith(project.id, conversation.id);
    expect(screen.getByTestId('chat-pane-rendered')).toBeTruthy();
    expect(screen.getByTestId('file-workspace-rendered')).toBeTruthy();
    // The surfaces mount after conversations load, before their messages arrive.
    // Deliver the exact pending response inside act, not a shell-presence wait.
    expect(screen.getByTestId('chat-pane-messages').textContent).toBe('');
    expect(screen.getByTestId('file-workspace-messages').textContent).toBe('');
    await act(async () => {
      deliverMessages([persisted]);
      await messageResponse;
    });
    expect(screen.getByTestId('chat-pane-messages').textContent).toContain('workspace remains available');
    expect(screen.getByTestId('file-workspace-messages').textContent).toContain('workspace remains available');
    expect(screen.getByTestId('chat-pane-produced-count').textContent).toBe('1');
    expect(screen.getByTestId('file-workspace-produced-count').textContent).toBe('1');
  });

  it('proves the fixture leaks without consumption, then hides a complete receipt and its JSON', () => {
    const raw = assistant(`I’ll start with the deck.\n\n${receipt}\n\nBuilding the outline now.`);

    renderMessage(raw);
    // Non-vacuousness: this exact fixture reaches visible chat prose without the boundary.
    expect(screen.getByText(/brief-receipt/)).toBeTruthy();
    expect(screen.getByText(/Slide deck \(논문 요약\)/)).toBeTruthy();
    cleanup();

    renderMessage(briefReceiptMessageForDisplay(raw));
    expect(screen.getByText(/I’ll start with the deck/)).toBeTruthy();
    expect(screen.getByText(/Building the outline now/)).toBeTruthy();
    expect(screen.queryByText(/brief-receipt/)).toBeNull();
    expect(screen.queryByText(/Slide deck \(논문 요약\)/)).toBeNull();
    cleanup();

    const assumptions = parseBriefReceipt(raw.content);
    expect(assumptions).toHaveLength(2);
    render(
      <QuestionsPanel
        brief={{ assumptions: assumptions!, updatedAt: 1 }}
        form={null} interactive={false} generating={false}
        onCorrect={async () => true} onSubmit={() => {}}
      />,
    );
    const stated = screen.getAllByRole('listitem', { hidden: true })
      .find((item) => item.getAttribute('data-provenance') === 'stated');
    expect(stated?.textContent).toContain('Slide deck (논문 요약)');
  });

  it('never flashes an opening tag split across streaming text events', () => {
    const partial = assistant(
      'Starting now.\n\n<brief-receipt>\n{ "assumptions": [{ "id": "output"',
      ['Starting now.\n\n<br', 'ief-receipt>\n{ "assumptions": [', '{ "id": "output"'],
    );
    renderMessage(briefReceiptMessageForDisplay(partial), true);

    expect(screen.getByText('Starting now.')).toBeTruthy();
    expect(screen.queryByText(/brief|assumptions|output/i)).toBeNull();
    expect(stripBriefReceiptsForDisplay('Starting now.\n<br')).toBe('Starting now.\n');
  });

  it('drops malformed protocol data while preserving surrounding prose', () => {
    const malformed = assistant(
      'Starting now.\n<brief-receipt>{ definitely not JSON ] }</brief-receipt>\nI created the first pass.',
    );
    renderMessage(briefReceiptMessageForDisplay(malformed));

    expect(screen.getByText(/Starting now/)).toBeTruthy();
    expect(screen.getByText(/I created the first pass/)).toBeTruthy();
    expect(screen.queryByText(/definitely not JSON|brief-receipt/)).toBeNull();
  });
});
