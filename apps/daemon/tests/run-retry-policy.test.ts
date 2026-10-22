import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS,
  SAFE_RUN_RETRY_STRATEGY,
  SAFE_RUN_RETRY_DELAY_MS,
  safeRunRetryDelayMs,
  decideSafeRunRetry,
  type RunRetryPolicyInput,
} from '../src/run-retry-policy.js';

function decide(input: Partial<RunRetryPolicyInput> = {}) {
  return decideSafeRunRetry({
    result: 'failed',
    attemptCount: 0,
    failure: {
      failure_category: 'upstream_unavailable',
      failure_detail: 'upstream_5xx',
      failure_stage: 'first_token_wait',
      retryable: true,
    },
    ...input,
  });
}

describe('decideSafeRunRetry', () => {
  it('keeps Databricks outer retry categories at their original boundary', () => {
    for (const agentId of ['claude', 'databricks']) {
      expect(decide({
        agentId,
        failure: { failure_category: 'auth', failure_detail: 'permission_denied', retryable: true },
      }).shouldRetry).toBe(agentId === 'claude');
      expect(decide({
        agentId,
        failure: { failure_category: 'auth', failure_detail: 'auth_required', retryable: true },
      }).shouldRetry).toBe(agentId === 'claude');
      expect(decide({
        agentId,
        failure: { failure_category: 'timeout', failure_stage: 'tool_execution', retryable: true },
      }).shouldRetry).toBe(agentId === 'claude');
    }
    expect(decide({
      agentId: 'databricks', maxAttempts: 1,
      failure: { failure_category: 'timeout', failure_stage: 'first_token_wait', retryable: true },
    }).shouldRetry).toBe(true);
    expect(decide({ agentId: 'databricks', maxAttempts: 1 }).shouldRetry).toBe(true);
    expect(decide({ agentId: 'databricks', maxAttempts: 1, attemptCount: 1 }).shouldRetry).toBe(false);
    expect(decide({ agentId: 'databricks', sideEffects: { userVisibleOutputSeen: true } })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'user_visible_output_seen',
    });
  });

  it('allows retryable transient upstream failures before side effects', () => {
    expect(decide()).toEqual({
      shouldRetry: true,
      retryAttemptIndex: 1,
      retryMaxAttempts: DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS,
      retryStrategy: SAFE_RUN_RETRY_STRATEGY,
      retryReason: 'transient_failure',
    });
  });

  it('allows ordinary retryable 429 rate limits but suppresses hard quota', () => {
    expect(
      decide({
        failure: {
          failure_category: 'rate_limit',
          failure_detail: 'rate_limit_429',
          failure_stage: 'session_init',
          retryable: true,
        },
      }).shouldRetry,
    ).toBe(true);

    expect(
      decide({
        failure: {
          failure_category: 'rate_limit',
          failure_detail: 'hard_quota',
          failure_stage: 'session_init',
          retryable: false,
        },
      }),
    ).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'hard_quota',
    });
  });

  it('allows empty output and first-token timeout failures', () => {
    expect(
      decide({
        failure: {
          failure_category: 'empty_output',
          failure_detail: 'empty_output',
          failure_stage: 'first_token_wait',
          retryable: true,
        },
      }).shouldRetry,
    ).toBe(true);

    expect(
      decide({
        failure: {
          failure_category: 'timeout',
          failure_detail: 'inactivity_timeout',
          failure_stage: 'first_token_wait',
          retryable: true,
        },
      }).shouldRetry,
    ).toBe(true);
  });

  it('does not retry successful or cancelled terminal results', () => {
    expect(decide({ result: 'success' })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'not_failed',
    });
    expect(decide({ result: 'cancelled' })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'not_failed',
    });
  });

  it('requires the classifier retryable signal', () => {
    expect(
      decide({
        failure: {
          failure_category: 'upstream_unavailable',
          failure_detail: 'upstream_5xx',
          failure_stage: 'first_token_wait',
          retryable: false,
        },
      }),
    ).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'not_retryable',
    });
  });

  it('suppresses non-transient categories even when the classifier marks them retryable', () => {
    for (const failure_category of [
      'prompt_too_large',
      'model_unavailable',
      'tool_error',
      'process_exit',
      'unknown',
    ] as const) {
      expect(
        decide({
          failure: {
            failure_category,
            failure_stage: 'tool_execution',
            retryable: true,
          },
        }),
      ).toMatchObject({
        shouldRetry: false,
        retrySuppressedReason: 'unsupported_category',
      });
    }
  });

  it('allows ten retries and stops after the eleventh execution', () => {
    expect(DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS).toBe(10);
    expect(decide({ attemptCount: 0 })).toMatchObject({
      shouldRetry: true,
      retryAttemptIndex: 1,
      retryMaxAttempts: DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS,
    });
    expect(decide({ attemptCount: 9 })).toMatchObject({
      shouldRetry: true,
      retryAttemptIndex: 10,
      retryMaxAttempts: 10,
    });
    expect(decide({ attemptCount: 10 })).toMatchObject({
      shouldRetry: false,
      retryAttemptIndex: 11,
      retryMaxAttempts: DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS,
      retrySuppressedReason: 'attempt_limit_reached',
    });
  });

  it('stops at the configured attempt limit', () => {
    expect(decide({ attemptCount: 1, maxAttempts: 2 })).toMatchObject({
      shouldRetry: true,
      retryAttemptIndex: 2,
      retryMaxAttempts: 2,
    });
    expect(decide({ attemptCount: 2, maxAttempts: 2 })).toMatchObject({
      shouldRetry: false,
      retryAttemptIndex: 3,
      retryMaxAttempts: 2,
      retrySuppressedReason: 'attempt_limit_reached',
    });
  });

  it('continues visible text and requires native resume after tools or artifact writes', () => {
    expect(decide({ sideEffects: { userVisibleOutputSeen: true } })).toMatchObject({
      shouldRetry: true,
    });
    expect(decide({ sideEffects: { toolCallSeen: true } })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'tool_call_seen',
    });
    expect(decide({ sideEffects: { artifactWriteSeen: true } })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'artifact_write_seen',
    });
    expect(decide({ sideEffects: { toolCallSeen: true, nativeResumeAvailable: true } })).toMatchObject({
      shouldRetry: true,
    });
    expect(decide({ sideEffects: { artifactWriteSeen: true, nativeResumeAvailable: true } })).toMatchObject({
      shouldRetry: true,
    });
  });

  it('suppresses retries when cancellation was requested', () => {
    expect(decide({ sideEffects: { cancelRequested: true } })).toMatchObject({
      shouldRetry: false,
      retrySuppressedReason: 'cancel_requested',
    });
  });

  it('never auto-retries process kills, crashes, or interruptions', () => {
    for (const failure_detail of [
      'signal_killed',
      'process_crashed',
      'interrupted',
    ] as const) {
      expect(
        decide({
          failure: {
            failure_category: 'process_exit',
            failure_detail,
            failure_stage: 'child_close',
            retryable: false,
          },
        }).shouldRetry,
      ).toBe(false);
    }
  });
});

describe('safeRunRetryDelayMs', () => {
  const now = Date.UTC(2026, 9, 19);

  it.each([
    [undefined, 5000], [null, 5000], ['', 5000],
    ['5', 5000], ['60', 60000], ['5.5', 5500], ['30', 30000],
    ['4.999', 5000], ['60.001', 5000], ['0', 5000], ['-5', 5000],
    ['NaN', 5000], ['Infinity', 5000], ['garbage', 5000], ['5 seconds', 5000],
    ['0x10', 5000], ['+10', 5000], ['1e1', 5000],
    [new Date(now + 5000).toUTCString(), 5000],
    [new Date(now + 60000).toUTCString(), 60000],
    [new Date(now + 4000).toUTCString(), 5000],
    [new Date(now + 61000).toUTCString(), 5000],
    [new Date(now - 1000).toUTCString(), 5000],
  ])('parses %s as %i ms', (value, expected) => {
    expect(SAFE_RUN_RETRY_DELAY_MS).toBe(5000);
    expect(safeRunRetryDelayMs(value, now)).toBe(expected);
  });
});
