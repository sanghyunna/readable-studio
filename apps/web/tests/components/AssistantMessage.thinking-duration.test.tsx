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

test('the send-path buffer preserves first, middle, tool-ended and turn-ended durations after JSON reload', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let message: ChatMessage = { id: 'fgen2-d04', role: 'assistant', content: '', endedAt: 11000, events: [] };
  const buffer = createBufferedTextUpdates({
    updateMessage: update => { message = update(message); },
    persistSoon: () => {},
  });
  try {
    // Reconstructed order from final-gen-2/thinking-paragraphs.json and ui-fatal-thinking.json.
    // The removed runtime's exact timestamps are unavailable; use deterministic observation times.
    buffer.appendEvent({ kind: 'thinking', text: 'Locating project files\n\n프로젝트 파일 경로를 찾습니다', timestamp: 1000 });
    buffer.appendTextEvent('요청하신 작업 폴더의 파일 목록을 확인하겠습니다.', 2000);
    buffer.appendTextEvent(' 파일은 수정하지 않겠습니다.', 2500);
    buffer.appendEvent({ kind: 'tool_use', id: 'list', name: 'Bash', input: {}, timestamp: 3000 });
    buffer.appendEvent({ kind: 'thinking', text: 'Verifying the file listing\n\nChecking hidden files', timestamp: 4000 });
    buffer.appendEvent({ kind: 'tool_use', id: 'hidden', name: 'Bash', input: {}, timestamp: 5000 });
    buffer.appendEvent({ kind: 'thinking', text: '폴더에 파일이 없음을 확인했습니다', timestamp: 6000 });
    buffer.appendTextEvent('작업 폴더에 파일이 없습니다.', 7000);
    buffer.appendEvent({ kind: 'thinking', text: 'Final block without prose', timestamp: 10000 });
    buffer.flush();
    const reopened = JSON.parse(JSON.stringify(message)) as ChatMessage;
    expect(reopened.events?.filter(ev => ev.kind === 'text').map(ev => ev.timestamp)).toEqual([2000, 7000]);
    const view = render(<AssistantMessage message={reopened} streaming={false} projectId="test" />);
    expect([...view.container.querySelectorAll('.thinking-label')]
      .map(el => el.textContent?.match(/\d+/)?.[0])).toEqual(['1', '1', '1', '1']);
  } finally {
    buffer.cancel();
  }
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
