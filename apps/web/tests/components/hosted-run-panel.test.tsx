// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedRunPanel } from '../../src/components/HostedRunPanel';

class MockEventSource {
  static latest: MockEventSource | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  close = vi.fn();

  constructor(readonly url: string) {
    MockEventSource.latest = this;
  }

  addEventListener(name: string, listener: EventListener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener as (event: MessageEvent) => void);
    this.listeners.set(name, listeners);
  }

  emit(name: string, data: unknown, lastEventId = '') {
    const event = new MessageEvent(name, { data: JSON.stringify(data), lastEventId });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function client() {
  return {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createProject: vi.fn().mockResolvedValue({
      project: { id: 'project-a', name: 'Portfolio', createdAt: 1, updatedAt: 1, status: 'active' },
    }),
    listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    createConversation: vi.fn().mockResolvedValue({
      conversation: {
        id: 'conversation-a', projectId: 'project-a', title: 'Build', sessionMode: 'design',
        messageCount: 0, createdAt: 1, updatedAt: 1, totalDurationMs: 0, latestRun: null,
      },
    }),
    upsertMessage: vi.fn().mockResolvedValue({ message: { id: 'message-a', role: 'assistant', content: '' } }),
    createRun: vi.fn().mockResolvedValue({
      runId: 'run-a', conversationId: 'conversation-a', assistantMessageId: 'assistant-a',
    }),
    cancelRun: vi.fn().mockResolvedValue({ ok: true }),
    runEventsUrl: vi.fn().mockReturnValue('/api/runs/run-a/events'),
  };
}

describe('HostedRunPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    MockEventSource.latest = null;
  });

  it('creates a project and conversation and streams the server-persisted result', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('user-a')
      .mockReturnValueOnce('assistant-a')
      .mockReturnValueOnce('request-a') });
    const api = client();
    render(<HostedRunPanel client={api} />);

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Portfolio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value)
      .toBe('project-a'));

    fireEvent.change(screen.getByLabelText('Conversation title'), { target: { value: 'Build' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create conversation' }));
    await waitFor(() => expect((screen.getByLabelText('Conversation') as HTMLSelectElement).value)
      .toBe('conversation-a'));

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      conversationId: 'conversation-a',
      assistantMessageId: 'assistant-a',
      clientRequestId: 'request-a',
      message: 'Build it',
    })));

    expect(MockEventSource.latest?.url).toBe('/api/runs/run-a/events');
    MockEventSource.latest?.emit('agent', { type: 'text_delta', delta: 'Done' }, '7');
    MockEventSource.latest?.emit('end', { status: 'succeeded', code: 0 }, '8');

    expect(await screen.findByText('Done')).toBeTruthy();
    expect(api.upsertMessage).toHaveBeenCalledTimes(2);
    expect(MockEventSource.latest?.close).toHaveBeenCalled();
  });

  it('cancels an active run without closing its event stream early', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('user-a')
      .mockReturnValueOnce('assistant-a')
      .mockReturnValueOnce('request-a') });
    const api = client();
    api.listProjects.mockResolvedValueOnce({ projects: [
      { id: 'project-a', name: 'Portfolio', createdAt: 1, updatedAt: 1, status: 'active' },
    ] });
    api.listConversations.mockResolvedValueOnce({ conversations: [
      { id: 'conversation-a', projectId: 'project-a', title: 'Build', sessionMode: 'design',
        messageCount: 0, createdAt: 1, updatedAt: 1, totalDurationMs: 0, latestRun: null },
    ] });
    render(<HostedRunPanel client={api} />);

    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value)
      .toBe('project-a'));
    await waitFor(() => expect((screen.getByLabelText('Conversation') as HTMLSelectElement).value)
      .toBe('conversation-a'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));

    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run-a'));
    expect(MockEventSource.latest?.close).not.toHaveBeenCalled();
  });

  it('retries an ambiguous admission failure with the same request identity', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('user-a')
      .mockReturnValueOnce('assistant-a')
      .mockReturnValueOnce('request-a') });
    const api = client();
    api.listProjects.mockResolvedValueOnce({ projects: [
      { id: 'project-a', name: 'Portfolio', createdAt: 1, updatedAt: 1, status: 'active' },
    ] });
    api.listConversations.mockResolvedValueOnce({ conversations: [
      { id: 'conversation-a', projectId: 'project-a', title: 'Build', sessionMode: 'design',
        messageCount: 0, createdAt: 1, updatedAt: 1, totalDurationMs: 0, latestRun: null },
    ] });
    api.createRun.mockRejectedValueOnce(new TypeError('response lost'));
    render(<HostedRunPanel client={api} />);

    await waitFor(() => expect((screen.getByLabelText('Conversation') as HTMLSelectElement).value)
      .toBe('conversation-a'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await screen.findByRole('button', { name: 'Retry run' });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Unrelated draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry run' }));

    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));
    expect(api.createRun.mock.calls[1]?.[0]).toEqual(api.createRun.mock.calls[0]?.[0]);
    expect(api.upsertMessage).toHaveBeenCalledTimes(2);
  });
});
