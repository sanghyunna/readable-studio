// @vitest-environment jsdom

// The `저사양 모드` (low-spec) toggle lives in the Hub chrome so a user on a
// slow or remote PC can drop glass + decorative motion without opening
// Settings. It is a pressed-state button (never a checkbox), and it must sit
// beside the existing controls rather than replace any of them.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Report', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

function renderHub(profile: 'full' | 'low', locale: 'en' | 'ko' = 'en') {
  const onPerformanceProfileChange = vi.fn<(profile: 'full' | 'low') => void>();
  const view = render(
    <I18nProvider initial={locale}>
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onImportFile={vi.fn()}
        performanceProfile={profile}
        onPerformanceProfileChange={onPerformanceProfileChange}
        executionSwitcher={<div data-testid="execution-switcher-probe" />}
      />
    </I18nProvider>,
  );
  return { ...view, onPerformanceProfileChange };
}

function toggle(): HTMLButtonElement {
  const node = screen.getByTestId('hub-low-spec-toggle');
  if (!(node instanceof HTMLButtonElement)) throw new Error('low-spec toggle is not a button');
  return node;
}

describe('Hub low-spec toggle', () => {
  it('is a visible, labeled button with icon + text and no checkbox UI', () => {
    renderHub('full');
    const button = toggle();
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toContain(en['hub.lowSpecMode']);
    expect(button.querySelector('svg')).not.toBeNull();
    expect(ko['hub.lowSpecMode']).toBe('저사양 모드');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    // Chrome slot, never inside the prompt surface.
    expect(button.closest('[data-testid="home-view"]')).toBeNull();
    expect(button.closest('.hub__stage')).not.toBeNull();
  });

  it('keeps every existing Hub control mounted beside the toggle', () => {
    renderHub('full');
    expect(screen.getByTestId('home-view')).not.toBeNull();
    expect(screen.getByTestId('execution-switcher-probe')).not.toBeNull();
    expect(screen.getByTestId('hub-drop-to-edit')).not.toBeNull();
    expect(screen.getByTestId('hub-new-project')).not.toBeNull();
    expect(screen.getByTestId('hub-search')).not.toBeNull();
  });

  it('reports the opposite profile on click and reflects the low state', () => {
    const { onPerformanceProfileChange } = renderHub('low', 'ko');
    const button = toggle();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(within(button).getByText('저사양 모드')).not.toBeNull();
    fireEvent.click(button);
    expect(onPerformanceProfileChange).toHaveBeenCalledWith('full');
  });

  it('toggles from the keyboard as a native button (Enter/Space click semantics)', () => {
    const { onPerformanceProfileChange } = renderHub('full');
    const button = toggle();
    button.focus();
    expect(document.activeElement).toBe(button);
    // jsdom does not synthesize click from keydown; a native <button> does in
    // every browser. Asserting the element type + a click keeps the contract.
    fireEvent.click(button);
    expect(onPerformanceProfileChange).toHaveBeenCalledWith('low');
  });
});
