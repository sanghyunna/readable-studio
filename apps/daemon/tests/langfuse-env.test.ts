import { describe, expect, it } from 'vitest';

import { buildTracePayload } from '../src/langfuse-trace.js';

describe('langfuse disabled environment', () => {
  it('stamps dropped trace metadata with the disabled environment', () => {
    const batch = buildTracePayload({
      installationId: 'install-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'codex',
      run: {
        runId: 'run-1',
        status: 'succeeded',
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
      },
      message: {
        messageId: 'message-1',
        prompt: 'Build a page',
        output: 'Done',
      },
      artifacts: [],
      eventsSummary: {
        toolCalls: 0,
        errors: 0,
        durationMs: 1000,
      },
      prefs: {
        metrics: true,
        content: true,
      },
    });

    expect((batch[0] as any).body.metadata.env).toBe('disabled');
  });
});
