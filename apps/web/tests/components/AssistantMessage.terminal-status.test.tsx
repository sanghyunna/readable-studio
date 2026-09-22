// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key }));
afterEach(cleanup);

it.each(['failed', 'canceled', 'succeeded'] as const)('renders the actual %s terminal state', (runStatus) => {
  // Given: a completed stream whose persisted outcome is known.
  const message: ChatMessage = {
    id: 'terminal-message', role: 'assistant', content: '', runStatus,
    startedAt: 1000, endedAt: 2000, events: [],
  };
  // When: the message is rendered after streaming ends.
  const { container } = render(<AssistantMessage message={message} streaming={false} projectId="project-terminal" />);
  // Then: the footer uses the outcome's translation key, never success for failure.
  expect(container.querySelector('.assistant-label')?.textContent).toBe(
    runStatus === 'succeeded' ? 'assistant.doneLabel' : `designs.status.${runStatus}`,
  );
});
