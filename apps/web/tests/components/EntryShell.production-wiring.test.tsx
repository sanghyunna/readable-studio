// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

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

vi.mock('../../src/state/rail', async (original) => ({
  ...await original<typeof import('../../src/state/rail')>(),
  fetchRail: async () => ({ ok: true, rail: { folders: [], recents: [{ id: 'live-session', workspaceId: 'live-project', folderId: null, title: 'Live session', createdAt: 1, updatedAt: 1, messageCount: 1, state: 'running', workspaceSessionCount: 1 }], pinned: [], generatedAt: 1 } }),
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
import { HubRail } from '../../src/components/hub/HubRail';
import { HubRailProvider } from '../../src/components/hub/HubRailContext';
import { HubRailOverlays } from '../../src/components/hub/HubRailOverlays';
import { useHubRailController } from '../../src/components/hub/useHubRailController';
import { navigate } from '../../src/router';
import type { Project, SkillSummary } from '../../src/types';
import { setHomeHeroPrompt, homeHeroPromptText } from '../helpers/home-hero-lexical';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { templatePromptBoundary } from '../../src/components/home-hero/templatePrompt';

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

function renderEntryShell(projects: Project[] = [project], model = '') {
  const onCreateProject = vi.fn<ComponentProps<typeof EntryShell>['onCreateProject']>(() => true);
  const onOpenSettings = vi.fn();
  const onNewProject = vi.fn();
  const onCreateFromTemplate = vi.fn(() => true);

  function ShellWithPersistentRail() {
    const rail = useHubRailController({
      currentSessionId: null,
      onOpenSession: vi.fn(),
      onNewProject,
      onNavigateDestination: vi.fn(),
    });

    return (
      <HubRailProvider value={rail}>
        <HubRail
          onOpenDestination={(destination) => navigate({ kind: 'home', view: destination })}
          onOpenSettings={() => onOpenSettings()}
          onOpenWorkspaceFolder={() => onOpenSettings('projectLocations')}
          onThemeChange={vi.fn()}
        />
        <EntryShell
          skills={skills}
          designTemplates={[]}
          designSystems={[]}
          projects={projects}
          templates={[]}
          defaultDesignSystemId={null}
          config={{
            mode: 'api', apiKey: '', baseUrl: '', model, agentId: null,
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
          projectImportHandlers={{ onCreateFromTemplate }}
          onOpenProject={vi.fn()}
          onDeleteProject={vi.fn()}
          onRenameProject={vi.fn()}
          onChangeDefaultDesignSystem={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
        <HubRailOverlays />
      </HubRailProvider>
    );
  }

  render(<ShellWithPersistentRail />);
  return { onCreateProject, onOpenSettings, onNewProject, onCreateFromTemplate };
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
  it('creates the imported deck project request with a skill and no plugin fields', async () => {
    const template = {
      id: 'user-board-deck', name: 'Board deck', description: 'PRIVATE_DECK_BODY_723',
      source: 'user', mode: 'deck', userImported: true,
      thumbnail: { status: 'pending', source: null, updatedAt: '2026-10-14' },
    };
    writeHomeGuideStage('done');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/plugins') return Response.json({ plugins: [] });
      if (input === '/api/design-templates') return Response.json({ designTemplates: [template] });
      return Response.json({});
    }));
    const { onCreateProject } = renderEntryShell([project], 'test-api-model');
    const title = await screen.findByText(template.name);
    await act(async () => { fireEvent.click(title.closest('button')!); });
    expect(homeHeroPromptText().trim()).toBe('');
    expect(homeHeroPromptText()).not.toContain(template.description);
    await act(async () => { setHomeHeroPrompt('Our revenue was 42 this quarter.'); });
    await act(async () => { fireEvent.click(screen.getByTestId('home-hero-submit')); });
    expect(onCreateProject).toHaveBeenCalledOnce();
    const request = onCreateProject.mock.calls[0]![0];
    expect(request).toMatchObject({
      skillId: template.id,
      metadata: {
        kind: 'deck',
        templateRef: {
          id: template.id, name: template.name,
          boundary: templatePromptBoundary(template.description, 'Our revenue was 42 this quarter.'),
        },
      },
    });
    expect(request).not.toHaveProperty('pluginId');
    expect(request).not.toHaveProperty('pluginType');
    expect(request).not.toHaveProperty('appliedPluginSnapshotId');
  });

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

  // The end-to-end navigate + focus contract is exercised through the real
  // App owner in App.new-project-navigates.test.tsx; the shell owns no modal.
  it('routes Home New Project through the rail controller and focuses the composer', async () => {
    const { onNewProject, onCreateProject } = renderEntryShell();
    await act(async () => { fireEvent.click(screen.getByTestId('hub-new-session')); });
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(onCreateProject).not.toHaveBeenCalled();
    expect(screen.queryByTestId('new-project-modal')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-input'));
  });

  it('routes the command palette template path to the composer "+" menu template list', async () => {
    renderEntryShell();
    await act(async () => { fireEvent.click(screen.getByTestId('hub-open-palette')); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('hub-palette-item-command-create-template'));
    });
    expect(await screen.findByTestId('composer-plus-templates-list')).toBeTruthy();
    expect(screen.queryByTestId('new-project-modal')).toBeNull();
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
