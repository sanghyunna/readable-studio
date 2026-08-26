// @vitest-environment jsdom

// The composer is the hub's primary action. Repeated activation while a
// creation is in flight must not fire multiple create requests.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

describe('hub composer submit guard', () => {
  it('fires one create even when Start is pressed repeatedly', async () => {
    listConversations.mockResolvedValue([]);
    let release: (() => void) | undefined;
    const onSubmitPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
        onNewProject={vi.fn()}
        onImportFolder={vi.fn()}
      />,
    );
    const box = (await screen.findByTestId('hub-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '분기 리포트' } });

    const send = screen.getByTestId('hub-send') as HTMLButtonElement;
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(send.disabled).toBe(true));

    release?.();
    await waitFor(() => expect(send.disabled).toBe(false));
  });

  it('ignores Ctrl+Enter while a creation is in flight', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn(() => new Promise<void>(() => undefined));
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
        onNewProject={vi.fn()}
        onImportFolder={vi.fn()}
      />,
    );
    const box = (await screen.findByTestId('hub-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '가격표' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
  });
});
