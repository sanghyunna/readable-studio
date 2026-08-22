import { describe, expect, it } from 'vitest';

import type {
  AgentRollbackIntentRequest,
  DesktopRollbackApprovalDecisionRequest,
  DesktopRollbackApprovalNextResponse,
  RollbackRequest,
} from '../src/api/checkpoints.js';

describe('rollback boundary contracts', () => {
  it('separates public manual rollback from agent intent', () => {
    const manual: RollbackRequest = {
      targetMessageId: 'message-1',
      mode: 'files_only',
    };
    // @ts-expect-error Agent authority is never accepted on the public manual request.
    const spoofed: RollbackRequest = { ...manual, actor: 'agent' };
    const intent: AgentRollbackIntentRequest = {
      runId: 'run-1',
      mode: 'files_only',
      reason: 'Restore the prior edit',
    };

    expect(manual).not.toHaveProperty('actor');
    expect(manual).not.toHaveProperty('runId');
    expect(spoofed).toHaveProperty('actor', 'agent');
    expect(intent.runId).toBe('run-1');
  });

  it('shares the exact private approval producer and consumer shapes', () => {
    const response: DesktopRollbackApprovalNextResponse = {
      approval: {
        actor: 'agent',
        approvalRequestId: 'approval-1',
        conflictPolicy: 'fail',
        conversationId: 'conversation-1',
        decisionToken: 'decision-token',
        expiresAt: 1_700_000_300_000,
        fileChanges: { added: 1, modified: 2, deleted: 0, unchanged: 3 },
        conflictCount: 1,
        mode: 'files_only',
        projectId: 'project-1',
        reason: 'Restore the prior edit',
        revision: 'a'.repeat(64),
        runId: 'run-1',
        targetCheckpointId: 'checkpoint-1',
        targetMessageId: 'message-1',
      },
    };
    const decision: DesktopRollbackApprovalDecisionRequest = {
      approved: true,
      decisionToken: response.approval!.decisionToken,
    };

    expect(decision).toEqual({ approved: true, decisionToken: 'decision-token' });
  });
});
