// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeWriteConflictNotice } from '../../src/components/NativeWriteConflictNotice';
import type { ChatMessage } from '../../src/types';
vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../../src/components/RollbackModal', () => ({ RollbackModal: (props: { initialMode: string; initialCheckpointId: string; targetMessage: ChatMessage }) => <output data-testid="restore-plan">{JSON.stringify({ mode: props.initialMode, checkpointId: props.initialCheckpointId, messageId: props.targetMessage.id })}</output> }));
afterEach(cleanup);
it('opens the existing files-only checkpoint restore when the recovery action is clicked', () => {
  // Given a terminal native-write conflict with a recovery checkpoint.
  const error = Object.assign(new Error('outside edit'), { code: 'CONFLICT', details: {
    kind: 'native-overwrite', path: 'index.html', sidecar: 'index.agent-12345678.html', checkpointId: 'recovery-id',
  } });
  const message: ChatMessage = { id: 'message-id', role: 'assistant', content: '', createdAt: 1 };
  render(<NativeWriteConflictNotice error={error} projectId="project" conversationId="conversation" message={message} onRestored={() => undefined} />);
  // When the user chooses restore.
  fireEvent.click(screen.getByRole('button'));
  // Then the established checkpoint surface gets the exact recovery target.
  expect(JSON.parse(screen.getByTestId('restore-plan').textContent ?? '')).toEqual({ mode: 'files_only', checkpointId: 'recovery-id', messageId: 'message-id' });
  expect(screen.getByText('index.agent-12345678.html')).toBeTruthy();
});
it('does not offer checkpoint recovery for an ordinary HTTP conflict', () => {
  // Given an ordinary stale HTTP Save.
  const error = Object.assign(new Error('stale'), { code: 'CONFLICT' });
  // When it is rendered.
  const { container } = render(<NativeWriteConflictNotice error={error} projectId="project" conversationId="conversation" message={{ id: 'm', role: 'assistant', content: '', createdAt: 1 }} onRestored={() => undefined} />);
  // Then no native recovery action is offered.
  expect(container.childElementCount).toBe(0);
});
