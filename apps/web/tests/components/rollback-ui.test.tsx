// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { RollbackModal } from '../../src/components/RollbackModal';
import { RollbackPlanChangedError } from '../../src/state/projects';
import type { AgentEvent, ChatMessage } from '../../src/types';
import type {
  ProjectCheckpointDiffResponse,
  ProjectCheckpointSummary,
  RollbackResponse,
} from '../../src/state/projects';

const projectStateMocks = vi.hoisted(() => {
  class MockRollbackConflictError extends Error {
    readonly code = 'ROLLBACK_CONFLICT';
    readonly conflicts: Array<{ path: string; reason?: string }>;

    constructor(message: string, conflicts: Array<{ path: string; reason?: string }> = []) {
      super(message);
      this.name = 'RollbackConflictError';
      this.conflicts = conflicts;
    }
  }

  return {
    executeAgentRollback: vi.fn(),
    fetchProjectCheckpointDiff: vi.fn(),
    listProjectCheckpoints: vi.fn(),
    rollbackConversation: vi.fn(),
    RollbackConflictError: MockRollbackConflictError,
  };
});

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    executeAgentRollback: projectStateMocks.executeAgentRollback,
    fetchProjectCheckpointDiff: projectStateMocks.fetchProjectCheckpointDiff,
    listProjectCheckpoints: projectStateMocks.listProjectCheckpoints,
    rollbackConversation: projectStateMocks.rollbackConversation,
    RollbackConflictError: projectStateMocks.RollbackConflictError,
  };
});

const ASSISTANT_ROLLBACK_EVENT = 'readable-studio:assistant-rollback';

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Done.',
    runStatus: 'succeeded',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_005_000,
    events: [{ kind: 'text', text: 'Done.' } as AgentEvent],
    producedFiles: [],
    ...overrides,
  } as ChatMessage;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rollback action in assistant footer', () => {
  it('dispatches the rollback target when project and conversation context are available', () => {
    const message = baseMessage();
    const onRollback = vi.fn();
    window.addEventListener(ASSISTANT_ROLLBACK_EVENT, onRollback);

    try {
      render(
        <AssistantMessage
          message={message}
          streaming={false}
          projectId="proj-1"
          conversationId="conv-1"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Rollback from here' }));

      expect(onRollback).toHaveBeenCalledTimes(1);
      expect(onRollback.mock.calls[0]?.[0]).toMatchObject({
        detail: {
          projectId: 'proj-1',
          conversationId: 'conv-1',
          message,
        },
      });
    } finally {
      window.removeEventListener(ASSISTANT_ROLLBACK_EVENT, onRollback);
    }
  });

  it('places rollback immediately after the copy action in the assistant footer', () => {
    render(
      <AssistantMessage
        message={baseMessage()}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        onForkFromMessage={vi.fn()}
      />,
    );

    const controls = document.querySelector('.assistant-footer-controls');
    expect(controls).toBeInstanceOf(HTMLElement);

    const labels = within(controls as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));

    expect(labels).toEqual([
      'Copy response markdown',
      'Rollback from here',
      'Fork from here',
    ]);
  });

  it('hides the rollback action without a conversation target or while streaming', () => {
    const { rerender } = render(
      <AssistantMessage
        message={baseMessage()}
        streaming={false}
        projectId="proj-1"
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rollback from here' })).toBeNull();

    rerender(
      <AssistantMessage
        message={baseMessage({ runStatus: 'running', endedAt: undefined })}
        streaming
        projectId="proj-1"
        conversationId="conv-1"
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rollback from here' })).toBeNull();
  });
});

describe('RollbackModal', () => {
  it('keeps Confirm reachable for the latest-message-with-drift case and shows the data-loss warning', async () => {
    // Rolling back the latest assistant message after a manual edit: the diff
    // reports a genuine conflict on the edited file. The user must still be able
    // to proceed (overwrite) without the Confirm button being a permanent dead
    // end — and the data loss must be surfaced, not silent.
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-latest',
      projectId: 'proj-1',
      kind: 'after_message',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_006_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const diff: ProjectCheckpointDiffResponse = {
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [{ path: 'index.html', reason: 'current_changed_since_checkpoint' }],
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_and_chat',
      targetMessageId: 'msg-1',
      restoredCheckpointId: 'checkpoint-latest',
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: 'user',
    };

    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue(diff);
    projectStateMocks.rollbackConversation.mockResolvedValue(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    // The conflict block and an explicit data-loss warning are visible.
    expect(await screen.findByText('File conflicts')).toBeTruthy();
    expect(screen.getByText(/discard your manual edits/i)).toBeTruthy();

    // Confirm is NOT permanently disabled: an actionable resolution is the
    // default, so the user can proceed straight away.
    const confirmButton = screen.getByRole('button', {
      name: 'Restore files and chat',
    }) as HTMLButtonElement;
    await waitFor(() => expect(confirmButton.disabled).toBe(false));

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(projectStateMocks.rollbackConversation).toHaveBeenCalledWith('proj-1', 'conv-1', {
        targetMessageId: 'msg-1',
        targetCheckpointId: 'checkpoint-latest',
        mode: 'files_and_chat',
        conflictPolicy: 'overwrite',
        createSafetyCheckpoint: true,
      });
    });
  });

  it('renders checkpoint conflicts and lets the user keep their edits instead of overwriting', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-1',
      projectId: 'proj-1',
      kind: 'after_message',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_006_000,
      rootPathHash: 'root-hash',
      fileCount: 2,
      totalBytes: 200,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const diff: ProjectCheckpointDiffResponse = {
      checkpoint,
      files: [
        { path: 'index.html', status: 'modified' },
        { path: 'styles.css', status: 'added' },
      ],
      conflicts: [
        { path: 'index.html', reason: 'current_changed_since_checkpoint' },
      ],
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_and_chat',
      targetMessageId: 'msg-1',
      restoredCheckpointId: 'checkpoint-1',
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: {
        added: 1,
        modified: 1,
        deleted: 0,
        unchanged: 0,
      },
      conflicts: [],
      actor: 'user',
    };
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue(diff);
    projectStateMocks.rollbackConversation.mockResolvedValue(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    expect(projectStateMocks.listProjectCheckpoints).toHaveBeenCalledWith('proj-1', 'conv-1');
    expect(await screen.findByText('File conflicts')).toBeTruthy();
    expect(screen.getAllByText('index.html')).toHaveLength(2);
    expect(screen.getByText('current_changed_since_checkpoint')).toBeTruthy();
    // Confirm is reachable straight away (default actionable policy), and the
    // data-loss warning is shown — never a silent restore, never a dead end.
    const confirmButton = screen.getByRole('button', { name: 'Restore files and chat' }) as HTMLButtonElement;
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
    expect(screen.getByText(/discard your manual edits/i)).toBeTruthy();

    // The user can opt to keep their edits instead of overwriting.
    fireEvent.change(screen.getByRole('combobox', { name: 'Conflict policy' }), {
      target: { value: 'keep_current' },
    });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(projectStateMocks.rollbackConversation).toHaveBeenCalledWith('proj-1', 'conv-1', {
        targetMessageId: 'msg-1',
        targetCheckpointId: 'checkpoint-1',
        mode: 'files_and_chat',
        conflictPolicy: 'keep_current',
        createSafetyCheckpoint: true,
      });
    });
    expect(onSuccess).toHaveBeenCalledWith(rollbackResponse);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('posts rollback without pre-canceling renderer state', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-1',
      projectId: 'proj-1',
      kind: 'after_message',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_006_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_and_chat',
      targetMessageId: 'msg-1',
      restoredCheckpointId: 'checkpoint-1',
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: 'user',
    };
    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue({
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [],
    });
    projectStateMocks.rollbackConversation.mockResolvedValue(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    const confirmButton = await screen.findByRole('button', { name: 'Restore files and chat' }) as HTMLButtonElement;
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
    fireEvent.click(confirmButton);

    await waitFor(() => expect(projectStateMocks.rollbackConversation).toHaveBeenCalled());
  });

  it('keeps a denied manual rollback open without mutating renderer state', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-1',
      projectId: 'proj-1',
      kind: 'after_message',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_006_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue({
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [],
    });
    projectStateMocks.rollbackConversation.mockRejectedValue(new Error('Desktop approval was denied.'));

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    const confirm = await screen.findByRole('button', { name: 'Restore files and chat' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    expect((await screen.findByRole('alert')).textContent).toContain('Desktop approval was denied.');
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('renders read-only diff preview without rollback controls when readOnly is set', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-agent',
      projectId: 'proj-1',
      kind: 'after_message',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_006_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const diff: ProjectCheckpointDiffResponse = {
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [],
    };

    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue(diff);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        readOnly
        initialMode="files_only"
        initialCheckpointId="checkpoint-agent"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(await screen.findByText('index.html')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore files' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Restore mode' })).toBeNull();
    expect(projectStateMocks.rollbackConversation).not.toHaveBeenCalled();
  });

  it('keeps an explicit agent checkpoint instead of selecting a later checkpoint for the same message', async () => {
    const beforeRun: ProjectCheckpointSummary = {
      id: 'checkpoint-before-run',
      projectId: 'proj-1',
      kind: 'before_run',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_000_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'before-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const afterMessage: ProjectCheckpointSummary = {
      ...beforeRun,
      id: 'checkpoint-after-message',
      kind: 'after_message',
      createdAt: 1_700_000_010_000,
      manifestHash: 'after-hash',
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_only',
      targetMessageId: 'msg-1',
      restoredCheckpointId: beforeRun.id,
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: 'agent',
    };

    projectStateMocks.listProjectCheckpoints.mockResolvedValue([beforeRun, afterMessage]);
    projectStateMocks.fetchProjectCheckpointDiff.mockImplementation(async (_projectId, checkpointId) => ({
      checkpoint: checkpointId === beforeRun.id ? beforeRun : afterMessage,
      files: [{ path: `${checkpointId}.txt`, status: 'modified' }],
      conflicts: [],
    }));
    projectStateMocks.executeAgentRollback.mockResolvedValue(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        initialMode="files_only"
        initialCheckpointId={beforeRun.id}
        agentRequestId="request-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Chat only' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Files and chat' })).toBeNull();
    const confirmButton = screen.getByRole('button', { name: 'Restore files' }) as HTMLButtonElement;
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
    expect(projectStateMocks.fetchProjectCheckpointDiff).not.toHaveBeenCalledWith('proj-1', afterMessage.id);

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(projectStateMocks.executeAgentRollback).toHaveBeenCalledWith('proj-1', 'conv-1', {
        requestId: 'request-1',
        conflictPolicy: 'fail',
      });
    });
    expect(projectStateMocks.rollbackConversation).not.toHaveBeenCalled();
  });

  it('requires an agent rollback conflict choice while preserving the manual overwrite default', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-agent',
      projectId: 'proj-1',
      kind: 'before_run',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_000_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_only',
      targetMessageId: 'msg-1',
      restoredCheckpointId: checkpoint.id,
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: 'agent',
    };

    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue({
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [{ path: 'index.html', reason: 'current_changed_since_checkpoint' }],
    });
    projectStateMocks.executeAgentRollback.mockResolvedValue(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        initialMode="files_only"
        initialCheckpointId={checkpoint.id}
        agentRequestId="request-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    const conflictPolicy = await screen.findByRole('combobox', { name: 'Conflict policy' }) as HTMLSelectElement;
    const confirmButton = screen.getByRole('button', { name: 'Restore files' }) as HTMLButtonElement;
    expect(conflictPolicy.value).toBe('fail');
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(conflictPolicy, { target: { value: 'overwrite' } });
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(projectStateMocks.executeAgentRollback).toHaveBeenCalledWith('proj-1', 'conv-1', {
        requestId: 'request-1',
        conflictPolicy: 'overwrite',
      });
    });
  });

  it('retries the same broker request after a server-reported file conflict', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-agent',
      projectId: 'proj-1',
      kind: 'before_run',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_000_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const rollbackResponse: RollbackResponse = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_only',
      targetMessageId: 'msg-1',
      restoredCheckpointId: checkpoint.id,
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: 'agent',
    };
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue({
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [],
    });
    projectStateMocks.executeAgentRollback
      .mockRejectedValueOnce(new projectStateMocks.RollbackConflictError('Rollback conflicts with current files.', [
        { path: 'index.html', reason: 'current_changed_since_checkpoint' },
      ]))
      .mockResolvedValueOnce(rollbackResponse);

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        initialMode="files_only"
        initialCheckpointId={checkpoint.id}
        agentRequestId="request-1"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Restore files' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText('Rollback conflicts with current files.')).toBeTruthy();

    const policy = screen.getByRole('combobox', { name: 'Conflict policy' });
    fireEvent.change(policy, { target: { value: 'overwrite' } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(rollbackResponse));
    expect(projectStateMocks.executeAgentRollback).toHaveBeenNthCalledWith(1, 'proj-1', 'conv-1', {
      requestId: 'request-1',
      conflictPolicy: 'fail',
    });
    expect(projectStateMocks.executeAgentRollback).toHaveBeenNthCalledWith(2, 'proj-1', 'conv-1', {
      requestId: 'request-1',
      conflictPolicy: 'overwrite',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Desktop approval is unavailable.',
    'Desktop approval was denied.',
    'Desktop approval timed out.',
  ])('shows %s without dismissing or mutating the request', async (approvalError) => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-agent',
      projectId: 'proj-1',
      kind: 'before_run',
      messageId: 'msg-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      createdAt: 1_700_000_000_000,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
    };
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff.mockResolvedValue({
      checkpoint,
      files: [{ path: 'index.html', status: 'modified' }],
      conflicts: [],
    });
    projectStateMocks.executeAgentRollback.mockRejectedValue(new Error(approvalError));

    render(
      <RollbackModal
        projectId="proj-1"
        conversationId="conv-1"
        targetMessage={baseMessage()}
        initialMode="files_only"
        initialCheckpointId={checkpoint.id}
        agentRequestId="request-1"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Restore files' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    expect((await screen.findByRole('alert')).textContent).toContain(approvalError);
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(projectStateMocks.executeAgentRollback).toHaveBeenCalledTimes(2));
    expect(projectStateMocks.executeAgentRollback).toHaveBeenNthCalledWith(2, 'proj-1', 'conv-1', {
      requestId: 'request-1',
      conflictPolicy: 'fail',
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(projectStateMocks.rollbackConversation).not.toHaveBeenCalled();
  });
  it('keeps the modal open and reloads the diff when the approved plan changed', async () => {
    const checkpoint: ProjectCheckpointSummary = {
      id: 'checkpoint-agent', projectId: 'proj-1', kind: 'before_run', messageId: 'msg-1',
      runId: 'run-1', conversationId: 'conv-1', createdAt: 1_700_000_000_000,
      rootPathHash: 'root-hash', fileCount: 1, totalBytes: 100, manifestHash: 'manifest-hash',
      restoreModes: ['files_only'],
    };
    const onClose = vi.fn();
    projectStateMocks.listProjectCheckpoints.mockResolvedValue([checkpoint]);
    projectStateMocks.fetchProjectCheckpointDiff
      .mockResolvedValueOnce({ checkpoint, files: [{ path: 'old.html', status: 'modified' }], conflicts: [] })
      .mockResolvedValueOnce({ checkpoint, files: [{ path: 'new.html', status: 'added' }], conflicts: [] });
    projectStateMocks.executeAgentRollback.mockRejectedValue(new RollbackPlanChangedError('Plan changed.'));

    render(<RollbackModal
      projectId="proj-1"
      conversationId="conv-1"
      targetMessage={baseMessage()}
      initialMode="files_only"
      initialCheckpointId={checkpoint.id}
      agentRequestId="request-1"
      onClose={onClose}
      onSuccess={vi.fn()}
    />);

    const confirm = screen.getByRole('button', { name: 'Restore files' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    expect(await screen.findByText('The rollback plan changed. The diff was reloaded; review it and approve again.')).toBeTruthy();
    await waitFor(() => expect(projectStateMocks.fetchProjectCheckpointDiff).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('new.html')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
