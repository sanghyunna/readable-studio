import type { ApiError, DatabricksErrorCode } from '../errors.js';
import type { AgentModelOption } from './registry.js';

/**
 * User-facing responses may carry real profile, workspace, service and model names
 * in display labels. IDs remain opaque call/storage handles. Never copy display
 * labels into logs, diagnostics, analytics, app config or generated Pi files.
 * Credentials, filesystem paths and arbitrary upstream bodies are never returned;
 * producers explicitly project the permitted fields at the transport boundary.
 */
export type DatabricksAuthState =
  | 'unchecked'
  | 'authenticated'
  | 'auth-required'
  | 'unsupported-auth'
  | 'keyring-unavailable'
  | 'unreachable';

export type DatabricksScanState =
  | 'queued'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type DatabricksAvailability =
  | 'compatible'
  | 'verification-required'
  | 'unavailable'
  | 'stale';

export type DatabricksEndpointKind = 'serving-endpoint' | 'uc-model-service';
export type DatabricksEndpointApi = 'openai-completions' | 'anthropic-messages' | null;
export type DatabricksCapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface DatabricksCapabilities {
  /** Learned on tested endpoint routes; unsupported selects complete-document chat delivery, not direct file edits. */
  tools: DatabricksCapabilityState;
  images: DatabricksCapabilityState;
  /** Null means unknown, never the runtime's fallback budget. */
  contextWindow: number | null;
  maxTokens: number | null;
  /** Optional only for catalogues/clients predating automatic limit discovery. */
  limitSources?: {
    contextWindow: 'metadata' | 'model-table' | 'unknown';
    maxTokens: 'metadata' | 'model-table' | 'unknown' | 'endpoint';
  };
}

export interface DatabricksProfile {
  id: string;
  label: string;
  workspaceLabel: string;
  /** Real CLI profile name, or a workspace connection label for token setup. */
  displayName?: string;
  /** Real workspace origin, for the user's screen only. */
  workspaceDisplayLabel?: string;
  isDefault: boolean;
  auth: DatabricksAuthState;
}

export type DatabricksIssueAction =
  | 'install-cli'
  | 'choose-executable'
  | 'sign-in'
  | 'rescan'
  | 'verify'
  | 'check-permissions'
  | 'none';

export interface DatabricksIssue {
  code: DatabricksErrorCode;
  action: DatabricksIssueAction;
  retryable: boolean;
}

export interface DatabricksEndpoint {
  id: string;
  profileId: string;
  /** Preferred model label: served model when known, otherwise service name. */
  label: string;
  /** Real schema-qualified UC service name, or the serving endpoint's own name. */
  displayName?: string;
  /** Underlying served model name(s), only when exposed by metadata. */
  servedModelName?: string;
  kind: DatabricksEndpointKind;
  availability: DatabricksAvailability;
  api: DatabricksEndpointApi;
  /** Allowlisted wire evidence only; absent on older catalogues (rescan to refresh). */
  protocolEvidence?: {
    advertised: string[];
    native: string[];
    reason: 'native-api' | 'advertised-api' | 'prefer-messages' | 'chat-task' | 'unresolved' | 'runtime-accepted';
  };
  /** Registered with Readable, not selected or enabled remotely. */
  enabled: boolean;
  /** Opaque app provider/model alias, never the upstream model selector. */
  appModelId?: string;
  reasoningOptions?: Array<Pick<AgentModelOption, 'id' | 'label'>>;
  capabilities: DatabricksCapabilities;
  evidence: 'metadata' | 'recipe' | 'verified';
  issue?: DatabricksIssue;
}

export type DatabricksCliState = 'missing' | 'ready' | 'unsupported' | 'uninvocable';

export type DatabricksConnectionMode = 'cli-profile' | 'workspace-token';

/** Credentials are write-only and never echoed by setup. */
export interface DatabricksSetupRequest {
  mode: DatabricksConnectionMode;
  host?: string;
  token?: string;
  profileId?: string;
}

/** Browser SSO is owned by the installed CLI; no credentials cross this contract. */
export interface DatabricksLoginRequest { host: string; }
export type DatabricksLoginState = 'starting' | 'waiting-for-browser' | 'authenticated' | 'cancelled' | 'timed-out' | 'failed';
export interface DatabricksLoginResponse {
  loginId: string;
  state: DatabricksLoginState;
  createdAt: string;
  deadlineAt: string;
  completedAt: string | null;
  /** Available only after the CLI authentication state has been verified. */
  profileId: string | null;
  issues: DatabricksIssue[];
}

export interface DatabricksSetupResponse {
  /** The connection just validated by setup, ready for an immediate scan. */
  profile: DatabricksProfile;
  status: DatabricksStatusResponse;
}

export interface DatabricksStatusResponse {
  /** Setup is separate from availability of the bundled execution harness. */
  setupRequired?: boolean;
  cli: DatabricksCliState;
  /** Absent on older daemons; null when no executable was selected. Never a path. */
  cliSource?: 'override' | 'path' | 'bundled' | null;
  version: string | null;
  auth: DatabricksAuthState;
  profiles: DatabricksProfile[];
  enabledCount: number;
  issues: DatabricksIssue[];
}

export interface DatabricksProbeRequest {
  /** Omit to discover profiles; provide to validate one discovered profile. */
  profileId?: string;
}

export interface DatabricksProfilesResponse {
  profiles: DatabricksProfile[];
  issues: DatabricksIssue[];
}

export interface DatabricksClientRequest {
  /** Opaque privately resolved executable reference; null clears the override. */
  executableId: string | null;
}

export interface DatabricksScanRequest {
  profileId: string;
  /** Previously discovered opaque scope IDs, never catalog/schema names. */
  scopeIds?: string[];
}

export interface DatabricksScanPageRequest {
  /** Daemon-owned cursor, never an upstream continuation token. */
  cursor?: string;
  limit?: number;
}

export interface DatabricksScanCounters {
  scopesChecked: number;
  scopesInaccessible: number;
  candidates: number;
  excluded: number;
}

export interface DatabricksScanCompleteness {
  /** Enumeration finished for the requested serving branch. */
  serving: boolean;
  /** Enumeration finished for the requested Unity Catalog scopes. */
  uc: boolean;
  /** A budget, page or resource ceiling prevented full enumeration. */
  truncated: boolean;
}

export interface DatabricksScanResponse {
  scanId: string;
  profileId: string;
  revision: number;
  state: DatabricksScanState;
  /** ISO 8601 timestamps; null until the corresponding transition occurs. */
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  endpoints: DatabricksEndpoint[];
  /** Next page cursor; null means this snapshot has no further page. */
  cursor: string | null;
  counters: DatabricksScanCounters;
  /** Complete enumeration does not guarantee every readable resource was listed. */
  completeness: DatabricksScanCompleteness;
  issues: DatabricksIssue[];
}

/** Replayable SSE/NDJSON events; revision is the monotonic event sequence. */
export type DatabricksScanEvent =
  | { type: 'snapshot'; revision: number; scan: DatabricksScanResponse }
  | {
      type: 'progress';
      scanId: string;
      revision: number;
      state: DatabricksScanState;
      counters: DatabricksScanCounters;
      completeness: DatabricksScanCompleteness;
      issues: DatabricksIssue[];
    }
  | { type: 'endpoint'; scanId: string; revision: number; endpoint: DatabricksEndpoint }
  | { type: 'done'; revision: number; scan: DatabricksScanResponse };

export interface DatabricksLookupRequest {
  profileId: string;
  /** Opaque reference to owner-supplied identity resolved privately, not an FQN. */
  resourceId: string;
  kind: DatabricksEndpointKind;
}

export interface DatabricksEndpointResponse {
  endpoint: DatabricksEndpoint;
  /** Lookup candidates share the scan revision store used by enable/verify. */
  scanId: string;
  revision: number;
}

export interface DatabricksEnableRequest {
  scanId: string;
  expectedRevision: number;
}

export interface DatabricksDisableRequest {
  expectedRevision: number;
}

export interface DatabricksVerifyRequest extends DatabricksEnableRequest {
  /** Explicit consent: discovery and registration never perform paid inference. */
  allowInference: true;
}

export interface DatabricksModelsRequest {
  profileId?: string;
}

export interface DatabricksRegisteredEndpoint extends DatabricksEndpoint {
  enabled: true;
  appModelId: string;
}

export interface DatabricksModelResponse {
  endpoint: DatabricksRegisteredEndpoint;
  appModelId: string;
  revision: number;
}

export interface DatabricksModelsResponse {
  models: DatabricksRegisteredEndpoint[];
  revision: number;
  issues: DatabricksIssue[];
}

export type DatabricksVerificationState = 'passed' | 'failed' | 'inconclusive';
export type DatabricksVerificationCheck = DatabricksVerificationState | 'not-run';

export interface DatabricksVerificationResponse {
  endpoint: DatabricksEndpoint;
  scanId: string;
  revision: number;
  result: DatabricksVerificationState;
  checks: {
    streaming: DatabricksVerificationCheck;
    tools: DatabricksVerificationCheck;
    effort: DatabricksVerificationCheck;
  };
  issue?: DatabricksIssue;
}

export type DatabricksFailureReason =
  | 'auth' | 'permission-denied' | 'model-not-found' | 'bad-request' | 'rate-limit'
  | 'upstream-server' | 'upstream-rejected' | 'transport' | 'relay' | 'invalid-response'
  | 'runtime-unavailable' | 'runtime-storage' | 'configuration';

export interface DatabricksFailureDetail {
  reason: DatabricksFailureReason;
  /** Null means no upstream HTTP response was received, not HTTP 502. */
  upstreamStatus: number | null;
  message: string;
  retryable: boolean;
  /** Only positively recognized, identity-free upstream diagnostics. */
  upstreamMessage?: string;
}

/** Shared API envelope restricted to sanitized messages and no generic details. */
export interface DatabricksError extends Pick<ApiError, 'message' | 'retryable' | 'requestId' | 'taskId'> {
  code: DatabricksErrorCode;
  reason?: DatabricksFailureReason;
  upstreamStatus?: number | null;
  upstreamMessage?: string;
}

export interface DatabricksErrorResponse {
  error: DatabricksError;
}
