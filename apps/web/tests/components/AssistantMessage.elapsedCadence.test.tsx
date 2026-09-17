// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { en } from '../../src/i18n/locales/en';
import { applyPerformanceProfileToDocument, PERFORMANCE_PROFILE_ATTRIBUTE } from '../../src/state/config';
import type { ChatMessage } from '../../src/types';

const startedAt = 1_700_000_000_000;
const message: ChatMessage = {
  id: 'elapsed', role: 'assistant', content: 'First chunk',
  startedAt, runStatus: 'running',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startedAt);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute(PERFORMANCE_PROFILE_ATTRIBUTE);
});

describe('assistant elapsed cadence', () => {
  it.each([
    { profile: 'low', cadence: 1000, elapsed: '1.0s' },
    { profile: 'full', cadence: 200, elapsed: '0.2s' },
  ])('updates only at $cadence ms when $profile', ({ profile, cadence, elapsed }) => {
    // Given a streaming message with a deterministic clock.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, profile);
    const { container } = render(<AssistantMessage message={message} streaming projectId={null} />);
    expect(vi.getTimerCount()).toBe(1);
    // When the clock crosses its first cadence boundary.
    act(() => vi.advanceTimersByTime(cadence - 1));
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('0.0s');
    act(() => vi.advanceTimersByTime(1));
    // Then only that boundary updates the displayed elapsed value.
    expect(container.querySelector('.assistant-stats')?.textContent).toBe(elapsed);
  });

  it.each([
    { initial: 'full', next: 'low', cadence: 1000, elapsed: '1.0s' },
    { initial: 'low', next: 'full', cadence: 200, elapsed: '0.2s' },
  ] as const)('replaces the mounted cadence when toggling $initial to $next', async ({ initial, next, cadence, elapsed }) => {
    // Given an already mounted stream with unchanged props.
    applyPerformanceProfileToDocument(initial);
    const { container } = render(<AssistantMessage message={message} streaming projectId={null} />);
    // When the owner changes only the profile.
    await act(async () => { applyPerformanceProfileToDocument(next); });
    // Then exactly one clock follows the new cadence, not the original one.
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(cadence - 1));
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('0.0s');
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.assistant-stats')?.textContent).toBe(elapsed);
  });

  it('preserves content and authoritative completion across a mid-stream round trip', async () => {
    // Given a running message that has already ticked in full mode.
    const { rerender, container } = render(<AssistantMessage message={message} streaming projectId={null} />);
    act(() => vi.advanceTimersByTime(200));
    await act(async () => { applyPerformanceProfileToDocument('low'); });
    const next = { ...message, content: 'Content received in low mode' };
    rerender(<AssistantMessage message={next} streaming projectId={null} />);
    expect(screen.getByText(next.content)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('1.2s');
    await act(async () => { applyPerformanceProfileToDocument('full'); });
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('1.4s');
    const completed: ChatMessage = {
      ...next, content: 'Complete content after toggles', runStatus: 'succeeded', endedAt: startedAt + 1456,
    };
    // When completion arrives between cadence boundaries after both toggles.
    rerender(<AssistantMessage message={completed} streaming={false} projectId={null} />);
    // Then content, terminal state and exact end time are independent of the cadence.
    expect(screen.getByText(completed.content)).toBeTruthy();
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('1.5s');
    expect(container.querySelector('.assistant-footer')?.getAttribute('data-streaming')).toBe('false');
    expect(container.querySelector('.assistant-label')?.textContent).toBe(en['assistant.doneLabel']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['low', 'full'])('renders streamed content immediately between ticks when %s', (profile) => {
    // Given a mounted stream whose clock has not ticked.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, profile);
    const { rerender, container } = render(<AssistantMessage message={message} streaming projectId={null} />);
    const next = { ...message, content: 'First chunk plus second chunk' };
    // When more content arrives without advancing time.
    rerender(<AssistantMessage message={next} streaming projectId={null} />);
    // Then all incoming content is rendered independently of the elapsed clock.
    expect(screen.getByText(next.content)).toBeTruthy();
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('0.0s');
    expect(container.querySelector('.assistant-footer')?.getAttribute('data-streaming')).toBe('true');
  });

  it.each(['low', 'full'])('uses exact completion time and stops ticking when %s completes between ticks', (profile) => {
    // Given a stream with no elapsed ticks yet.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, profile);
    const { rerender, container } = render(<AssistantMessage message={message} streaming projectId={null} />);
    const completed: ChatMessage = {
      ...message, content: 'All streamed content', runStatus: 'succeeded', endedAt: startedAt + 3456,
    };
    // When authoritative completion arrives independently of the UI clock.
    rerender(<AssistantMessage message={completed} streaming={false} projectId={null} />);
    // Then final time, content and completion state are preserved with no interval.
    expect(container.querySelector('.assistant-stats')?.textContent).toBe('3.5s');
    expect(screen.getByText(completed.content)).toBeTruthy();
    expect(container.querySelector('.assistant-footer')?.getAttribute('data-streaming')).toBe('false');
    expect(container.querySelector('.assistant-label')?.textContent).toBe(en['assistant.doneLabel']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
