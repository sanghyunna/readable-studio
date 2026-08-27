// @vitest-environment jsdom

// The hub replaces the welcome screen, so opening a session must land in the
// existing workspace in one step: same route contract, same workspace tab
// event. No intermediate detail page, no new backend concept.

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

import { openProjectRoute, openSessionRoute } from '../../src/components/hub/openSessionRoute';
import { HubHome } from '../../src/components/hub/HubHome';
import type { Project } from '../../src/types';

// WorkspaceTabsBar keeps this constant module-private; the hub must keep
// speaking the same wire name.
const OPEN_WORKSPACE_TAB_EVENT = 'readable-studio:workspace-tabs:open';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  navigate.mockReset();
});

const PROJECT: Project = {
  id: 'p1',
  name: '분기 보고서',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 900,
};

describe('hub session handoff', () => {
  let opened: unknown[] = [];
  let listener: (event: Event) => void;

  beforeEach(() => {
    opened = [];
    listener = (event: Event) => {
      opened.push((event as CustomEvent<{ route: unknown }>).detail.route);
    };
    window.addEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
  });

  it('opens a project palette result in a workspace tab', () => {
    openProjectRoute('p1');
    const route = {
      kind: 'project',
      projectId: 'p1',
      conversationId: null,
      fileName: null,
    };
    expect(navigate).toHaveBeenCalledWith(route);
    expect(opened).toEqual([route]);
  });

  it('navigates to the project route carrying the conversation id', () => {
    openSessionRoute('p1', 'c1');
    expect(navigate).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'p1',
      conversationId: 'c1',
      fileName: null,
    });
  });

  it('opens a workspace tab for the same route', () => {
    openSessionRoute('p1', 'c1');
    expect(opened).toEqual([
      { kind: 'project', projectId: 'p1', conversationId: 'c1', fileName: null },
    ]);
  });

  it('reaches the workspace from a click in the tree', async () => {
    listConversations.mockResolvedValue([
      { id: 'c9', projectId: 'p1', title: '차트 팔레트 정리', createdAt: 1, updatedAt: 5 },
    ]);
    render(
      <HubHome
        projects={[PROJECT]}
        projectsLoading={false}
        onOpenSession={openSessionRoute}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onImportFolder={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByTestId('hub-session-c9'));
    expect(navigate).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'p1',
      conversationId: 'c9',
      fileName: null,
    });
    expect(opened).toHaveLength(1);
  });
});
