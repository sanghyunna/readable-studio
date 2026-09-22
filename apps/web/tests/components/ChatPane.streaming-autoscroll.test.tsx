// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
import type { ChatComposer } from '../../src/components/ChatComposer';
import type { ChatMessage } from '../../src/types';

// Only replace the editor input; ChatPane's send handler, messages, scroll
// owner, observers and anchor lifecycle all run unchanged.
vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef<HTMLDivElement, ComponentProps<typeof ChatComposer>>(
    function Composer({ onSend }, ref) {
      return <div ref={ref}><button onClick={() => onSend('new request', [], [])}>Send fixture</button></div>;
    },
  ),
}));

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  deliver() { this.callback([], this); }
}

const history: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'previous request', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'previous response', createdAt: 2 },
];
const prompt: ChatMessage = { id: 'u2', role: 'user', content: 'new request', createdAt: 3 };
const props: ComponentProps<typeof ChatPane> = {
  messages: history, streaming: false, error: null, projectId: 'p', projectFiles: [],
  onEnsureProject: async () => 'p', onSend: vi.fn(), onStop: vi.fn(),
  conversations: [], activeConversationId: 'c', onSelectConversation: vi.fn(), onDeleteConversation: vi.fn(),
};
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  ControlledResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function frame() {
  await act(async () => {
    for (const callback of frames.splice(0)) callback(0);
  });
}

async function sentTurn() {
  const view = render(<ChatPane {...props} />);
  const log = view.container.querySelector('.chat-log');
  const spacer = view.container.querySelector('.chat-log-tail-spacer');
  if (!(log instanceof HTMLElement) || !(spacer instanceof HTMLElement)) throw new Error('Missing scroll owner');
  // Model browser clamping and actual content coordinates, including the real
  // spacer's inline height. jsdom itself supplies no layout measurements.
  let contentHeight = 1000;
  let top = 0;
  Object.defineProperties(log, {
    clientHeight: { value: 400 },
    scrollHeight: { get: () => contentHeight + (Number.parseFloat(spacer.style.height) || 0) },
    scrollTop: {
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, log.scrollHeight - 400)); },
    },
    scrollTo: { value: (options: ScrollToOptions) => { log.scrollTop = options.top ?? top; } },
  });
  Object.defineProperty(spacer, 'offsetHeight', { get: () => Number.parseFloat(spacer.style.height) || 0 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.matches('.msg.user') ? 1000 - top : 0, 500, 40);
  });
  await frame();
  fireEvent.click(screen.getByText('Send fixture'));
  contentHeight = 1120;
  view.rerender(<ChatPane {...props} streaming messages={[...history, prompt]} />);
  await frame();
  // Browser scroll events from the prompt reveal must not count as opt-out.
  fireEvent.scroll(log);
  return {
    log, spacer,
    update(chunk: number, streaming = true) {
      contentHeight = 1120 + chunk * 120;
      view.rerender(<ChatPane {...props} streaming={streaming} messages={[
        ...history, prompt,
        { id: 'a2', role: 'assistant', content: 'incremental output '.repeat(chunk), createdAt: 4 },
      ]} />);
    },
    growAfterRender() { contentHeight += 160; },
  };
}

async function resize(log: HTMLElement) {
  await act(async () => {
    const observers = ControlledResizeObserver.instances.filter((observer) =>
      Array.from(observer.targets).some((target) => target.parentElement === log),
    );
    expect(observers.length).toBeGreaterThan(0);
    for (const observer of observers) observer.deliver();
  });
  await frame();
}

function distance(log: HTMLElement) { return log.scrollHeight - log.clientHeight - log.scrollTop; }

describe('local-send streaming auto-scroll', () => {
  it('keeps the initial prompt at the top while the assistant is still empty', async () => {
    // Given a locally sent prompt, revealed above a reserved tail.
    const turn = await sentTurn();
    // When an empty assistant placeholder arrives, before output starts.
    turn.update(0);
    await resize(turn.log);
    // Then the initial prompt anchor remains in place.
    expect(turn.log.scrollTop).toBe(988);
    expect(turn.spacer.style.height).toBe('268px');
  });

  it('follows every incremental update after output starts, including post-render growth and completion', async () => {
    // Given the real chat-log at the initial prompt anchor, with no user scroll.
    const turn = await sentTurn();
    const distances: number[] = [];
    // When a long assistant response arrives as 100 committed chunks.
    for (let chunk = 1; chunk <= 100; chunk++) {
      turn.update(chunk);
      await resize(turn.log);
      distances.push(distance(turn.log));
      // Markdown/layout may grow without another messages render.
      turn.growAfterRender();
      await resize(turn.log);
      distances.push(distance(turn.log));
      fireEvent.scroll(turn.log);
    }
    turn.update(100, false);
    await resize(turn.log);
    // Then every visible growth stays at the tail, not just the final render.
    expect(distances).toEqual(Array.from({ length: 200 }, () => 0));
    expect(distance(turn.log)).toBe(0);
    expect(turn.spacer.style.height).toBe('0px');
  });

  it('preserves manual opt-out before the first output and through completion', async () => {
    // Given the user deliberately scrolling 90px above the prompt anchor.
    const turn = await sentTurn();
    turn.log.scrollTop -= 90;
    fireEvent.scroll(turn.log);
    const manualTop = turn.log.scrollTop;
    const positions: number[] = [];
    // When the assistant starts and keeps streaming, then completes.
    for (let chunk = 1; chunk <= 20; chunk++) {
      turn.update(chunk);
      await resize(turn.log);
      positions.push(turn.log.scrollTop);
    }
    turn.update(20, false);
    await resize(turn.log);
    // Then the user's viewport is not reclaimed by anchor release or observers.
    expect(positions).toEqual(Array.from({ length: 20 }, () => manualTop));
    expect(turn.log.scrollTop).toBe(manualTop);
  });

  it('preserves manual opt-out after streaming follow has started', async () => {
    // Given active output followed by an intentional scroll 90px up.
    const turn = await sentTurn();
    turn.update(5);
    await resize(turn.log);
    turn.log.scrollTop = turn.log.scrollHeight - turn.log.clientHeight - 90;
    fireEvent.scroll(turn.log);
    const manualTop = turn.log.scrollTop;
    // When subsequent content and resize notifications arrive.
    turn.update(6);
    await resize(turn.log);
    // Then the 80px follow cutoff is still respected.
    expect(turn.log.scrollTop).toBe(manualTop);
  });
});
