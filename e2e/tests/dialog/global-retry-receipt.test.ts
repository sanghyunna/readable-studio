import { describe, expect, test } from 'vitest';
import { CODEX_FALLBACK_RETRY_RUN, GLOBAL_RETRY_RUN } from '@/fake-agents';
import { verifyGlobalRetryCase, type RetryCaseEvidence } from '../../scripts/release-packaged-qa.ts';

function evidence(scenario: keyof typeof GLOBAL_RETRY_RUN.prompts): RetryCaseEvidence {
  const succeeds = scenario === 'transient' || scenario === 'codex-fallback';
  const retries = succeeds ? 1 : scenario === 'exhausted' ? 10 : 0;
  const run = { id: 'run', conversationId: 'conversation', assistantMessageId: 'assistant',
    status: succeeds ? 'succeeded' : 'failed',
    errorCode: scenario === 'quota' ? 'AGENT_QUOTA_EXHAUSTED' : scenario === 'invalid-model' ? 'AGENT_MODEL_UNAVAILABLE' : null };
  return {
    run, conversations: [{ id: 'conversation' }], runs: [{ id: 'run' }],
    messages: [
      { id: 'user', role: 'user', content: GLOBAL_RETRY_RUN.prompts[scenario] },
      { id: 'assistant', role: 'assistant', runId: 'run', content: succeeds
        ? GLOBAL_RETRY_RUN.partial + GLOBAL_RETRY_RUN.continuation : '' },
    ],
    attempts: Array.from({ length: retries + (scenario === 'codex-fallback' ? 2 : 1) }, (_, index) => ({ attempt: index + 1,
      startedAt: 1000 + (scenario === 'codex-fallback' ? Math.max(0, index - 1) : index) * 5100,
      sessionId: scenario === 'codex-fallback' ? index ? CODEX_FALLBACK_RETRY_RUN.threadId : '' : 'session',
      args: index ? ['--resume', 'session'] : ['--session-id', 'session'],
      ...(scenario === 'codex-fallback' ? { isolated: index === 0,
        method: index === 0 ? 'initialize' : index === 1 ? 'thread/start' : 'thread/resume' } : {}) })),
    events: [
      ...Array.from({ length: retries }, (_, index) => ({ event: 'agent', data: { type: 'status', label: 'retrying',
        detail: JSON.stringify({ attempt: index + 1, maxRetries: 10, delayMs: 5000 }) } })),
      ...(scenario === 'codex-fallback' ? [
        ...Array.from({ length: 3 }, () => ({ event: 'start', data: {} })),
        { event: 'agent', data: { type: 'tool_use' } }, { event: 'agent', data: { type: 'tool_result' } },
      ] : []),
      ...(succeeds ? [] : [{ event: 'error', data: { error: { code: run.errorCode, retryable: false } } }]),
      { event: 'end', data: {} },
    ],
  };
}

describe('packaged global retry receipt', () => {
  test.each(['transient', 'exhausted', 'quota', 'invalid-model', 'codex-fallback'] as const)('accepts a complete %s case', scenario => {
    expect(verifyGlobalRetryCase(scenario, evidence(scenario)).length)
      .toBe(scenario === 'transient' || scenario === 'codex-fallback' ? 1 : scenario === 'exhausted' ? 10 : 0);
  });
  test('rejects repeated isolation recovery, a new native thread, and duplicate committed tool work', () => {
    for (const defect of ['isolation', 'thread', 'tool'] as const) {
      const value = evidence('codex-fallback');
      if (defect === 'isolation') value.attempts[2]!.isolated = true;
      if (defect === 'thread') value.attempts[2]!.sessionId = 'new-thread';
      if (defect === 'tool') value.events.push({ event: 'agent', data: { type: 'tool_use' } });
      expect(() => verifyGlobalRetryCase('codex-fallback', value)).toThrow();
    }
  });
  test('rejects duplicated partial output', () => {
    const value = evidence('transient');
    value.messages[1]!.content += GLOBAL_RETRY_RUN.partial;
    expect(() => verifyGlobalRetryCase('transient', value)).toThrow(/partial/);
  });
  test('rejects a retry before the real five second wait', () => {
    const value = evidence('exhausted');
    value.attempts[1]!.startedAt = value.attempts[0]!.startedAt + 100;
    expect(() => verifyGlobalRetryCase('exhausted', value)).toThrow(/five seconds/);
  });
  test('rejects backoff and extra quota executions', () => {
    const value = evidence('transient');
    value.events[0]!.data.detail = JSON.stringify({ attempt: 1, maxRetries: 10, delayMs: 10000 });
    expect(() => verifyGlobalRetryCase('transient', value)).toThrow();
    const quota = evidence('quota');
    quota.attempts.push({ ...quota.attempts[0]!, attempt: 2 });
    expect(() => verifyGlobalRetryCase('quota', quota)).toThrow();
  });
  test('rejects extra messages, conversations, runs, and terminal errors', () => {
    for (const key of ['messages', 'conversations', 'runs', 'events'] as const) {
      const value = evidence('quota');
      if (key === 'messages') value.messages.push({ ...value.messages[0]! });
      if (key === 'conversations') value.conversations.push({ id: 'duplicate' });
      if (key === 'runs') value.runs.push({ id: 'duplicate' });
      if (key === 'events') value.events.push({ event: 'error', data: {} });
      expect(() => verifyGlobalRetryCase('quota', value)).toThrow();
    }
  });
  test('requires the resumed Claude session after partial output', () => {
    const value = evidence('transient');
    value.attempts[1]!.args = ['--session-id', 'new-session'];
    expect(() => verifyGlobalRetryCase('transient', value)).toThrow(/resume/);
  });
  test('requires the terminal machine cause in both status and CLI SSE errors', () => {
    const value = evidence('quota');
    value.run.errorCode = 'RATE_LIMITED';
    expect(() => verifyGlobalRetryCase('quota', value)).toThrow();
    value.run.errorCode = 'AGENT_QUOTA_EXHAUSTED';
    value.events[0]!.data.error = { code: 'RATE_LIMITED', retryable: false };
    expect(() => verifyGlobalRetryCase('quota', value)).toThrow();
  });
});
