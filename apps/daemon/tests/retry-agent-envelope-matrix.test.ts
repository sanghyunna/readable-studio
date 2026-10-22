import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { attachAcpSession } from '../src/acp.js';
import { createClaudeStreamHandler } from '../src/claude-stream.js';
import { createCopilotStreamHandler } from '../src/copilot-stream.js';
import { createJsonEventStreamHandler } from '../src/json-event-stream.js';
import { mapPiRpcEvent } from '../src/pi-rpc.js';
import { createQoderStreamHandler } from '../src/qoder-stream.js';
import { classifyRunFailure, type RunEventForFailureClassification } from '../src/run-failure-classification.js';
import { decideSafeRunRetry, safeRunRetryDelayMs } from '../src/run-retry-policy.js';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';
import { AGENT_DEFS } from '../src/runtimes/registry.js';
import type { RuntimeAgentDef } from '../src/runtimes/types.js';

// These peers exercise production framing and protocol state without spawning a CLI.
class ProtocolPeer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;

  frame(message: unknown) {
    const line = `${JSON.stringify(message)}\n`;
    const split = Math.floor(line.length / 2);
    this.stdout.write(line.slice(0, split));
    this.stdout.write(line.slice(split));
  }

  kill() {
    this.killed = true;
    return true;
  }

  close() {
    this.exitCode = 1;
    this.emit('close', 1, null);
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

function failureEvents(agent: RuntimeAgentDef, message: string): RunEventForFailureClassification[] {
  const events: RunEventForFailureClassification[] = [];
  const receive = (data: Record<string, unknown>) => events.push({ event: 'agent', data });
  const send = (event: string, data: unknown) => events.push({ event, data });
  switch (agent.streamFormat) {
    case 'claude-stream-json': {
      const parser = createClaudeStreamHandler(receive);
      parser.feed(`${JSON.stringify({ type: 'assistant', error: 'unknown', message: {
        content: [{ type: 'text', text: message }], stop_reason: 'end_turn',
      } })}\n`);
      parser.flush();
      break;
    }
    case 'copilot-stream-json': {
      const parser = createCopilotStreamHandler(receive);
      parser.feed(`${JSON.stringify({ type: 'result', success: false, exitCode: 1, error: { message } })}\n`);
      parser.flush();
      break;
    }
    case 'qoder-stream-json': {
      const parser = createQoderStreamHandler(receive);
      parser.feed(`${JSON.stringify({ type: 'assistant', message: { content: [] }, error: { message } })}\n`);
      parser.flush();
      break;
    }
    case 'json-event-stream': {
      // Cursor reports process failures on stderr; its stdout parser handles content.
      if (agent.eventParser === 'cursor-agent') {
        events.push({ event: 'stderr', data: { chunk: message } });
        break;
      }
      const parser = createJsonEventStreamHandler(agent.eventParser ?? agent.id, receive);
      parser.feed(`${JSON.stringify({ type: 'error', error: { name: 'ProviderError', data: { message } } })}\n`);
      parser.flush();
      break;
    }
    case 'pi-rpc':
      mapPiRpcEvent({ type: 'turn_end', message: { stopReason: 'error', errorMessage: message } }, send, {
        runStartedAt: Date.now(), sentFirstToken: { value: false },
      });
      break;
    case 'acp-json-rpc': {
      const child = new ProtocolPeer();
      const session = attachAcpSession({
        child: child as never, prompt: 'Reply briefly.', stageTimeoutMs: 0,
        ...(agent.id === 'amr' ? { modelUnavailableErrorCode: 'AMR_MODEL_UNAVAILABLE' } : {}),
        send,
      });
      try {
        child.frame({ id: 1, result: {} });
        child.frame({ id: 2, result: { sessionId: `${agent.id}-session` } });
        child.frame({ id: 3, error: { code: -32000, message } });
        expect(session.hasFatalError()).toBe(true);
      } finally {
        session.abort();
        child.close();
      }
      break;
    }
    case 'codex-app-server': {
      const child = new ProtocolPeer();
      const session = attachCodexAppServerSession({
        child: child as never, prompt: 'Reply briefly.', cwd: process.cwd(),
        model: 'selected-model', onEvent: receive,
      });
      try {
        child.frame({ id: 1, result: {} });
        child.frame({ id: 2, result: { thread: { id: 'thread-1' } } });
        child.frame({ id: 3, result: { turn: { id: 'turn-1' } } });
        child.frame({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message } } } });
        expect(session.hasFatalError()).toBe(true);
      } finally {
        session.abort();
        child.close();
      }
      break;
    }
    case 'plain':
      events.push({ event: 'stderr', data: { chunk: message } });
      break;
    default:
      throw new Error(`Missing retry envelope fixture for ${agent.id}: ${agent.streamFormat}`);
  }
  return events;
}

const failures = [
  ['disconnect', 'ECONNRESET: connection reset by peer', 'upstream_unavailable', true],
  ['timeout', 'UND_ERR_HEADERS_TIMEOUT', 'timeout', true],
  ['expired token', 'Token expired', 'auth', true],
  ['refresh failure', 'Token refresh failed', 'auth', true],
  ['rate limit', 'HTTP 429 Too Many Requests', 'rate_limit', true],
  ['server failure', 'HTTP 503 Service Unavailable', 'upstream_unavailable', true],
  ['overload', 'overloaded_error', 'upstream_unavailable', true],
  ['permission', 'HTTP 403 permission denied', 'auth', true],
  ['hard quota', 'Your credit balance is too low to access the Anthropic API.', 'rate_limit', false],
  ['invalid model', 'invalid model: unavailable-model', 'model_unavailable', false],
] as const;

describe.each(AGENT_DEFS)('$id retry failure envelopes ($streamFormat)', agent => {
  it.each(failures)('classifies %s from the runtime boundary and applies the retry budget', (_name, message, category, transient) => {
    const events = failureEvents(agent, message);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(({ data }) => (data as Record<string, unknown>).type === 'text_delta')).toBe(false);
    const failure = classifyRunFailure({
      agentId: agent.id, result: 'failed', status: { status: 'failed', exitCode: 1 }, events,
    });
    assert.ok(failure);
    expect(failure?.failure_category).toBe(category);
    const databricksAuth = agent.id === 'databricks' && category === 'auth';
    const shouldRetry = transient && !databricksAuth;
    const maxAttempts = agent.id === 'databricks' ? 1 : 10;
    const decide = (attemptCount: number) => decideSafeRunRetry({
      agentId: agent.id, result: 'failed', failure, attemptCount,
      ...(agent.id === 'databricks' ? { maxAttempts: 1 } : {}),
    });
    expect(decide(0)).toMatchObject({ shouldRetry, retryAttemptIndex: 1, retryMaxAttempts: maxAttempts });
    if (shouldRetry) {
      expect(decide(maxAttempts - 1)).toMatchObject({ shouldRetry: true, retryAttemptIndex: maxAttempts });
      expect(decide(maxAttempts)).toMatchObject({ shouldRetry: false, retrySuppressedReason: 'attempt_limit_reached' });
      expect(safeRunRetryDelayMs()).toBe(5000);
    } else {
      expect(failure?.retryable).toBe(transient);
      if (category === 'model_unavailable') expect(failure?.user_action).toBe('switch_model');
      if (category === 'rate_limit') expect(failure?.failure_detail).toBe('hard_quota');
    }
  });

  it('stops after success and cancellation without consuming another execution', () => {
    expect(classifyRunFailure({ agentId: agent.id, result: 'success', status: { status: 'succeeded' } })).toBeUndefined();
    expect(decideSafeRunRetry({ agentId: agent.id, result: 'success', attemptCount: 3 })).toMatchObject({
      shouldRetry: false, retrySuppressedReason: 'not_failed',
    });
    const failure = classifyRunFailure({ agentId: agent.id, result: 'cancelled', status: { status: 'canceled' } });
    assert.ok(failure);
    expect(failure?.failure_category).toBe('user_cancel');
    expect(decideSafeRunRetry({ agentId: agent.id, result: 'cancelled', failure, attemptCount: 3 })).toMatchObject({
      shouldRetry: false, retrySuppressedReason: 'not_failed',
    });
  });
});
