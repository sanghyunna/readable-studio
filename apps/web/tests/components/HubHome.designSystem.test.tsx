// @vitest-environment jsdom

// The old hero let the user pick a design system before creating. The hub's
// composer must not silently drop that choice.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { DesignSystemSummary, Project } from '../../src/types';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

const SYSTEMS: DesignSystemSummary[] = [
  { id: 'aurora', title: 'Aurora', category: 'web', summary: '', source: 'user', status: 'published' },
  { id: 'nord', title: 'Nord', category: 'web', summary: '', source: 'user', status: 'published' },
];

function renderHub(overrides = {}) {
  return render(
    <HubHome
      projects={PROJECTS}
      projectsLoading={false}
      designSystems={SYSTEMS}
      defaultDesignSystemId="aurora"
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
      onImportFolder={vi.fn()}
      {...overrides}
    />,
  );
}

describe('hub composer design system', () => {
  it('keeps free-form rich submissions explicitly unscoped', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    renderHub({ onSubmitPrompt });
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('분기 리포트');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트', { designSystemId: null });
  });

  it('uses the rich composer instead of the removed native hub selector', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    expect(await screen.findByTestId('home-hero-input')).toBeTruthy();
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
  });

  it('omits the picker when no design systems are installed', async () => {
    listConversations.mockResolvedValue([]);
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onImportFolder={vi.fn()}
      />,
    );
    await screen.findByTestId('home-hero-input');
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
  });
});
