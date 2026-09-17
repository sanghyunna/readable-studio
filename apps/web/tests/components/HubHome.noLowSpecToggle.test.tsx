// @vitest-environment jsdom

// The `저사양 모드` (low-spec) toggle moved out of the Hub into the Settings
// modal header (owner decision: the Hub placement was unacceptable). This
// contract pins the Hub side of that move: no toggle, no leftover chrome row
// reserving space, and every pre-existing Hub control still mounted.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { I18nProvider } from '../../src/i18n';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Report', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

function renderHub() {
  return render(
    <I18nProvider initial="en">
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onImportFile={vi.fn()}
        executionSwitcher={<div data-testid="execution-switcher-probe" />}
      />
    </I18nProvider>,
  );
}

describe('Hub has no low-spec toggle', () => {
  it('renders neither the toggle nor the chrome row that held it', () => {
    renderHub();
    expect(screen.queryByTestId('hub-low-spec-toggle')).toBeNull();
    expect(screen.queryByTestId('hub-chrome')).toBeNull();
    // No empty reserved wrapper and no low-spec control anywhere on the Hub.
    expect(screen.queryByText(/low-spec mode/i)).toBeNull();
    expect(document.querySelector('[data-testid$="low-spec-toggle"]')).toBeNull();
    expect(document.querySelector('[data-testid$="low-spec-switch"]')).toBeNull();
  });

  it('keeps every existing Hub control mounted after the removal', () => {
    renderHub();
    expect(screen.getByTestId('home-view')).not.toBeNull();
    expect(screen.getByTestId('execution-switcher-probe')).not.toBeNull();
    expect(screen.getByTestId('hub-drop-to-edit')).not.toBeNull();
    expect(screen.getByTestId('hub-new-project')).not.toBeNull();
    expect(screen.getByTestId('hub-search')).not.toBeNull();
  });
});
