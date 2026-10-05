// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useProjectFileEvents } from '../../src/providers/project-events';
import { getKo } from '../../src/i18n/locales/ko';

class Stream {
  listeners = new Map<string, (event: Event) => void>();
  addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, listener); }
  close() {}
  emit(name: string) { this.listeners.get(name)?.(new Event(name)); }
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('shows the shared Korean reconnect state after one second of idle stream loss and clears on ready', async () => {
  vi.useFakeTimers();
  // Preserve real stream reconnect mechanics, substituting only the browser transport.
  const streams: Stream[] = [];
  class TrackedStream extends Stream { constructor() { super(); streams.push(this); } }
  vi.stubGlobal('EventSource', TrackedStream);
  function Project() {
    const reconnecting = useProjectFileEvents('open-project', true, () => {});
    return reconnecting ? <p role="status">{getKo()['connection.reconnecting']}</p> : null;
  }
  try {
    await act(async () => { render(<Project />); });
    act(() => { streams[0]!.emit('ready'); streams[0]!.emit('error'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('status').textContent).toBe(getKo()['connection.reconnecting']);
    act(() => { streams[1]!.emit('ready'); });
    expect(screen.queryByRole('status')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
it('does not flash a reconnect notice for a sub-second blip and cancels timers on unmount', async () => {
  vi.useFakeTimers();
  const streams: Stream[] = [];
  class TrackedStream extends Stream { constructor() { super(); streams.push(this); } }
  function Project() {
    const reconnecting = useProjectFileEvents('open-project', true, () => {}, {
      EventSourceCtor: TrackedStream as unknown as typeof EventSource, initialBackoffMs: 100,
    });
    return reconnecting ? <p role="status">reconnecting</p> : null;
  }
  const view = render(<Project />);
  act(() => streams[0]!.emit('error'));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  act(() => streams[1]!.emit('ready'));
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });
  expect(screen.queryByRole('status')).toBeNull();
  act(() => streams[1]!.emit('error'));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
