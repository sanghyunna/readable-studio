// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import type { AgentEvent, ChatMessage } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Done.',
    runStatus: 'succeeded',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [{ kind: 'text', text: 'Done.' } as AgentEvent],
    producedFiles: [],
    ...overrides,
  } as ChatMessage;
}

function rollbackEvent(overrides: Partial<{
  requestId: string;
  expiresAt: number;
  runId: string;
  projectId: string;
  conversationId: string;
  targetMessageId: string;
  targetCheckpointId: string;
  mode: 'files_only' | 'chat_only' | 'files_and_chat';
  reason: string;
}> = {}) {
  return {
    kind: 'agent_rollback_request',
    requestId: 'request-1',
    expiresAt: Date.now() + 60_000,
    runId: 'run-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    targetMessageId: 'msg-1',
    targetCheckpointId: 'cp-1',
    mode: 'files_only' as const,
    reason: 'I overwrote the wrong file',
    ...overrides,
  };
}

function renderWithI18n(element: React.ReactElement) {
  return render(<I18nProvider initial="en">{element}</I18nProvider>);
}

describe('AssistantMessage agent rollback banner', () => {
  it('renders the rollback request banner when the last message has a rollback_request event', () => {
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [rollbackEvent() as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        isLast
      />,
    );

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('Agent wants to undo its last edit')).toBeTruthy();
    expect(screen.getByText('I overwrote the wrong file')).toBeTruthy();
  });

  it('does not show the banner for non-last messages', () => {
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [rollbackEvent() as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Agent wants to undo its last edit')).toBeNull();
  });

  it('does not show the banner while streaming', () => {
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [rollbackEvent() as AgentEvent] })}
        streaming
        projectId="proj-1"
        conversationId="conv-1"
        isLast
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps an accepted request retryable until a successful restore dismisses it', () => {
    const onAgentRollbackConfirm = vi.fn();
    const event = rollbackEvent();
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [event as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        isLast
        onAgentRollbackConfirm={onAgentRollbackConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accept the rollback request and restore the selected checkpoint' }));

    expect(onAgentRollbackConfirm).toHaveBeenCalledTimes(1);
    expect(onAgentRollbackConfirm).toHaveBeenCalledWith(event, true, expect.any(Function));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(window.localStorage.getItem('readable:agent-rollback-dismissed:request-1')).toBeNull();

    // Canceling or a failed restore does not invoke the completion callback, so
    // Accept remains available for another attempt.
    fireEvent.click(screen.getByRole('button', { name: 'Accept the rollback request and restore the selected checkpoint' }));
    expect(onAgentRollbackConfirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toBeTruthy();

    // A successful restore owns the durable dismissal.
    const dismissAfterSuccess = onAgentRollbackConfirm.mock.calls[1]?.[2] as (() => void) | undefined;
    act(() => dismissAfterSuccess?.());
    expect(screen.queryByRole('status')).toBeNull();
    expect(window.localStorage.getItem('readable:agent-rollback-dismissed:request-1')).toBe('1');
  });

  it('disables execution after the opaque request expires', () => {
    const onAgentRollbackConfirm = vi.fn();
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [rollbackEvent({ expiresAt: Date.now() - 1 }) as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        isLast
        onAgentRollbackConfirm={onAgentRollbackConfirm}
      />,
    );

    const accept = screen.getByRole('button', { name: 'Accept the rollback request and restore the selected checkpoint' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByText('This rollback request has expired.')).toBeTruthy();
    fireEvent.click(accept);
    expect(onAgentRollbackConfirm).not.toHaveBeenCalled();
  });

  it('calls onAgentRollbackConfirm with accepted=false when the reject button is clicked', () => {
    const onAgentRollbackConfirm = vi.fn();
    const event = rollbackEvent();
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [event as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        isLast
        onAgentRollbackConfirm={onAgentRollbackConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject the rollback request and keep the current files' }));

    expect(onAgentRollbackConfirm).toHaveBeenCalledTimes(1);
    expect(onAgentRollbackConfirm).toHaveBeenCalledWith(event, false, expect.any(Function));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('calls onAgentRollbackShowDiff when the show diff button is clicked', () => {
    const onAgentRollbackShowDiff = vi.fn();
    const event = rollbackEvent();
    renderWithI18n(
      <AssistantMessage
        message={baseMessage({ events: [event as AgentEvent] })}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        isLast
        onAgentRollbackShowDiff={onAgentRollbackShowDiff}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview the differences before deciding on the rollback' }));

    expect(onAgentRollbackShowDiff).toHaveBeenCalledTimes(1);
    expect(onAgentRollbackShowDiff).toHaveBeenCalledWith(event);
  });
});
