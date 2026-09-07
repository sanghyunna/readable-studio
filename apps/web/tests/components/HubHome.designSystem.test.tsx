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

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
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
      {...overrides}
    />,
  );
}

describe('hub composer design system', () => {
  it('submits the controlled default before the user changes it', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    renderHub({ onSubmitPrompt });
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('분기 리포트');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트', { designSystemId: 'aurora' });
  });

  it('uses the rich composer instead of the removed native hub selector', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    expect(await screen.findByTestId('home-hero-input')).toBeTruthy();
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
    expect(screen.queryAllByTestId('home-hero-footer-option-designSystem')).toHaveLength(0);
  });

  it('connects the remaining zero-plugin composer controls to context and template actions', async () => {
    listConversations.mockResolvedValue([]);
    const onOpenNewProject = vi.fn();
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onOpenNewProject={onOpenNewProject}
      />,
    );
    await screen.findByTestId('home-hero-input');
    const controls = screen.getByTestId('home-hero-footer-options').querySelectorAll('button');
    // The template control was removed from the composer footer: it duplicated
    // the New Project modal's Template tab, which stays reachable from the hub
    // command palette. Context is the only remaining footer-options button.
    expect(Array.from(controls, (control) => control.dataset.testid)).toEqual([
      'home-hero-context-control',
    ]);
    // The 디자인/질문 mode chip was deliberately removed from the HUB composer;
    // mode selection now lives in the New Project flow as two selectable cards
    // (`newproj-mode-design` / `newproj-mode-chat`), and `SessionModeToggle`
    // remains only in the PROJECT chat composer. The hub must therefore render
    // no mode affordance at all — neither the toggle nor either mode label.
    expect(screen.queryByTestId('session-mode-trigger')).toBeNull();
    for (const label of ['Design mode', 'Design', 'Chat', 'Ask']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }

    fireEvent.click(screen.getByTestId('home-hero-context-control'));
    expect(await screen.findByTestId('home-hero-plugin-picker')).toBeTruthy();

    expect(screen.queryByTestId('home-hero-template-control')).toBeNull();
    expect(onOpenNewProject).not.toHaveBeenCalledWith('template');
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
    expect(screen.queryAllByTestId('home-hero-footer-option-designSystem')).toHaveLength(0);
  });
});
