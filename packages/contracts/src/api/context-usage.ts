/** Context occupancy for one runtime session, never accumulated billing usage. */
export interface ContextUsageSnapshot {
  state: 'measured' | 'estimated' | 'unknown';
  /** Counts are safe integers in tokens. Null is unknown, not zero. */
  usedTokens: number | null;
  limitTokens: number | null;
  source: 'codex' | 'pi' | 'none';
  limitSource: 'runtime' | 'metadata' | 'model-table' | 'advertised' | 'default' | 'unknown';
  model: string | null;
  sessionId: string | null;
  updatedAt: number;
  reason?: 'not-reported' | 'run-started' | 'compacting' | 'compacted' | 'model-changed' | 'session-changed' | 'invalid-data';
}

export interface ContextUsageResponse {
  projectId: string;
  conversationId: string;
  agentId: string;
  runId: string | null;
  snapshot: ContextUsageSnapshot;
}
