// @vitest-environment jsdom

/**
 * The role row shows the model THIS run used next to the agent name, read
 * from the message's own record (CLI-reported `initializing` model, else the
 * ` · model` suffix stamped into `agentName` at send time). Messages with no
 * recorded model render nothing extra.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage, assistantRunModel } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import type { ChatMessage } from '../../src/types';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'done',
    agentId: 'claude',
    agentName: 'Claude',
    runStatus: 'succeeded',
    ...overrides,
  };
}

function renderMessage(msg: ChatMessage) {
  return render(
    <I18nProvider initial="en">
      <AssistantMessage message={msg} streaming={false} projectId="project-1" conversationId="conv-1" />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe('AssistantMessage role model label', () => {
  it('renders the recorded model after the agent name', () => {
    const { container } = renderMessage(
      message({ agentName: 'Claude · claude-sonnet-4-6' }),
    );
    const role = container.querySelector('.msg.assistant .role');
    expect(role?.querySelector('.role-name')?.textContent).toBe('Claude');
    const model = role?.querySelector('.role-model');
    expect(model?.textContent).toBe('claude-sonnet-4-6');
    expect(model?.previousElementSibling?.className).toBe('role-name');
  });

  it('renders nothing extra when the message has no recorded model', () => {
    const { container } = renderMessage(message());
    expect(container.querySelector('.msg.assistant .role .role-name')?.textContent).toBe('Claude');
    expect(container.querySelector('.msg.assistant .role .role-model')).toBeNull();
  });

  it('prefers the CLI-reported model over the send-time suffix and hides the default sentinel', () => {
    expect(
      assistantRunModel(
        message({
          agentName: 'Claude · claude-sonnet-4-6',
          events: [{ kind: 'status', label: 'initializing', detail: 'claude-opus-4-1' }],
        }),
      ),
    ).toBe('claude-opus-4-1');
    expect(assistantRunModel(message({ agentName: 'Codex · default' }))).toBeNull();
    expect(assistantRunModel(message({ agentName: 'OpenAI API · google/gemma-4-e4b' }))).toBe(
      'google/gemma-4-e4b',
    );
  });
});
