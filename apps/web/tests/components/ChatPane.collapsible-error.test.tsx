// @vitest-environment jsdom

/**
 * The run-failure card truncates a long provider error behind a disclosure
 * toggle. This is presentation only: the recovery actions (Continue / Retry /
 * copy diagnostics) must stay mounted and functional in BOTH states.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import { ERROR_PREVIEW_CHAR_BUDGET } from '../../src/components/CollapsibleErrorText';
import type { AppConfig, ChatMessage } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (vars && Object.keys(vars).length > 0) {
      return `${key} ${Object.values(vars).join(' ')}`;
    }
    return key;
  },
}));

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
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
    trackRunFailedToastSurfaceView: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LONG_DETAIL = `API Error: 500 ${'z'.repeat(ERROR_PREVIEW_CHAR_BUDGET)} TAIL_MARKER`;

function failedMessage(detail: string): ChatMessage {
  return {
    id: 'msg-failed',
    role: 'assistant',
    content: 'Partial work.',
    createdAt: 1,
    runId: 'run-failed',
    runStatus: 'failed',
    resumable: true,
    agentId: 'claude',
    events: [{ kind: 'status', label: 'error', detail }],
  } as ChatMessage;
}

function renderChat(detail: string) {
  const onResumeRun = vi.fn();
  render(
    <ChatPane
      messages={[failedMessage(detail)]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onResumeRun={onResumeRun}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'claude', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
  return { onResumeRun };
}

function errorToggle(): HTMLElement {
  const card = document.querySelector('.msg.error');
  if (!card) throw new Error('missing run-failure error card');
  const toggle = card.querySelector('button[aria-expanded]');
  if (!toggle) throw new Error('missing error disclosure toggle');
  return toggle as HTMLElement;
}

describe('ChatPane run-failure error card truncation', () => {
  it('collapses a long provider error and keeps recovery actions usable', () => {
    const { onResumeRun } = renderChat(LONG_DETAIL);

    const toggle = errorToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('API Error: 500');
    expect(toggle.textContent).not.toContain('TAIL_MARKER');

    // Recovery action present while collapsed.
    const resume = screen.getByText('chat.resumeRunCta');
    expect(screen.getByLabelText('chat.copyErrorDiagnostic')).toBeTruthy();

    fireEvent.click(resume);
    expect(onResumeRun).toHaveBeenCalledTimes(1);
  });

  it('reveals the full error on expand while recovery actions stay functional', () => {
    const { onResumeRun } = renderChat(LONG_DETAIL);

    const toggle = errorToggle();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body?.textContent).toContain('TAIL_MARKER');
    expect(body?.getAttribute('data-expanded')).toBe('true');

    expect(screen.getByLabelText('chat.copyErrorDiagnostic')).toBeTruthy();
    fireEvent.click(screen.getByText('chat.resumeRunCta'));
    expect(onResumeRun).toHaveBeenCalledTimes(1);
  });

  it('leaves a short error untruncated with no toggle', () => {
    renderChat('API Error: 401 Unauthorized');

    const card = document.querySelector('.msg.error');
    expect(card?.querySelector('button[aria-expanded]')).toBeNull();
    expect(card?.textContent).toContain('API Error: 401 Unauthorized');
    expect(screen.getByText('chat.resumeRunCta')).toBeTruthy();
  });
});
