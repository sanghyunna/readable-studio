// @vitest-environment jsdom

// The composer is the hub's primary action. Repeated activation while a
// creation is in flight must not fire multiple create requests.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import type { Project } from '../../src/types';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

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
      />,
    );
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('분기 리포트');

    const send = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(send.disabled).toBe(true));
    expect(screen.queryAllByTestId('home-hero-footer-option-designSystem')).toHaveLength(0);
    expect(screen.getByTestId('home-hero-context-control')).toBeTruthy();
    // Template control is gone from the footer; the New Project modal owns it.
    expect(screen.queryByTestId('home-hero-template-control')).toBeNull();

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
      />,
    );
    const box = await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('가격표 만들기');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
  });

  it('rejects a trimmed three-character prompt and clears the error on input', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
        onNewProject={vi.fn()}
      />,
    );
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('가격표');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmitPrompt).not.toHaveBeenCalled();
    const composer = screen.getByTestId('hub-composer');
    const alert = screen.getByRole('alert');
    expect(composer.classList.contains('is-error')).toBe(true);
    expect(composer.contains(alert)).toBe(false);
    expect(composer.nextElementSibling).toBe(alert);
    expect(alert.textContent?.trim().length).toBeGreaterThan(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    setHomeHeroPrompt('가격표!');
    expect(screen.queryByTestId('home-hero-error')).toBeNull();
  });
});
