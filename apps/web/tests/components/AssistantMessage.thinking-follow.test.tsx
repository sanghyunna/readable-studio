// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

afterEach(cleanup);

function message(text: string): ChatMessage {
  return { id: 'thinking', role: 'assistant', content: '', events: [{ kind: 'thinking', text }] };
}

test('thinking is expanded during streaming and completion, retaining manual collapse per block', () => {
  const view = render(<AssistantMessage message={message('First')} streaming projectId="test" />);
  const boundary = () => view.container.querySelector('.thinking-block .accordion-collapsible');
  expect(boundary()?.getAttribute('aria-hidden')).toBe('false');
  view.rerender(<AssistantMessage message={message('First second')} streaming={false} projectId="test" />);
  expect(boundary()?.getAttribute('aria-hidden')).toBe('false');
  fireEvent.click(view.container.querySelector('.thinking-toggle')!);
  view.rerender(<AssistantMessage message={message('First second third')} streaming projectId="test" />);
  expect(boundary()?.getAttribute('aria-hidden')).toBe('true');
  view.rerender(<AssistantMessage message={message('First second third')} streaming={false} projectId="test" />);
  expect(boundary()?.getAttribute('aria-hidden')).toBe('true');
});

test('historical thinking is expanded by default', () => {
  const view = render(<AssistantMessage message={message('Saved reasoning')} streaming={false} projectId="test" />);
  expect(view.container.querySelector('.thinking-block .accordion-collapsible')?.getAttribute('aria-hidden')).toBe('false');
});

test('thinking follows growth, stops on deliberate scroll-up, and resumes at the bottom', () => {
  const view = render(<AssistantMessage message={message('First')} streaming projectId="test" />);
  const body = view.container.querySelector('.thinking-body') as HTMLElement;
  let height = 600;
  let top = 0;
  Object.defineProperties(body, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
  });
  const grow = (text: string, streaming = true) => {
    height += 100;
    view.rerender(<AssistantMessage message={message(text)} streaming={streaming} projectId="test" />);
  };
  grow('First second');
  expect(top).toBe(500);
  body.scrollTop -= 30;
  fireEvent.scroll(body);
  grow('First second third');
  expect(top).toBe(470);
  body.scrollTop = height - 200;
  fireEvent.scroll(body);
  grow('First second third fourth');
  expect(top).toBe(700);
  grow('Final reasoning', false);
  expect(top).toBe(800);
});
