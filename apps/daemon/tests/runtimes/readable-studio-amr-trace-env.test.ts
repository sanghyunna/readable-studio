import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readableStudioAmrTraceEnv } from '../../src/runtimes/env.js';

test('readableStudioAmrTraceEnv builds Readable Studio trace identity env for AMR only', () => {
  const amrEnv = readableStudioAmrTraceEnv({
    agentId: 'amr',
    runId: ' run_trace_123 ',
    runAttempt: 2,
    conversationId: ' conversation_trace_456 ',
  });

  assert.equal(amrEnv.READABLE_RUN_ID, 'run_trace_123');
  assert.equal(amrEnv.READABLE_RUN_ATTEMPT, '2');
  assert.equal(amrEnv.READABLE_SESSION_ID, 'conversation_trace_456');

  const claudeEnv = readableStudioAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 2,
    conversationId: 'conversation_trace_456',
  });

  assert.deepEqual(claudeEnv, {});
});

test('readableStudioAmrTraceEnv omits optional AMR session trace env when no conversation exists', () => {
  const env = readableStudioAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_no_session',
    runAttempt: 0,
  });

  assert.equal(env.READABLE_RUN_ID, 'run_trace_no_session');
  assert.equal(env.READABLE_RUN_ATTEMPT, '0');
  assert.equal(env.READABLE_SESSION_ID, undefined);
});

test('readableStudioAmrTraceEnv fails fast on invalid AMR trace inputs', () => {
  assert.throws(
    () => readableStudioAmrTraceEnv({ agentId: 'amr', runId: ' ', runAttempt: 0 }),
    /READABLE_RUN_ID/,
  );
  assert.throws(
    () => readableStudioAmrTraceEnv({ agentId: 'amr', runId: 'run_trace', runAttempt: -1 }),
    /READABLE_RUN_ATTEMPT/,
  );
});
