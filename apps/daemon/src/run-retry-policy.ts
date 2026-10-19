import type {
  TrackingRunFailureCategory,
  TrackingRunFailureDetail,
  TrackingRunFailureStage,
  TrackingRunRetryStrategy,
  TrackingRunRetrySuppressedReason,
  TrackingRunResult,
} from '@readable-studio/contracts/analytics';

// Counts retries, excluding the initial execution (eleven executions total).
export const DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS = 10;
export const SAFE_RUN_RETRY_DELAY_MS = 5000;
export const SAFE_RUN_RETRY_STRATEGY: TrackingRunRetryStrategy = 'same_run_transient';

export function safeRunRetryDelayMs(retryAfter?: string | null, nowMs = Date.now()): number {
  if (!retryAfter?.trim()) return SAFE_RUN_RETRY_DELAY_MS;
  const value = retryAfter.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - nowMs;
  return delay >= SAFE_RUN_RETRY_DELAY_MS && delay <= 60000
    ? delay
    : SAFE_RUN_RETRY_DELAY_MS;
}

export interface RunRetryFailureSignal {
  failure_category?: TrackingRunFailureCategory;
  failure_detail?: TrackingRunFailureDetail;
  failure_stage?: TrackingRunFailureStage;
  retryable?: boolean;
  retry_after?: string;
}

export interface RunRetrySideEffectState {
  cancelRequested?: boolean;
  userVisibleOutputSeen?: boolean;
  toolCallSeen?: boolean;
  artifactWriteSeen?: boolean;
}

export interface RunRetryPolicyInput {
  result: TrackingRunResult;
  agentId?: string;
  failure?: RunRetryFailureSignal;
  attemptCount: number;
  maxAttempts?: number;
  sideEffects?: RunRetrySideEffectState;
}

export type RunRetryPolicyDecision =
  | {
      shouldRetry: true;
      retryAttemptIndex: number;
      retryMaxAttempts: number;
      retryStrategy: TrackingRunRetryStrategy;
      retryReason: 'transient_failure';
    }
  | {
      shouldRetry: false;
      retryAttemptIndex: number;
      retryMaxAttempts: number;
      retryStrategy: TrackingRunRetryStrategy;
      retrySuppressedReason: TrackingRunRetrySuppressedReason;
    };

function normalizeAttemptCount(attemptCount: number): number {
  if (!Number.isFinite(attemptCount) || attemptCount < 0) return 0;
  return Math.floor(attemptCount);
}

function normalizeMaxAttempts(maxAttempts: number | undefined): number {
  if (maxAttempts === undefined) return DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 0) return 0;
  return Math.floor(maxAttempts);
}

function isTransientRetryCategory(
  category: TrackingRunFailureCategory | undefined,
  detail: TrackingRunFailureDetail | undefined,
  stage: TrackingRunFailureStage | undefined,
  agentId: string | undefined,
): boolean {
  if (category === 'rate_limit') return detail !== 'hard_quota';
  // Databricks owns credential refresh and retains its original outer
  // eligibility, not just its original one-retry budget.
  if (category === 'auth') return agentId !== 'databricks' && detail !== 'missing_api_key';
  if (category === 'upstream_unavailable') return true;
  if (category === 'empty_output') return stage === undefined || stage === 'first_token_wait';
  if (category === 'timeout') return agentId !== 'databricks' || stage === 'first_token_wait';
  return false;
}

export function decideSafeRunRetry(
  input: RunRetryPolicyInput,
): RunRetryPolicyDecision {
  const attemptCount = normalizeAttemptCount(input.attemptCount);
  const retryMaxAttempts = normalizeMaxAttempts(input.maxAttempts);
  const retryAttemptIndex = attemptCount + 1;
  const base = {
    retryAttemptIndex,
    retryMaxAttempts,
    retryStrategy: SAFE_RUN_RETRY_STRATEGY,
  };
  const suppress = (
    retrySuppressedReason: TrackingRunRetrySuppressedReason,
  ): RunRetryPolicyDecision => ({
    ...base,
    shouldRetry: false,
    retrySuppressedReason,
  });

  if (input.result !== 'failed') return suppress('not_failed');

  const sideEffects = input.sideEffects ?? {};
  if (sideEffects.cancelRequested) return suppress('cancel_requested');

  const failure = input.failure;
  if (failure?.failure_detail === 'hard_quota') return suppress('hard_quota');
  if (
    failure?.failure_category !== undefined &&
    !isTransientRetryCategory(
      failure.failure_category,
      failure.failure_detail,
      failure.failure_stage,
      input.agentId,
    )
  ) {
    return suppress('unsupported_category');
  }
  if (!failure?.retryable) return suppress('not_retryable');
  if (
    !isTransientRetryCategory(
      failure.failure_category,
      failure.failure_detail,
      failure.failure_stage,
      input.agentId,
    )
  ) {
    return suppress('unsupported_category');
  }
  if (attemptCount >= retryMaxAttempts) return suppress('attempt_limit_reached');
  if (sideEffects.userVisibleOutputSeen) return suppress('user_visible_output_seen');
  if (sideEffects.toolCallSeen) return suppress('tool_call_seen');
  if (sideEffects.artifactWriteSeen) return suppress('artifact_write_seen');

  return {
    ...base,
    shouldRetry: true,
    retryReason: 'transient_failure',
  };
}
