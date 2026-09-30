import type { DatabricksEndpointApi, DatabricksEndpointKind, DatabricksVerificationResponse } from './databricks.js';

/** Explicit consent: at most three 256-token transport attempts, plus one optional reasoning attempt per name. */
export interface DatabricksNamedScanRequest {
  readonly profileId: string;
  /** Comma/CR/LF separated exact identities; 1-20 unique names, 256 characters each. */
  readonly names: string;
  readonly allowInference: true;
  readonly checkReasoning?: boolean;
  readonly kindHint?: 'auto' | DatabricksEndpointKind;
  readonly apiHint?: 'auto' | Exclude<DatabricksEndpointApi, null>;
}

export const DATABRICKS_NAMED_REASONS = [
  'name-not-found', 'not-found-or-hidden', 'not-entitled', 'not-invocable', 'permission-denied',
  'workspace-unreachable', 'auth-failed', 'unsupported-task', 'request-incompatible',
  'rate-limited', 'upstream-failed', 'incomplete-response', 'cancelled',
] as const;
export type DatabricksNamedReason = typeof DATABRICKS_NAMED_REASONS[number];
export interface DatabricksNamedFailure {
  readonly reason: DatabricksNamedReason;
  readonly upstreamStatus: number | null;
  readonly action: 'correct-name' | 'check-name-or-permissions' | 'request-entitlement' | 'request-invoke-permission' | 'reconnect' | 'check-network' | 'change-api' | 'retry';
}
export interface DatabricksNamedInputResult {
  /** Index in the deduplicated, trimmed input list; preserves first occurrence order. */
  readonly inputIndex: number;
  /** Display only; never an opaque ID or an origin. */
  readonly displayName: string;
  readonly state: 'pending' | 'verified' | 'chat-only' | 'already-registered' | 'failed' | 'inconclusive';
  readonly endpointId?: string;
  readonly failure?: DatabricksNamedFailure;
  readonly checks?: DatabricksVerificationResponse['checks'];
  readonly attempts: number;
}

export class DatabricksNamesError extends Error {
  constructor(readonly reason: 'empty' | 'too-many' | 'invalid-name') { super(reason); }
}
/** Shared pure parser, not a general-purpose opaque-ID validator. */
export function parseDatabricksNames(text: string): string[] {
  const names = [...new Set(text.split(/[,\r\n]/).map(name => name.trim()).filter(Boolean))];
  if (!names.length) throw new DatabricksNamesError('empty');
  if (names.length > 20) throw new DatabricksNamesError('too-many');
  if (names.some(name => name.length > 256 || /[\s\x00-\x1f\x7f/\\?#%:]/u.test(name) || name.split('.').some(part => !part))) {
    throw new DatabricksNamesError('invalid-name');
  }
  return names;
}
