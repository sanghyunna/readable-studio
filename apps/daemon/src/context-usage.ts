import type { ContextUsageResponse, ContextUsageSnapshot } from '@readable-studio/contracts';

type ContextLimit = { tokens: number | null; source: ContextUsageSnapshot['limitSource'] };
type ContextIdentity = { model: string | null; sessionId: string | null; now?: number };
export interface ContextUsageRun {
  id: string;
  agentId: string | null;
  createdAt: number;
  events: unknown[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function tokens(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function confirmedLimit(limit: ContextLimit): number | null {
  return limit.source === 'runtime' || limit.source === 'metadata' || limit.source === 'model-table'
    ? tokens(limit.tokens, 1) : null;
}

export function makeUnknownContextUsage(
  reason: NonNullable<ContextUsageSnapshot['reason']>,
  model: string | null = null,
  sessionId: string | null = null,
  now = Date.now(),
): ContextUsageSnapshot {
  return { state: 'unknown', usedTokens: null, limitTokens: null, source: 'none',
    limitSource: 'unknown', model, sessionId, updatedAt: now, reason };
}

/** Codex `last` is one model response; `total` accumulates billed work across responses. */
export function buildCodexContextUsage(
  tokenUsage: unknown, model: string | null, sessionId: string | null, now = Date.now(),
): ContextUsageSnapshot {
  const usage = record(tokenUsage);
  const last = record(usage.last);
  const input = tokens(last.inputTokens);
  const output = tokens(last.outputTokens);
  const usedTokens = tokens(last.totalTokens) ?? (input !== null && output !== null ? tokens(input + output) : null);
  const limitTokens = tokens(usage.modelContextWindow, 1);
  return { state: usedTokens === null ? 'unknown' : 'measured', usedTokens, limitTokens,
    source: 'codex', limitSource: limitTokens === null ? 'unknown' : 'runtime', model, sessionId,
    updatedAt: now, ...(usedTokens === null ? { reason: 'not-reported' as const } : {}) };
}

/** Pi SDK labels getContextUsage() as an estimate, including trailing messages after its last usage. */
export function buildPiContextUsage(stats: unknown, options: ContextIdentity & { limit?: ContextLimit }): ContextUsageSnapshot {
  const usage = record(record(stats).contextUsage);
  const usedTokens = tokens(usage.tokens);
  const limit = options.limit ?? { tokens: tokens(usage.contextWindow, 1), source: 'runtime' };
  return { state: usedTokens === null ? 'unknown' : 'estimated', usedTokens,
    limitTokens: confirmedLimit(limit), source: 'pi', limitSource: limit.source,
    model: options.model, sessionId: options.sessionId, updatedAt: options.now ?? Date.now(),
    ...(usedTokens === null ? { reason: 'not-reported' as const } : {}) };
}

export function readContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  const snapshot = record(value);
  if (!['measured', 'estimated', 'unknown'].includes(String(snapshot.state))
    || !['codex', 'pi', 'none'].includes(String(snapshot.source))
    || !['runtime', 'metadata', 'model-table', 'advertised', 'default', 'unknown'].includes(String(snapshot.limitSource))
    || (snapshot.usedTokens !== null && tokens(snapshot.usedTokens) === null)
    || (snapshot.state !== 'unknown' && (snapshot.usedTokens === null || snapshot.source === 'none'))
    || (snapshot.limitTokens !== null && tokens(snapshot.limitTokens, 1) === null)
    || (snapshot.model !== null && typeof snapshot.model !== 'string')
    || (snapshot.sessionId !== null && typeof snapshot.sessionId !== 'string')
    || tokens(snapshot.updatedAt) === null
    || (snapshot.reason !== undefined && !['not-reported', 'run-started', 'compacting', 'compacted', 'model-changed', 'session-changed', 'invalid-data'].includes(String(snapshot.reason)))) return null;
  const typed = snapshot as unknown as ContextUsageSnapshot;
  return { state: typed.state, source: typed.source, model: typed.model, sessionId: typed.sessionId,
    usedTokens: typed.state === 'unknown' ? null : typed.usedTokens,
    limitTokens: confirmedLimit({ tokens: typed.limitTokens, source: typed.limitSource }),
    limitSource: typed.limitSource, updatedAt: typed.updatedAt, ...(typed.reason ? { reason: typed.reason } : {}) };
}

export function selectContextUsage(options: {
  projectId: string; conversationId: string; agentId: string; model?: string | null;
  persisted?: ContextUsageRun | null; runs: ContextUsageRun[]; now?: number;
}): ContextUsageResponse {
  const { projectId, conversationId, agentId, model, persisted } = options;
  const latest = options.runs.reduce<ContextUsageRun | null>((current, run) =>
    !current || run.createdAt >= current.createdAt ? run : current, persisted ?? null);
  const unknown = (reason: NonNullable<ContextUsageSnapshot['reason']>) =>
    makeUnknownContextUsage(reason, model ?? null, null, options.now);
  let snapshot = unknown('not-reported');
  if (latest && latest.agentId !== agentId) snapshot = unknown('session-changed');
  else if (latest) {
    const events = latest.id === persisted?.id ? [...persisted.events, ...latest.events] : latest.events;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = record(events[index]);
      const payload = event.event === 'agent' ? record(event.data) : event;
      if (payload.type !== 'context_usage' && payload.kind !== 'context_usage') continue;
      snapshot = readContextUsageSnapshot(payload.snapshot) ?? unknown('invalid-data');
      break;
    }
    if (model && snapshot.model !== model) snapshot = unknown('model-changed');
  }
  return { projectId, conversationId, agentId, runId: latest?.id ?? null, snapshot };
}
