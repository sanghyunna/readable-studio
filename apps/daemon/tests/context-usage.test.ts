import { describe, expect, it } from 'vitest';
import { buildCodexContextUsage, buildPiContextUsage, makeUnknownContextUsage, readContextUsageSnapshot, selectContextUsage } from '../src/context-usage.js';

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

  it('rejects invalid token units and unconfirmed advertised limits', () => {
    expect(buildCodexContextUsage({ modelContextWindow: -1, last: { totalTokens: 2.5 } }, 'm', 's', 1))
      .toMatchObject({ state: 'unknown', usedTokens: null, limitTokens: null });
    expect(buildPiContextUsage({ contextUsage: { tokens: 12, contextWindow: 1_000_000 } },
      { model: 'm', sessionId: 's', limit: { tokens: 1_000_000, source: 'advertised' }, now: 1 }))
      .toMatchObject({ state: 'estimated', usedTokens: 12, limitTokens: null });
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
    expect(selectContextUsage(args).snapshot).toMatchObject({ state: 'unknown', reason: 'compacted' });
  });
});
