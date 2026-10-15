// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saveMessage, listMessages, streamViaDaemon } = vi.hoisted(() => ({
  saveMessage: vi.fn(),
  listMessages: vi.fn(),
  streamViaDaemon: vi.fn(),
}));
vi.mock('../../../src/state/projects', () => ({ saveMessage, listMessages }));
vi.mock('../../../src/providers/daemon', () => ({ streamViaDaemon }));

import { useConversationChat } from '../../../src/components/workspace/useConversationChat';
import { getEn } from '../../../src/i18n/locales/en';
import type { AppConfig } from '../../../src/types';

const ctx = {
  config: { mode: 'daemon', agentId: 'a', agentModels: { a: { model: 'm' } } } as unknown as AppConfig,
  agentsById: new Map([['a', { id: 'a', name: 'A', models: [{ id: 'm', label: 'm' }] }]]),
  locale: 'en',
  sessionMode: 'design',
} as never;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  listMessages.mockResolvedValue([]);
  streamViaDaemon.mockResolvedValue(undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  cleanup();
  vi.resetAllMocks();
});

async function sendOnce() {
  const hook = renderHook(() => useConversationChat('p', 'c', ctx));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('useConversationChat message persistence', () => {
  it.each([
    ['non-ok status', { ok: false, status: 500 }],
    ['network failure', { ok: false, status: null }],
  ])('surfaces a failed save (%s) through error', async (_n, result) => {
    saveMessage.mockResolvedValue(result);
    const { result: r } = await sendOnce();
    act(() => r.current.onSend('hi', [], []));
    await waitFor(() => expect(r.current.error).toBe(getEn()['chat.messageSaveFailed']));
    expect(r.current.messages.length).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  it('leaves error clear when the save succeeds', async () => {
    saveMessage.mockResolvedValue({ ok: true });
    const { result: r } = await sendOnce();
    act(() => r.current.onSend('hi', [], []));
    await waitFor(() => expect(saveMessage).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(r.current.error).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
