// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key, useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('../../src/components/ChatComposer', () => ({ ChatComposer: () => null }));
const props: ComponentProps<typeof ChatPane> = {
  messages: [{ id: 'new', role: 'user', content: 'new' }], streaming: false, error: null,
  projectId: 'p', projectFiles: [], onEnsureProject: async () => 'p', onSend: vi.fn(), onStop: vi.fn(),
  conversations: [], activeConversationId: 'c', onSelectConversation: vi.fn(), onDeleteConversation: vi.fn(),
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('loads older messages on scroll-back and preserves the viewport on prepend, then follows new output at bottom', async () => {
  // Given: a scrollable history and a controlled animation frame queue.
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const older = vi.fn().mockResolvedValue(undefined);
  const view = render(<ChatPane {...props} hasOlderMessages onLoadOlderMessages={older} />);
  const log = view.container.querySelector('.chat-log');
  if (!(log instanceof HTMLElement)) throw new Error('Missing chat log');
  let height = 1000;
  Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } });
  await act(async () => { for (const frame of frames.splice(0)) frame(0); });
  // When: scroll back, then prepend a 300px page.
  log.scrollTop = 30;
  fireEvent.scroll(log);
  expect(older).toHaveBeenCalledTimes(1);
  height = 1300;
  const messages = [{ id: 'old', role: 'user' as const, content: 'old' }, ...props.messages];
  view.rerender(<ChatPane {...props} messages={messages} hasOlderMessages={false} onLoadOlderMessages={older} />);
  // Then: the old viewport is displaced by exactly the prepended height.
  expect(log.scrollTop).toBe(330);
  log.scrollTop = 900;
  fireEvent.scroll(log);
  height = 1400;
  view.rerender(<ChatPane {...props} messages={[...messages, { id: 'output', role: 'assistant', content: 'new output' }]} />);
  expect(log.scrollTop).toBe(1400);
});
