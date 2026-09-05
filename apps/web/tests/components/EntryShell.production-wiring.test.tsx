// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listConversations,
    readConversations: readConversationsFromListMock(listConversations),
  };
});
vi.mock('@readable-studio/host', () => ({
  isReadableStudioHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => 'winuser' }));
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: () => null }));
vi.mock('../../src/components/EntryNavRail', () => ({ EntryNavRail: () => null }));
vi.mock('../../src/components/DesignsTab', () => ({ DesignsTab: () => null }));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));

import { EntryShell } from '../../src/components/EntryShell';
import type { Project, SkillSummary } from '../../src/types';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

const project: Project = {
  id: 'p1',
  name: 'Quarterly report',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const skills: SkillSummary[] = [{
  id: 'prototype-skill',
  name: 'Prototype',
  description: 'Build prototypes',
  mode: 'prototype',
  surface: 'web',
  previewType: 'html',
  designSystemRequired: true,
  defaultFor: ['prototype'],
  triggers: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Build a prototype.',
  aggregatesExamples: false,
}];

function renderEntryShell() {
  const onCreateProject = vi.fn(() => true);
  const onOpenSettings = vi.fn();
  render(
    <EntryShell
      skills={skills}
      designTemplates={[]}
      designSystems={[]}
      projects={[project]}
      templates={[]}
      defaultDesignSystemId={null}
      config={{
        mode: 'api', apiKey: '', baseUrl: '', model: '', agentId: null,
        skillId: null, designSystemId: null,
      }}
      agents={[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onConfigPersist={vi.fn()}
      onRefreshAgents={vi.fn(() => [])}
      onThemeChange={vi.fn()}
      onCreateProject={onCreateProject}
      onCreatePluginShareProject={vi.fn()}
      onImportClaudeDesign={vi.fn()}
      onImportFolder={vi.fn()}
      onImportFolderResponse={vi.fn()}
      onOpenProject={vi.fn()}
      onDeleteProject={vi.fn()}
      onRenameProject={vi.fn()}
      onChangeDefaultDesignSystem={vi.fn()}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onCreateProject, onOpenSettings };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  listConversations.mockResolvedValue([]);
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.clearAllMocks();
});

describe('EntryShell production hub wiring', () => {
  it('forwards New Project modal creation through handleCreate with normalized input', async () => {
    const { onCreateProject } = renderEntryShell();
    await screen.findByTestId('home-hero-input');

    fireEvent.click(screen.getByTestId('hub-new-project'));
    const body = await screen.findByTestId('new-project-modal');
    fireEvent.change(within(body).getByTestId('new-project-name'), {
      target: { value: '  Advanced wired project  ' },
    });
    fireEvent.click(within(body).getByTestId('create-project'));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject).toHaveBeenCalledWith({
      name: 'Advanced wired project',
      skillId: 'prototype-skill',
      designSystemId: null,
      metadata: {
        kind: 'prototype',
        platform: 'responsive',
        platformTargets: ['responsive'],
        fidelity: 'high-fidelity',
        nameSource: 'user',
      },
      conversationMode: 'design',
      requestId: expect.any(String),
      pluginId: 'example-web-prototype',
      pluginInputs: {
        artifactKind: 'web prototype',
        fidelity: 'high-fidelity',
        audience: 'product evaluators',
        designSystem: 'the active project design system',
        template: 'the bundled web prototype seed',
      },
    });
  });

  it('has no Advanced / Import disclosure on the Hub', async () => {
    renderEntryShell();
    await screen.findByTestId('home-hero-input');

    expect(screen.queryByTestId('new-project-advanced')).toBeNull();
    expect(screen.queryByTestId('new-project-advanced-toggle')).toBeNull();
    expect(screen.queryByTestId('new-project-advanced-body')).toBeNull();
    // The panel itself must not be mounted anywhere outside the modal.
    expect(screen.queryByTestId('new-project-panel')).toBeNull();
  });

  it('keeps every relocated pre-creation control reachable in the New Project modal', async () => {
    renderEntryShell();
    await screen.findByTestId('home-hero-input');

    fireEvent.click(screen.getByTestId('hub-new-project'));
    const modal = await screen.findByTestId('new-project-modal');
    const panel = within(modal).getByTestId('new-project-panel');

    // 1. working-directory picker
    const workingDir = panel.querySelector('button.newproj-working-dir');
    expect(workingDir).not.toBeNull();
    expect((workingDir as HTMLButtonElement).disabled).toBe(false);

    // 2. Claude ZIP import (button + its file input)
    const zip = within(panel).getByTestId('new-project-import-claude-zip') as HTMLButtonElement;
    expect(zip.disabled).toBe(false);
    const zipInput = within(panel).getByTestId('new-project-import-claude-zip-input');
    expect(zipInput.getAttribute('type')).toBe('file');

    // 3. open-folder import (host bridge is available in this render)
    const openFolder = within(panel).getByTestId('new-project-import-folder') as HTMLButtonElement;
    expect(openFolder.disabled).toBe(false);

    // 4. template picker tab
    const templateTab = within(panel).getByTestId('new-project-tab-template') as HTMLButtonElement;
    expect(templateTab.disabled).toBe(false);
    fireEvent.click(templateTab);
    expect(templateTab.getAttribute('aria-selected')).toBe('true');
  });

  it('maps the hub workspace-folder item to Project Locations settings', async () => {
    const { onOpenSettings } = renderEntryShell();
    await screen.findByTestId('hub-library');

    fireEvent.click(screen.getByTestId('hub-library'));
    fireEvent.click(await screen.findByTestId('hub-workspace-folder'));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith('projectLocations');
  });
});
