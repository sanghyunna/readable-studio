import type { ContextUsageSnapshot } from '@readable-studio/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContextUsage } from '../../src/providers/context-usage';
import { reattachDaemonRun } from '../../src/providers/daemon';

afterEach(() => vi.unstubAllGlobals());
const snapshot: ContextUsageSnapshot = { state: 'measured', usedTokens: 284_000, limitTokens: 500_000, source: 'codex', limitSource: 'runtime', model: 'fixture-model', sessionId: 's1', updatedAt: 1 };

describe('context usage transport', () => {
  it('uses the shared scoped GET endpoint and refuses a mismatched response identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ projectId: 'p 1', conversationId: 'c/1', agentId: 'codex', runId: 'r1', snapshot }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchContextUsage('p 1', 'c/1', 'codex', 'fixture model')).snapshot).toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p%201/conversations/c%2F1/context-usage?agentId=codex&model=fixture+model');
    fetchMock.mockResolvedValue(Response.json({ projectId: 'other', conversationId: 'c/1', agentId: 'codex', snapshot }));
    await expect(fetchContextUsage('p 1', 'c/1', 'codex', 'fixture model')).rejects.toThrow('does not match');
  });

  it('preserves measured and unknown context snapshots through the real SSE translator', async () => {
    const reset: ContextUsageSnapshot = { ...snapshot, state: 'unknown', usedTokens: null, reason: 'compacting', updatedAt: 2 };
    const events = [snapshot, reset].map(snapshot => `event: agent\ndata: ${JSON.stringify({ type: 'context_usage', snapshot })}\n\n`).join('')
      + 'event: end\ndata: {"code":0,"status":"succeeded"}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); } }))));
    const onAgentEvent = vi.fn();
    const onError = vi.fn();
    await reattachDaemonRun({ runId: 'r1', signal: new AbortController().signal, handlers: { onAgentEvent, onDelta: vi.fn(), onDone: vi.fn(), onError } });
    expect(onError).not.toHaveBeenCalled();
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual([{ kind: 'context_usage', snapshot }, { kind: 'context_usage', snapshot: reset }]);
  });
});
