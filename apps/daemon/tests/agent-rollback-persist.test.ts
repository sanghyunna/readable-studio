import { describe, expect, it } from 'vitest';

import { daemonAgentPayloadToPersistedAgentEvent } from '../src/server.js';

describe('daemonAgentPayloadToPersistedAgentEvent', () => {
  it('persists a rollback_request event as agent_rollback_request', () => {
    const result = daemonAgentPayloadToPersistedAgentEvent({
      type: 'rollback_request',
      requestId: 'request-1',
      expiresAt: 123456,
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_only',
      reason: 'I overwrote the wrong file',
    });

    expect(result).toEqual({
      kind: 'agent_rollback_request',
      requestId: 'request-1',
      expiresAt: 123456,
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_only',
      reason: 'I overwrote the wrong file',
    });
  });

  it('ignores rollback requests missing their exact target binding', () => {
    const result = daemonAgentPayloadToPersistedAgentEvent({
      type: 'rollback_request',
      requestId: 'request-2',
      expiresAt: 654321,
      runId: 'run-1',
    });

    expect(result).toBeNull();
  });

  it('ignores rollback_request events without an executable request binding', () => {
    const result = daemonAgentPayloadToPersistedAgentEvent({
      type: 'rollback_request',
      mode: 'files_only',
    });

    expect(result).toBeNull();
  });
});
