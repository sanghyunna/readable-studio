// @vitest-environment jsdom

/**
 * A failed Kimi run carries the daemon's English provider message. The chat
 * error box shows Korean guidance instead, while the copyable diagnostics keep
 * the raw English text.
 */

import { cleanup, render } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getKo } from '../../src/i18n/locales/ko';
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

function renderFailed(code: string, detail: string, agentId = 'kimi') {
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

describe('ChatPane Kimi provider failures', () => {
  it('shows Korean usage-limit guidance', () => {
    const card = renderFailed(
      'RATE_LIMITED',
      'The Kimi account usage limit is reached (HTTP 403). It resets when the current 7-day window ends. Retry after the limit resets.',
    );
    expect(card?.textContent).toContain('Kimi 계정의 사용량 한도에 도달했습니다.');
    expect(card?.textContent).toContain('7일');
    expect(card?.textContent).not.toContain('usage limit is reached');
  });

  it('shows Korean login guidance', () => {
    const card = renderFailed(
      'AGENT_AUTH_REQUIRED',
      'Kimi login failed (HTTP 401). Log in to Kimi again and retry.',
    );
    expect(card?.textContent).toContain(
      'Kimi 로그인이 필요합니다. 터미널에서 Kimi에 다시 로그인한 뒤 다시 시도하세요.',
    );
    expect(card?.textContent).not.toContain('login failed');
  });

  it('shows a Korean provider error with status and short reason', () => {
    const card = renderFailed(
      'AGENT_EXECUTION_FAILED',
      'Kimi provider error (HTTP 502): bad gateway.',
    );
    expect(card?.textContent).toContain('Kimi 서비스 오류(HTTP 502): bad gateway');
    expect(card?.textContent).not.toContain('provider error');
  });
});


it('renders a failed Databricks empty response in the Korean error box', () => {
  const card = renderFailed('AGENT_EXECUTION_FAILED', 'Agent completed without producing any output. The model or provider may have returned an empty response — check the agent logs for upstream errors.', 'databricks');
  expect(card).not.toBeNull();

  expect(card?.textContent).toContain(getKo()['chat.databricksError.responseMessage']);
});

it('renders an exhausted HTTP 400 in the Korean error box', () => {
  const card = renderFailed('AGENT_EXECUTION_FAILED', 'Databricks [bad-request; HTTP 400]: request rejected', 'databricks');
  expect(card?.textContent).toContain(getKo()['chat.databricksError.providerMessage'].replace('{status}', '400'));
});
