// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
import { ChatComposer, type ChatComposerHandle } from '../../src/components/ChatComposer';
import { composerText, flushMounts, typeInComposer } from '../helpers/lexical-composer';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('appends synchronously to the real composer without replacing staged attachments or sending', async () => {
  const ref = createRef<ChatComposerHandle>();
  const send = vi.fn();
  render(<ChatComposer ref={ref} projectId="p" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p'} onSend={send} onStop={vi.fn()} skills={[]} />);
  await flushMounts();
  await act(async () => ref.current!.restoreDraft({ text: 'Existing', attachments: [{ path: 'notes.txt', name: 'notes.txt', kind: 'file' }] }));
  await act(async () => { ref.current!.appendDraft('request one'); ref.current!.appendDraft('request two'); });
  expect(composerText()).toBe('Existing\n\nrequest one\n\nrequest two');
  expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByTestId('chat-send')));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1]).toEqual([expect.objectContaining({ path: 'notes.txt' })]);
});

it('consumes an append signal only once through ChatPane and sends only explicitly', async () => {
  const send = vi.fn();
  const props = { projectKindForTracking: 'prototype' as const, messages: [], streaming: false, error: null, projectId: 'p', projectFiles: [], onEnsureProject: async () => 'p', onSend: send, onStop: vi.fn(), conversations: [], activeConversationId: null, onSelectConversation: vi.fn(), onDeleteConversation: vi.fn() };
  const view = render(<ChatPane {...props} />);
  await flushMounts();
  typeInComposer('Existing');
  const signal = { text: 'width request', nonce: 1, mode: 'append' as const };
  await act(async () => view.rerender(<ChatPane {...props} hidden composerDraftSignal={signal} />));
  expect(composerText()).toBe('Existing');
  await act(async () => view.rerender(<ChatPane {...props} composerDraftSignal={signal} />));
  await act(async () => view.rerender(<ChatPane {...props} composerDraftSignal={{ ...signal }} />));
  expect(composerText()).toBe('Existing\n\nwidth request');
  expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByTestId('chat-send')));
  expect(send).toHaveBeenCalledTimes(1);
});
