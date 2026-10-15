// @vitest-environment jsdom

// The old hero let the user pick a design system before creating. The hub's
// composer must not silently drop that choice.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';
import { HomeView } from '../../src/components/HomeView';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    listConversations,
    readConversations: readConversationsFromListMock(listConversations),
  };
});

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

const WEB_PROTOTYPE_PLUGIN = {
  id: 'example-web-prototype',
  title: 'Web Prototype',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/web-prototype',
  capabilitiesGranted: [] as string[],
  fsPath: '/tmp/web-prototype',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'example-web-prototype',
    title: 'Web Prototype',
    version: '0.1.0',
    description: 'General-purpose desktop web prototype.',
    readable: {
      kind: 'scenario' as const,
      taskKind: 'new-generation' as const,
      useCase: {
        query: 'Build a {{fidelity}} {{artifactKind}} for {{audience}} using {{designSystem}} from {{template}}.',
      },
      inputs: [
        { name: 'artifactKind', type: 'string' as const, required: true, default: 'web prototype', label: 'Artifact kind' },
        { name: 'fidelity', type: 'select' as const, required: true, options: ['wireframe', 'high-fidelity'], default: 'high-fidelity', label: 'Fidelity' },
        { name: 'audience', type: 'string' as const, required: true, default: 'product evaluators', label: 'Audience' },
        { name: 'designSystem', type: 'string' as const, default: 'the active project design system', label: 'Design system' },
        { name: 'template', type: 'string' as const, default: 'the bundled web prototype seed', label: 'Template' },
      ],
    },
  },
};

const WEB_PROTOTYPE_APPLY_RESULT = {
  query: 'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
  contextItems: [],
  inputs: WEB_PROTOTYPE_PLUGIN.manifest.readable.inputs,
  assets: [],
  mcpServers: [],
  trust: 'trusted' as const,
  capabilitiesGranted: [] as string[],
  capabilitiesRequired: [] as string[],
  appliedPlugin: {
    snapshotId: 'snap-web-prototype',
    pluginId: 'example-web-prototype',
    pluginVersion: '0.1.0',
    manifestSourceDigest: 'a'.repeat(64),
    inputs: {
      artifactKind: 'web prototype',
      fidelity: 'high-fidelity',
      audience: 'product evaluators',
      designSystem: 'the active project design system',
      template: 'the bundled web prototype seed',
    },
    resolvedContext: { items: [] },
    capabilitiesGranted: [] as string[],
    capabilitiesRequired: [] as string[],
    assetsStaged: [],
    taskKind: 'new-generation' as const,
    appliedAt: 0,
    mcpServers: [],
    status: 'fresh' as const,
  },
  projectMetadata: {},
};

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
  it('submits null designSystemId before the user picks one despite a saved default', async () => {
    listConversations.mockResolvedValue([]);
    const onSubmitPrompt = vi.fn();
    renderHub({ onSubmitPrompt });
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('분기 리포트');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    expect(onSubmitPrompt).toHaveBeenCalledWith('분기 리포트', { designSystemId: null });
  });

  it('submits the chosen design system id when the user explicitly picks one', async () => {
    listConversations.mockResolvedValue([]);
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSubmit = vi.fn();
    render(
      <HomeView
        surface="default"
        projects={PROJECTS}
        projectsLoading={false}
        designSystems={SYSTEMS}
        defaultDesignSystemId="aurora"
        onSubmit={onSubmit}
        onOpenProject={vi.fn()}
        onViewAllProjects={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId('home-hero-rail-prototype'));
    await waitFor(() => expect(screen.queryAllByTestId('home-hero-footer-option-designSystem')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('home-hero-footer-option-designSystem'));
    fireEvent.mouseDown(await within(await screen.findByTestId('project-ds-picker-popover')).findByText('Nord'));
    await waitFor(() => expect(screen.getByTestId('home-hero-footer-option-designSystem').textContent).toContain('Nord'));

    await setHomeHeroPrompt('분기 리포트');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ designSystemId: 'nord' })));
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
    const onCreateFromTemplate = vi.fn();
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        projectImportHandlers={{ onCreateFromTemplate }}
      />,
    );
    await screen.findByTestId('home-hero-input');
    const controls = screen.getByTestId('home-hero-footer-options').querySelectorAll('button');
    // The footer carries no template control: saved templates live in the
    // composer "+" menu ("From template"), reachable from the hub command
    // palette too. Context is the only footer-options button.
    expect(Array.from(controls, (control) => control.dataset.testid)).toEqual([
      'home-hero-context-control',
    ]);
    // The 디자인/질문 mode chip was deliberately removed from the HUB composer;
    // the Hub always starts in design mode and `SessionModeToggle` lives only
    // in the PROJECT chat composer. The hub must therefore render no mode
    // affordance at all — neither the toggle nor either mode label.
    expect(screen.queryByTestId('session-mode-trigger')).toBeNull();
    for (const label of ['Design mode', 'Design', 'Chat', 'Ask']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }

    fireEvent.click(screen.getByTestId('home-hero-context-control'));
    expect(await screen.findByTestId('home-hero-plugin-picker')).toBeTruthy();

    expect(screen.queryByTestId('home-hero-template-control')).toBeNull();
    expect(onCreateFromTemplate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hub-design-system')).toBeNull();
    expect(screen.queryAllByTestId('home-hero-footer-option-designSystem')).toHaveLength(0);
  });
});
