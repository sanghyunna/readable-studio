// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { ActiveConversationChatState } from '../../src/components/workspace/SideChatTab';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, ChatMessage, Conversation, OpenTabsState, ProjectFile } from '../../src/types';

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  fetchProjectFolders: vi.fn().mockResolvedValue([]),
  fetchProjectDeployments: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listMessages: vi.fn().mockResolvedValue([]),
  saveMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/components/ChatComposer', () => ({ ChatComposer: forwardRef(() => null) }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as never;
});
afterEach(() => cleanup());

const tabsState: OpenTabsState = { tabs: ['chat:c'], active: 'chat:c' };
const files: ProjectFile[] = [];
const conversations: Conversation[] = [{ id: 'c', projectId: 'p', title: 'Primary', createdAt: 1, updatedAt: 1 }];
const chatConfig = { ...DEFAULT_CONFIG, mode: 'daemon' as const };
const chatAgentsById = new Map<string, AgentInfo>();
const onRefreshFiles = vi.fn();
const onTabsStateChange = vi.fn();

function chatState(reply: string, streaming: boolean): ActiveConversationChatState {
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'Build it' },
    { id: 'a', role: 'assistant', content: reply, events: [{ kind: 'text', text: reply }], runStatus: streaming ? 'running' : 'succeeded' },
  ];
  return { conversationId: 'c', messages, streaming, error: null, onSend: vi.fn(), onStop: vi.fn() };
}

function workspace(chat: ActiveConversationChatState) {
  return (
    <FileWorkspace projectId="p" projectKind="prototype" isDeck={false} files={files} onRefreshFiles={onRefreshFiles}
      tabsState={tabsState} onTabsStateChange={onTabsStateChange} chatConfig={chatConfig} chatAgentsById={chatAgentsById}
      chatLocale="en" conversations={conversations} activeConversationId="c" activeConversationChat={chat} />
  );
}

describe('FileWorkspace side chat mirroring the primary conversation', () => {
  it('shows every streamed update of the active conversation while all other props stay the same', async () => {
    const view = render(workspace(chatState('Partial', true)));
    await act(async () => { await Promise.resolve(); });
    const tab = screen.getByTestId('side-chat-tab');
    expect(tab.textContent).toContain('Partial');

    view.rerender(workspace(chatState('Partial reply grows', true)));
    expect(screen.getByTestId('side-chat-tab').textContent).toContain('Partial reply grows');

    view.rerender(workspace(chatState('Partial reply grows and ends.', false)));
    expect(screen.getByTestId('side-chat-tab').textContent).toContain('Partial reply grows and ends.');
  });
});
