// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const { designsTabRender, libraryPlugin, listConversations } = vi.hoisted(() => ({
  designsTabRender: vi.fn(),
  libraryPlugin: {
    id: 'validated-library-plugin',
    title: 'Validated Library Plugin',
    version: '1.0.0',
    trust: 'trusted',
    sourceKind: 'local',
    source: '/plugins/validated-library-plugin',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: '/plugins/validated-library-plugin',
    installedAt: 1,
    updatedAt: 1,
    manifest: {
      name: 'validated-library-plugin',
      title: 'Validated Library Plugin',
      version: '1.0.0',
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        mode: 'prototype',
        visualReference: { characteristics: ['Clear hierarchy and restrained motion.'] },
        useCase: { query: 'Draft a {{topic}} prototype.' },
      },
    },
  },
  listConversations: vi.fn(),
}));

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
vi.mock('../../src/components/DesignsTab', () => ({
  DesignsTab: (props: { projects: Project[] }) => {
    designsTabRender(props.projects.length);
    return null;
  },
}));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({
  PluginsView: ({ onUsePlugin }: {
    onUsePlugin?: (record: typeof libraryPlugin, action: 'use-with-query') => void;
  }) => (
    <button
      type="button"
      data-testid="test-library-use-with-query"
      onClick={() => onUsePlugin?.(libraryPlugin, 'use-with-query')}
    >
      Use validated plugin with query
    </button>
  ),
}));
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

function renderEntryShell(projects: Project[] = [project]) {
  const onCreateProject = vi.fn(() => true);
  const onOpenSettings = vi.fn();
  render(
    <EntryShell
      skills={skills}
      designTemplates={[]}
      designSystems={[]}
      projects={projects}
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('EntryShell production hub wiring', () => {
  it('does not start the hidden project grid fan-out while loading live work at scale', async () => {
    const projects = Array.from({ length: 543 }, (_, index): Project => ({
      id: `idle-${index}`,
      name: `Idle project ${index}`,
      skillId: null,
      designSystemId: null,
      createdAt: index,
      updatedAt: index,
    }));
    projects.push({
      ...project,
      id: 'live-project',
      status: { value: 'running', updatedAt: 1 },
    });
    listConversations.mockImplementation(async (projectId: string) => projectId === 'live-project'
      ? [{
          id: 'live-session',
          projectId,
          title: 'Live session',
          createdAt: 1,
          updatedAt: 1,
          latestRun: { status: 'running' },
        }]
      : []);

    renderEntryShell(projects);

    await screen.findByTestId('hub-live-time');
    expect(projects).toHaveLength(544);
    expect(designsTabRender).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('hub-library'));
    fireEvent.click(await screen.findByTestId('hub-library-projects'));
    await waitFor(() => expect(designsTabRender).toHaveBeenCalledWith(544));
  });

  it('forwards a validated Library plugin handoff into the Hub composer', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [libraryPlugin] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/plugins/validated-library-plugin/apply')) {
        return new Response(JSON.stringify({
          ok: true,
          query: 'Draft a topic prototype.',
          contextItems: [],
          inputs: [],
          assets: [],
          mcpServers: [],
          projectMetadata: {},
          trust: 'trusted',
          capabilitiesGranted: ['prompt:inject'],
          capabilitiesRequired: ['prompt:inject'],
          appliedPlugin: {
            snapshotId: 'validated-library-snapshot',
            pluginId: libraryPlugin.id,
            pluginVersion: libraryPlugin.version,
            manifestSourceDigest: 'a'.repeat(64),
            inputs: {},
            resolvedContext: { items: [] },
            capabilitiesGranted: ['prompt:inject'],
            capabilitiesRequired: ['prompt:inject'],
            assetsStaged: [],
            taskKind: 'new-generation',
            appliedAt: 1,
            mcpServers: [],
            status: 'fresh',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderEntryShell();
    await screen.findByTestId('home-hero-input');
    fireEvent.click(screen.getByTestId('hub-library'));
    fireEvent.click(await screen.findByTestId('hub-library-plugins'));
    fireEvent.click(await screen.findByTestId('test-library-use-with-query'));

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin').textContent).toContain('Validated Library Plugin');
      expect(screen.getByTestId('home-hero-input').textContent).toContain('Draft a topic prototype.');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/validated-library-plugin/apply',
      expect.anything(),
    );
  });

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
