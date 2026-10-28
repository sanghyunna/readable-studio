import { describe, expect, it } from 'vitest';
import { buildCodexContextUsage, buildPiContextUsage, contextUsageAtRunEnd, makeUnknownContextUsage, readContextUsageSnapshot, selectContextUsage } from '../src/context-usage.js';

describe('context occupancy', () => {
  it('uses Codex last request occupancy, never accumulated totals or double-counted cache/reasoning', () => {
    expect(buildCodexContextUsage({ modelContextWindow: 500_000,
      total: { totalTokens: 2_000_000 }, last: { totalTokens: 284_000, inputTokens: 280_000,
        cachedInputTokens: 200_000, outputTokens: 4_000, reasoningOutputTokens: 2_000 } },
    'test-model', 'thread-a', 1)).toMatchObject({ state: 'measured', usedTokens: 284_000,
      limitTokens: 500_000, limitSource: 'runtime', model: 'test-model', sessionId: 'thread-a' });
    expect(buildCodexContextUsage({ total: { totalTokens: 99 } }, 'test-model', 'thread-a', 1))
      .toMatchObject({ state: 'unknown', usedTokens: null, limitTokens: null });
  });

  it('preserves Pi SDK estimates and does not substitute cumulative session statistics', () => {
    const stats = { tokens: { total: 900_000 }, contextUsage: { tokens: 90_000, contextWindow: 200_000, percent: 45 } };
    expect(buildPiContextUsage(stats, { model: 'opus', sessionId: 'pi-a', now: 1 }))
      .toMatchObject({ state: 'estimated', usedTokens: 90_000, limitTokens: 200_000, limitSource: 'runtime' });
    expect(buildPiContextUsage(stats, { model: 'opus', sessionId: 'pi-a',
      limit: { tokens: null, source: 'default' }, now: 1 }))
      .toMatchObject({ state: 'estimated', usedTokens: 90_000, limitTokens: null, limitSource: 'default' });
    expect(buildPiContextUsage({ ...stats, contextUsage: { tokens: null, contextWindow: 200_000 } },
      { model: 'opus', sessionId: 'pi-a', now: 1 })).toMatchObject({ state: 'unknown', usedTokens: null });
  });

  it('rejects invalid token units and planning defaults, but shows advertised limits', () => {
    expect(buildCodexContextUsage({ modelContextWindow: -1, last: { totalTokens: 2.5 } }, 'm', 's', 1))
      .toMatchObject({ state: 'unknown', usedTokens: null, limitTokens: null });
    expect(buildPiContextUsage({ contextUsage: { tokens: 12, contextWindow: 1_000_000 } },
      { model: 'm', sessionId: 's', limit: { tokens: 128_000, source: 'advertised' }, now: 1 }))
      .toMatchObject({ state: 'estimated', usedTokens: 12, limitTokens: 128_000, limitSource: 'advertised' });
    expect(buildPiContextUsage({ contextUsage: { tokens: 12, contextWindow: 1_000_000 } },
      { model: 'm', sessionId: 's', limit: { tokens: 1_000_000, source: 'default' }, now: 1 }))
      .toMatchObject({ state: 'estimated', usedTokens: 12, limitTokens: null });
  });

  it('keeps an unknown snapshot reason when the selected model differs', () => {
    const response = selectContextUsage({ projectId: 'p', conversationId: 'c', agentId: 'cursor-agent', model: 'default', now: 5,
      runs: [{ id: 'r', agentId: 'cursor-agent', createdAt: 1, status: 'running',
        events: [{ event: 'agent', data: { type: 'context_usage', snapshot: makeUnknownContextUsage('not-reported', null, null, 1) } }] }] });
    expect(response.snapshot).toMatchObject({ state: 'unknown', reason: 'not-reported' });
  });

  it.each(['run-started', 'compacting', 'compacted', 'model-changed'] as const)('ends a transient %s marker once its run is over', (reason) => {
    // The child-close rule server.ts applies to the last emitted reason.
    expect(contextUsageAtRunEnd(reason, 'm')).toMatchObject({ state: 'unknown', reason: 'not-reported', model: 'm' });
    const events = [{ kind: 'context_usage', snapshot: makeUnknownContextUsage(reason, 'm', null, 1) }];
    const args = { projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'm', now: 5 };
    // A persisted 1.3.8 row with no live run (daemon restarted or run retired).
    expect(selectContextUsage({ ...args, runs: [], persisted: { id: 'r', agentId: 'pi', createdAt: 1, events } }).snapshot)
      .toMatchObject({ state: 'unknown', reason: 'not-reported' });
    for (const status of ['succeeded', 'failed', 'canceled']) {
      expect(selectContextUsage({ ...args, runs: [{ id: 'r', agentId: 'pi', createdAt: 1, status, events }] }).snapshot)
        .toMatchObject({ state: 'unknown', reason: 'not-reported' });
    }
    expect(selectContextUsage({ ...args, runs: [{ id: 'r', agentId: 'pi', createdAt: 1, status: 'running', events }] }).snapshot)
      .toMatchObject({ state: 'unknown', reason });
  });

  it('leaves a final measurement or not-reported marker alone at run end', () => {
    for (const reason of [undefined, 'not-reported', 'session-changed', 'invalid-data']) expect(contextUsageAtRunEnd(reason, 'm')).toBeNull();
  });

  it('does not restore malformed or unidentified persisted measurements as confirmed usage', () => {
    const snapshot = buildCodexContextUsage({ last: { totalTokens: 10 }, modelContextWindow: 100 }, 'm', 's', 1);
    expect(readContextUsageSnapshot({ ...snapshot, usedTokens: null })).toBeNull();
    expect(readContextUsageSnapshot({ ...snapshot, source: 'none' })).toBeNull();
    expect(readContextUsageSnapshot({ ...snapshot, reason: 'invalid-reason' })).toBeNull();
    expect(selectContextUsage({ projectId: 'p', conversationId: 'c', agentId: 'codex', model: 'm', runs: [],
      persisted: { id: 'r', agentId: null, createdAt: 1, events: [{ kind: 'context_usage', snapshot }] }, now: 2 }).snapshot)
      .toMatchObject({ state: 'unknown', reason: 'session-changed' });
  });

  it('selects by run creation rather than a late canceled run snapshot timestamp', () => {
    const old = buildPiContextUsage({ contextUsage: { tokens: 50, contextWindow: 200 } }, { model: 'm', sessionId: 'old', now: 999 });
    const current = makeUnknownContextUsage('run-started', 'm', null, 10);
    const response = selectContextUsage({ projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'm', runs: [
      { id: 'old', agentId: 'pi', createdAt: 1, events: [{ event: 'agent', data: { type: 'context_usage', snapshot: old } }] },
      { id: 'new', agentId: 'pi', createdAt: 10, events: [{ event: 'agent', data: { type: 'context_usage', snapshot: current } }] },
    ], now: 20 });
    expect(response).toMatchObject({ runId: 'new', snapshot: { state: 'unknown', usedTokens: null, reason: 'run-started' } });
  });

  it('restores persisted snapshots and respects explicit compaction reset, agent and model changes', () => {
    const snapshot = buildPiContextUsage({ contextUsage: { tokens: 50, contextWindow: 200 } }, { model: 'm', sessionId: 's', now: 1 });
    const args = { projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'm', runs: [], now: 5,
      persisted: { id: 'run-a', agentId: 'pi', createdAt: 1, events: [{ kind: 'context_usage', snapshot }] } };
    expect(selectContextUsage(args).snapshot).toEqual(snapshot);
    expect(selectContextUsage({ ...args, model: 'other' }).snapshot).toMatchObject({ state: 'unknown', reason: 'model-changed' });
    expect(selectContextUsage({ ...args, agentId: 'codex' }).snapshot).toMatchObject({ state: 'unknown', reason: 'session-changed' });
    args.persisted.events.push({ kind: 'context_usage', snapshot: makeUnknownContextUsage('compacted', 'm', 's', 2) });
    const live = { ...args.persisted, status: 'running', events: [] };
    expect(selectContextUsage({ ...args, runs: [live] }).snapshot).toMatchObject({ state: 'unknown', reason: 'compacted' });
  });
});
