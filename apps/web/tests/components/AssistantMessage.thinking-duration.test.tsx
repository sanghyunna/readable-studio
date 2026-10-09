// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { createBufferedTextUpdates } from '../../src/components/ProjectView';
import type { ChatMessage } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('reopened thinking blocks retain separate timestamp-derived durations', () => {
  const message = JSON.parse(JSON.stringify({
    id: 'timed', role: 'assistant', content: 'Done', endedAt: 9000,
    events: [
      { kind: 'thinking', text: 'First', timestamp: 1000 },
      { kind: 'thinking', text: ' summary', timestamp: 2000 },
      { kind: 'text', text: 'Answer', timestamp: 4000 },
      { kind: 'thinking', text: 'Second', timestamp: 6000 },
    ],
  })) as ChatMessage;
  const view = render(<AssistantMessage message={message} streaming={false} projectId="test" />);
  expect([...view.container.querySelectorAll('.thinking-label')]
    .map(el => el.textContent?.match(/\d+/)?.[0])).toEqual(['3', '3']);
});

test('unknown or inverted timestamps do not invent thinking duration', () => {
  const message: ChatMessage = {
    id: 'legacy', role: 'assistant', content: '', endedAt: 9000,
    events: [
      { kind: 'thinking', text: 'Unknown' },
      { kind: 'text', text: 'Answer', timestamp: 4000 },
      { kind: 'thinking', text: 'Invalid', timestamp: 10000 },
    ],
  };
  const view = render(<AssistantMessage message={message} streaming={false} projectId="test" />);
  expect([...view.container.querySelectorAll('.thinking-label')]
    .every(el => !(/\d/.test(el.textContent ?? '')))).toBe(true);
});

test('buffered prose preserves its first observation time to close thinking', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let message: ChatMessage = { id: 'buffered', role: 'assistant', content: '', events: [] };
  const buffer = createBufferedTextUpdates({
    updateMessage: update => { message = update(message); },
    persistSoon: () => {},
  });
  try {
    buffer.appendEvent({ kind: 'thinking', text: 'Reasoning', timestamp: 1000 });
    buffer.appendEvent({ kind: 'text', text: 'First', timestamp: 4000 });
    buffer.appendEvent({ kind: 'text', text: 'Second', timestamp: 5000 });
    buffer.flush();
    expect(message.events?.[1]).toEqual({ kind: 'text', text: 'FirstSecond', timestamp: 4000 });
    const view = render(<AssistantMessage message={message} streaming={false} projectId="test" />);
    expect(view.container.querySelector('.thinking-label')?.textContent?.match(/\d+/)?.[0]).toBe('3');
  } finally {
    buffer.cancel();
  }
});
