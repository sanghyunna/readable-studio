// @vitest-environment jsdom
//
// The Advanced / Import disclosure shipped but never rendered: it is guarded by
// `onCreateProject` inside HomeView, HomeView is only rendered by HubHome, and
// HubHome neither declared nor forwarded that prop — so the guard was
// permanently false and `new-project-advanced` was absent from every real hub
// render. NewProjectAdvanced's own spec renders the component directly, which is
// exactly why the dead wiring went unnoticed.
//
// These tests therefore exercise the REAL hub tree (HubHome -> HomeView ->
// NewProjectAdvanced). Breaking the forward in HubHome, or the guard chain in
// HomeView, must fail here.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

vi.mock('@readable-studio/host', () => ({
  isReadableStudioHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));

import { HubHome } from '../../src/components/hub/HubHome';
import type { CreateInput } from '../../src/components/NewProjectPanel';
import type { Project, ProjectTemplate, SkillSummary } from '../../src/types';

// jsdom ships no ResizeObserver; NewProjectPanel observes its tab strip.
class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Quarterly report', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

const SKILLS: SkillSummary[] = [
  {
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
  },
];

const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'tmpl-landing',
    name: 'Landing Page',
    description: 'A saved landing page starter.',
    files: [{ name: 'prototype/App.jsx', content: '' }],
    createdAt: 1714867200000,
  },
];

type CreateProjectHandler = (input: CreateInput & { requestId?: string }) => boolean;

function renderHub(
  overrides: Partial<Parameters<typeof HubHome>[0]> = {},
): { onCreateProject: CreateProjectHandler } {
  const onCreateProject: CreateProjectHandler =
    (overrides.onCreateProject as CreateProjectHandler | undefined) ??
    vi.fn<CreateProjectHandler>(() => true);
  render(
    <HubHome
      projects={PROJECTS}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
      skills={SKILLS}
      templates={TEMPLATES}
      onCreateProject={onCreateProject}
      onImportClaudeDesign={vi.fn()}
      onImportFolderResponse={vi.fn()}
      {...overrides}
    />,
  );
  return { onCreateProject };
}

describe('hub advanced/import disclosure mounts in the real hub tree', () => {
  it('renders exactly one disclosure on the hub project panel, closed by default', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    await screen.findByTestId('home-hero-input');

    // The bug this pins: count was 0 on the live hub in both themes.
    expect(document.querySelectorAll('[data-testid="new-project-advanced"]')).toHaveLength(1);

    const toggle = screen.getByTestId('new-project-advanced-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Closed by default: the creation stack must not be in the tree, so it can
    // never become a gate on the composer's main path.
    expect(screen.queryByTestId('new-project-advanced-body')).toBeNull();
    expect(screen.queryByTestId('new-project-panel')).toBeNull();
    expect(document.querySelector('.newproj-working-dir')).toBeNull();

    // The composer's own send path is still the main path and stays live.
    expect(screen.getByTestId('home-hero-submit')).toBeTruthy();
  });

  it('reveals the full unmodified creation panel on the hub when opened', async () => {
    listConversations.mockResolvedValue([]);
    renderHub();
    await screen.findByTestId('home-hero-input');

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));

    const body = await screen.findByTestId('new-project-advanced-body');
    expect(screen.getByTestId('new-project-advanced-toggle').getAttribute('aria-expanded'))
      .toBe('true');
    // The full unmodified creation stack, not a trimmed subset.
    expect(within(body).getByTestId('new-project-panel')).toBeTruthy();
    // The genuinely pre-creation controls: working folder, imports, templates.
    expect(body.querySelector('.newproj-working-dir')).toBeTruthy();
    expect(within(body).getByTestId('new-project-import-claude-zip')).toBeTruthy();
    expect(within(body).getByTestId('new-project-import-folder')).toBeTruthy();
    expect(within(body).getByTestId('new-project-tab-template')).toBeTruthy();
  });

  it('creates through the host handler the hub was given, not a private path', async () => {
    listConversations.mockResolvedValue([]);
    const onCreateProject = vi.fn<CreateProjectHandler>(() => true);
    renderHub({ onCreateProject });
    await screen.findByTestId('home-hero-input');

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));
    const body = await screen.findByTestId('new-project-advanced-body');

    fireEvent.change(within(body).getByTestId('new-project-name'), {
      target: { value: 'Advanced wired project' },
    });
    fireEvent.click(within(body).getByTestId('create-project'));

    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledTimes(1);
    });
    const [input] = onCreateProject.mock.calls[0] ?? [];
    expect(input?.name).toBe('Advanced wired project');
  });

  it('omits the disclosure when the host owns no creation handler', async () => {
    listConversations.mockResolvedValue([]);
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        skills={SKILLS}
        templates={TEMPLATES}
      />,
    );
    await screen.findByTestId('home-hero-input');

    expect(document.querySelectorAll('[data-testid="new-project-advanced"]')).toHaveLength(0);
  });
});
