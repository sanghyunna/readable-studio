export { storedAgentScanSchema, type StoredAgentScan } from './agent-scan-storage.js';

export type AgentScanProgress = {
  readonly phase: 'running' | 'done' | 'cancelled' | 'failed';
  readonly currentAgentId: string | null;
  readonly currentAgentName: string | null;
  readonly completed: number;
  readonly total: number;
};

export type AgentScanResponse = {
  readonly scan: AgentScanProgress | null;
};
