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

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

const SYSTEMS: DesignSystemSummary[] = [
  { id: 'aurora', title: 'Aurora', category: 'web', summary: '' },
  { id: 'nord', title: 'Nord', category: 'web', summary: '' },
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
  it('submits the default design system with the prompt', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    renderHub({ onSubmitPrompt });
    const box = (await screen.findByTestId('hub-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '분기 리포트' } });
    fireEvent.click(screen.getByTestId('hub-send'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트', { designSystemId: 'aurora' });
  });

  it('lets the user switch the design system before starting', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    renderHub({ onSubmitPrompt });
    const picker = (await screen.findByTestId('hub-design-system')) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'nord' } });
    fireEvent.change(screen.getByTestId('hub-composer'), { target: { value: '가격표' } });
    fireEvent.click(screen.getByTestId('hub-send'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('가격표', { designSystemId: 'nord' });
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
    await screen.findByTestId('hub-composer');
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
  });
});
