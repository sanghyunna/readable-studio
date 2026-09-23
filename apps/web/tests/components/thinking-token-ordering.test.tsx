// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { createBufferedTextUpdates } from '../../src/components/ProjectView';
import type { ChatMessage } from '../../src/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('thinking before any prose and after buffered prose survives projection and renders as separate expandable blocks', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let message: ChatMessage = { id: 'thinking-order', role: 'assistant', content: '', events: [], createdAt: 1 };
  const buffer = createBufferedTextUpdates({ updateMessage: update => { message = update(message); }, persistSoon: () => {} });
  try {
    buffer.appendEvent({ kind: 'thinking', text: 'EARLY_REASONING_SENTINEL' });
    expect(message.content).toBe('');
    expect(message.events).toEqual([{ kind: 'thinking', text: 'EARLY_REASONING_SENTINEL' }]);
    buffer.appendContent('ANSWER_SENTINEL');
    buffer.appendEvent({ kind: 'text', text: 'ANSWER_SENTINEL' });
    buffer.appendEvent({ kind: 'thinking', text: 'LATE_REASONING_SENTINEL' });
    buffer.flush();
    expect(message.events?.map(event => event.kind)).toEqual(['thinking', 'text', 'thinking']);
    const view = render(<AssistantMessage message={message} streaming={false} projectId="fixture" />);
    const toggles = view.container.querySelectorAll('.thinking-toggle');
    expect(toggles.length).toBe(2);
    toggles.forEach(toggle => fireEvent.click(toggle));
    // Markdown underscores are emphasis delimiters, not literal DOM text.
    expect([...view.container.querySelectorAll('.thinking-body')].map(body => body.textContent))
      .toEqual(['EARLYREASONINGSENTINEL', 'LATEREASONINGSENTINEL']);
  } finally { buffer.cancel(); }
});
