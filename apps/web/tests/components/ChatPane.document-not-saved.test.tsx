// @vitest-environment jsdom

/**
 * A document run that ended without index.html carries the daemon's English
 * message under the DOCUMENT_NOT_SAVED code. The chat error box shows the
 * Korean copy instead of the raw English text.
 */

import { cleanup, render } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import type { AppConfig, ChatMessage } from '../../src/types';

vi.mock('../../src/i18n', async () => {
  const { getKo } = await import('../../src/i18n/locales/ko');
  const ko = getKo() as unknown as Record<string, string>;
  return {
    useT: () => (key: string, vars?: Record<string, string | number>) =>
      (ko[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? '')),
  };
});

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid={`assistant-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return { ...actual, trackChatPanelClick: vi.fn(), trackRunFailedToastSurfaceView: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderFailed(code: string, detail: string, agentId = 'claude') {
  const message = {
    id: 'msg-failed',
    role: 'assistant',
    content: '',
    createdAt: 1,
    runId: 'run-failed',
    runStatus: 'failed',
    agentId,
    events: [{ kind: 'status', label: 'error', detail, code }],
  } as ChatMessage;
  render(
    <ChatPane
      messages={[message]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId, agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
  return document.querySelector('.msg.error');
}

describe('ChatPane missing document failures', () => {
  it('shows the Korean not-saved message for DOCUMENT_NOT_SAVED', () => {
    const card = renderFailed(
      'DOCUMENT_NOT_SAVED',
      'Document generation completed without saving index.html in the project root.',
    );
    expect(card?.textContent).toContain(
      '문서 파일(index.html)이 저장되지 않아 생성을 완료하지 못했습니다. 다시 시도해 주세요.',
    );
    expect(card?.textContent).not.toContain('Document generation completed');
  });
});
