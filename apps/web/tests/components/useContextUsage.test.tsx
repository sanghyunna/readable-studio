// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ContextUsageResponse, ContextUsageSnapshot } from '@readable-studio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextUsage } from '../../src/components/useContextUsage';
import { fetchContextUsage } from '../../src/providers/context-usage';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/providers/context-usage', () => ({ fetchContextUsage: vi.fn() }));
const snapshot: ContextUsageSnapshot = {
  state: 'measured', usedTokens: 200_000, limitTokens: 500_000,
  source: 'codex', limitSource: 'runtime', model: 'fixture-model', sessionId: 's1', updatedAt: 1,
};
const response: ContextUsageResponse = { projectId: 'p', conversationId: 'c', agentId: 'codex', runId: 'r1', snapshot };
const input = { projectId: 'p', conversationId: 'c', messagesConversationId: 'c', agentId: 'codex', model: 'fixture-model', messages: [] as ChatMessage[] };
const assistant = (id: string, runId: string, snapshots: ContextUsageSnapshot[], runStatus: ChatMessage['runStatus'] = 'running'): ChatMessage => ({
  id, runId, runStatus, role: 'assistant', agentId: 'codex', content: '', events: snapshots.map(snapshot => ({ kind: 'context_usage', snapshot })),
});
beforeEach(() => { vi.mocked(fetchContextUsage).mockResolvedValue(response); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('useContextUsage', () => {
  it('restores a conversation snapshot on reload without polling', async () => {
    const view = renderHook(useContextUsage, { initialProps: input });
    expect(view.result.current).toBeNull();
    await waitFor(() => expect(view.result.current).toEqual(snapshot));
    view.rerender({ ...input, messages: [{ id: 'u', role: 'user', content: 'typed follow-up' }] });
    expect(fetchContextUsage).toHaveBeenCalledTimes(1);
    expect(fetchContextUsage).toHaveBeenCalledWith('p', 'c', 'codex', 'fixture-model');
  });

  it('clears on a new run, accepts its live snapshots, and ignores a late event on the old run', async () => {
    const old = assistant('a1', 'r1', [snapshot], 'succeeded');
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [old] } });
    await waitFor(() => expect(view.result.current).toEqual(snapshot));
    const started: ContextUsageSnapshot = { ...snapshot, state: 'unknown', usedTokens: null, reason: 'run-started', updatedAt: 2 };
    vi.mocked(fetchContextUsage).mockResolvedValue({ ...response, runId: 'r2', snapshot: started });
    const current = assistant('a2', 'r2', []);
    view.rerender({ ...input, messages: [old, current] });
    expect(view.result.current).toBeNull();
    await waitFor(() => expect(view.result.current).toEqual(started));
    const live = { ...snapshot, usedTokens: 284_000, updatedAt: 3 };
    view.rerender({ ...input, messages: [old, assistant('a2', 'r2', [live])] });
    expect(view.result.current).toEqual(live);
    view.rerender({ ...input, messages: [assistant('a1', 'r1', [{ ...snapshot, usedTokens: 450_000, updatedAt: 100 }], 'succeeded'), assistant('a2', 'r2', [live])] });
    expect(view.result.current).toEqual(live);
  });

  it('clears on compaction/session reset and does not revive an older snapshot appended late', async () => {
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [assistant('a1', 'r1', [snapshot])] } });
    await waitFor(() => expect(view.result.current).toEqual(snapshot));
    const reset: ContextUsageSnapshot = { ...snapshot, state: 'unknown', usedTokens: null, reason: 'compacting', updatedAt: 3 };
    view.rerender({ ...input, messages: [assistant('a1', 'r1', [snapshot, reset, { ...snapshot, updatedAt: 2 }])] });
    expect(view.result.current).toEqual(reset);
    const session = { ...reset, reason: 'session-changed' as const, sessionId: 's2', updatedAt: 4 };
    view.rerender({ ...input, messages: [assistant('a1', 'r1', [session])] });
    expect(view.result.current).toEqual(session);
    const fresh = { ...snapshot, sessionId: 's2', usedTokens: 0, updatedAt: 5 };
    view.rerender({ ...input, messages: [assistant('a1', 'r1', [session, fresh])] });
    expect(view.result.current).toEqual(fresh);
  });

  it.each(['model', 'conversationId', 'agentId'] as const)('clears stale %s data immediately and ignores the previous fetch', async (field) => {
    let first!: (value: ContextUsageResponse) => void;
    let second!: (value: ContextUsageResponse) => void;
    vi.mocked(fetchContextUsage)
      .mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const view = renderHook(useContextUsage, { initialProps: input });
    const changed = { ...input, [field]: 'changed', ...(field === 'conversationId' ? { messagesConversationId: 'changed' } : {}) };
    view.rerender(changed);
    await act(async () => first(response));
    expect(view.result.current).toBeNull();
    const unknown: ContextUsageSnapshot = { ...snapshot, state: 'unknown', usedTokens: null, reason: 'model-changed', updatedAt: 3 };
    await act(async () => second({ ...response, snapshot: unknown }));
    expect(view.result.current).toEqual(unknown);
  });

  it.each([
    ['succeeded', 'run-started'], ['failed', 'compacting'], ['canceled', 'compacted'], ['failed', 'model-changed'],
  ] as const)('ends a live waiting marker when the run turns %s, without refetching (%s)', async (status, reason) => {
    // The daemon's close-time not-reported event is dropped when the run is already terminal.
    const waiting: ContextUsageSnapshot = { ...snapshot, state: 'unknown', usedTokens: null, reason, updatedAt: 2 };
    vi.mocked(fetchContextUsage).mockResolvedValue({ ...response, snapshot: waiting });
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [assistant('a1', 'r1', [waiting])] } });
    await waitFor(() => expect(view.result.current).toEqual(waiting));
    view.rerender({ ...input, messages: [assistant('a1', 'r1', [waiting], status)] });
    expect(view.result.current).toEqual({ ...waiting, reason: 'not-reported' });
    expect(fetchContextUsage).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched reported model and never reads another conversation message set', async () => {
    vi.mocked(fetchContextUsage).mockResolvedValue({ ...response, snapshot: { ...snapshot, model: 'old-model' } });
    const view = renderHook(useContextUsage, { initialProps: input });
    await waitFor(() => expect(fetchContextUsage).toHaveBeenCalledTimes(1));
    expect(view.result.current).toBeNull();
    view.rerender({ ...input, messagesConversationId: 'old', messages: [assistant('a1', 'r1', [snapshot])] });
    expect(view.result.current).toBeNull();
  });

  it('stays unknown after a failed read instead of using unverified historical occupancy', async () => {
    vi.mocked(fetchContextUsage).mockRejectedValue(new Error('offline'));
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [assistant('a1', 'r1', [snapshot], 'succeeded')] } });
    await waitFor(() => expect(fetchContextUsage).toHaveBeenCalledTimes(1));
    expect(view.result.current).toBeNull();
  });

  it.each(['canceled', 'failed'] as const)('does not revive the previous run after a new %s run reports no context', async (status) => {
    const old = assistant('a1', 'r1', [snapshot], 'succeeded');
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [old] } });
    await waitFor(() => expect(view.result.current).toEqual(snapshot));
    view.rerender({ ...input, messages: [old, assistant('a2', 'r2', [])] });
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toBeNull();
    view.rerender({ ...input, messages: [old, assistant('a2', 'r2', [], status)] });
    expect(view.result.current).toBeNull();
  });

  it('never lets a later timestamp on a restored old run replace the canonical current run', async () => {
    const current = { ...response, runId: 'run-B' };
    vi.mocked(fetchContextUsage).mockResolvedValue(current);
    const view = renderHook(useContextUsage, { initialProps: { ...input, messages: [assistant('old', 'run-A', [{ ...snapshot, usedTokens: 450_000, updatedAt: 100 }], 'succeeded')] } });
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toBeNull();
  });
});
