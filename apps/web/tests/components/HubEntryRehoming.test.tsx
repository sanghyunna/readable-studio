// @vitest-environment jsdom

// Deleting the welcome screen must not delete the responsibilities it carried.
// These lock the behaviour the hub now owns: the composer routes through the
// same prompt-first create path, imports still reach the new-project flow, and
// opening a session preserves the workspace route + tab contract.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));
vi.mock('../../src/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/router')>();
  return { ...actual, navigate };
});

import { HubHome } from '../../src/components/hub/HubHome';
import { openSessionRoute } from '../../src/components/hub/openSessionRoute';
import type { Project } from '../../src/types';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const OPEN_WORKSPACE_TAB_EVENT = 'readable-studio:workspace-tabs:open';

const PROJECT: Project = {
  id: 'p1',
  name: '분기 보고서',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 900,
};

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  navigate.mockReset();
});

describe('entry re-homing after the hub replaced the welcome screen', () => {
  let opened: unknown[];
  let listener: (event: Event) => void;

  beforeEach(() => {
    opened = [];
    listener = (event: Event) => {
      opened.push((event as CustomEvent<{ route: unknown }>).detail.route);
    };
    window.addEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
    listConversations.mockResolvedValue([]);
  });

  afterEach(() => {
    window.removeEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
  });

  it('routes the composer prompt to the prompt-first create path', async () => {
    const onSubmitPrompt = vi.fn();
    render(
      <HubHome
        projects={[PROJECT]}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
        onNewProject={vi.fn()}
      />,
    );
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('분기 리포트');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트', { designSystemId: null });
  });

  // The hub used to carry its own "import folder" starter button. That button
  // was removed; folder import now lives in the New Project modal. What still
  // has to hold is that the hub offers a route to it, so this asserts the hub
  // opens the New Project surface rather than asserting a starter that is gone.
  it('keeps folder import reachable by routing to the new-project surface', async () => {
    const onNewProject = vi.fn();
    render(
      <HubHome
        projects={[PROJECT]}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={onNewProject}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /새 프로젝트|New project/i }));
    expect(onNewProject).toHaveBeenCalled();
  });

  it('keeps new-project creation reachable from the navigation panel', async () => {
    const onNewProject = vi.fn();
    render(
      <HubHome
        projects={[PROJECT]}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={onNewProject}
      />,
    );
    const nav = await screen.findByTestId('hub-nav');
    fireEvent.click(nav.querySelector('.hub__new-project') as HTMLElement);
    expect(onNewProject).toHaveBeenCalled();
  });

  it('preserves the workspace route and tab contract when opening a session', () => {
    openSessionRoute('p1', 'c1');
    expect(navigate).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'p1',
      conversationId: 'c1',
      fileName: null,
    });
    expect(opened).toEqual([
      { kind: 'project', projectId: 'p1', conversationId: 'c1', fileName: null },
    ]);
  });

  it('teaches the empty workspace instead of showing a blank canvas', async () => {
    render(
      <HubHome
        projects={[]}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('hub-empty')).toBeTruthy();
  });
});
