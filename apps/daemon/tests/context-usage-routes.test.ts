import { expect, it, vi } from 'vitest';
import { getContextUsageRoute } from '../src/context-usage-routes.js';
import { makeUnknownContextUsage } from '../src/context-usage.js';

it('rejects missing/array selectors at the HTTP boundary', () => {
  const raw = { body: {}, params: { projectId: 'p', conversationId: 'c' }, query: {} };
  expect(getContextUsageRoute.parse(raw).ok).toBe(false);
  expect(getContextUsageRoute.parse({ ...raw, query: { agentId: ['pi', 'codex'] } }).ok).toBe(false);
  expect(getContextUsageRoute.parse({ ...raw, query: { agentId: 'pi', model: ['a', 'b'] } }).ok).toBe(false);
});

it('does not read another project conversation and restores only the latest run', async () => {
  const input = { projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'opus' };
  const snapshot = makeUnknownContextUsage('compacted', 'opus', 's', 5);
  const latestPersistedRun = vi.fn(() => ({ id: 'r', agentId: 'pi', createdAt: 1, events: [{ kind: 'context_usage', snapshot }] }));
  const deps = { getConversationProject: () => 'other-project', latestPersistedRun, listRuns: () => [] };
  expect((await getContextUsageRoute.handle(input, deps)).ok).toBe(false);
  expect(latestPersistedRun).not.toHaveBeenCalled();
  const result = await getContextUsageRoute.handle(input, { ...deps, getConversationProject: () => 'p' });
  expect(result).toEqual({ ok: true, value: { projectId: 'p', conversationId: 'c', agentId: 'pi', runId: 'r', snapshot } });
});
