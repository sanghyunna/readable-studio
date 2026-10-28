import { expect, it, vi } from 'vitest';
import { getContextUsageRoute } from '../src/context-usage-routes.js';
import { buildCodexContextUsage, makeUnknownContextUsage } from '../src/context-usage.js';

it('rejects missing/array selectors at the HTTP boundary', () => {
  const raw = { body: {}, params: { projectId: 'p', conversationId: 'c' }, query: {} };
  expect(getContextUsageRoute.parse(raw).ok).toBe(false);
  expect(getContextUsageRoute.parse({ ...raw, query: { agentId: ['pi', 'codex'] } }).ok).toBe(false);
  expect(getContextUsageRoute.parse({ ...raw, query: { agentId: 'pi', model: ['a', 'b'] } }).ok).toBe(false);
});

it('does not read another project conversation and restores only the latest run', async () => {
  const input = { projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'opus' };
  const snapshot = buildCodexContextUsage({ last: { totalTokens: 40 }, modelContextWindow: 100 }, 'opus', 's', 5);
  const events = [{ kind: 'context_usage', snapshot }];
  const latestPersistedRun = vi.fn(() => ({ id: 'r', agentId: 'pi', createdAt: 1, events }));
  const deps = { getConversationProject: () => 'other-project', latestPersistedRun, listRuns: () => [] };
  expect((await getContextUsageRoute.handle(input, deps)).ok).toBe(false);
  expect(latestPersistedRun).not.toHaveBeenCalled();
  const result = await getContextUsageRoute.handle(input, { ...deps, getConversationProject: () => 'p' });
  expect(result).toEqual({ ok: true, value: { projectId: 'p', conversationId: 'c', agentId: 'pi', runId: 'r', snapshot } });
  // A persisted run is no longer live, so its compaction marker can never be replaced.
  events.push({ kind: 'context_usage', snapshot: makeUnknownContextUsage('compacted', 'opus', 's', 6) });
  expect(await getContextUsageRoute.handle(input, { ...deps, getConversationProject: () => 'p' })).toMatchObject({ ok: true,
    value: { runId: 'r', snapshot: { state: 'unknown', usedTokens: null, reason: 'not-reported' } } });
});
