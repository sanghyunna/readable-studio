// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { HubHome } from '../../src/components/hub/HubHome';
import type { Project, ProjectTemplate, SkillSummary } from '../../src/types';
import { navigate } from '../../src/router';
import { trackProjectCreateResult } from '../../src/analytics/events';
import { isReadableStudioHostAvailable, pickAndImportHostProject } from '@readable-studio/host';
import {
  createProject, deleteTemplate, getProject, importClaudeDesignZip,
  importFolderProject, listTemplates, pickLocalFolderPath,
} from '../../src/state/projects';

vi.mock('../../src/components/hub/HubHome', () => ({
  // The stage exposes Template; the real App-owned rail owns New Project.
  HubHome: ({ onOpenNewProject }: ComponentProps<typeof HubHome>) => (
    <button data-testid="hub-template" onClick={() => onOpenNewProject?.('template')}>Template</button>
  ),
}));
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: () => null }));
vi.mock('../../src/components/DesignsTab', () => ({
  DesignsTab: ({ onNewProject }: { onNewProject: () => void }) => (
    <button data-testid="projects-new-project" onClick={onNewProject}>New project</button>
  ),
}));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));
vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <main data-testid="project-view" />,
}));
vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../src/components/pet/pets', () => ({ migrateCustomPetAtlas: async () => null }));
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => 'winuser' }));
vi.mock('../../src/analytics/events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/analytics/events')>(),
  trackProjectCreateResult: vi.fn(),
}));
vi.mock('@readable-studio/host', async (importOriginal) => ({
  ...await importOriginal<typeof import('@readable-studio/host')>(),
  isReadableStudioHostAvailable: vi.fn(() => true),
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  daemonIsLive: async () => true,
  fetchAgentsStream: async () => [],
  fetchSkills: async () => skills,
  fetchDesignTemplates: async () => [],
  fetchDesignSystems: async () => [],
  fetchAppVersionInfo: async () => null,
}));
vi.mock('../../src/state/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/config')>(),
  loadConfig: () => ({
    mode: 'api', apiKey: '', baseUrl: '', model: '', agentId: null,
    skillId: null, designSystemId: null, onboardingCompleted: true,
  }),
  fetchDaemonConfig: async () => ({}),
  saveConfig: vi.fn(),
  syncConfigToDaemon: async () => undefined,
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listProjects: async () => [project],
  listTemplates: vi.fn(),
  createProject: vi.fn(),
  deleteTemplate: vi.fn(),
  getProject: vi.fn(),
  importClaudeDesignZip: vi.fn(),
  importFolderProject: vi.fn(),
  pickLocalFolderPath: vi.fn(),
}));

const project: Project = {
  id: 'existing', name: 'Existing', skillId: null, designSystemId: null,
  createdAt: 1, updatedAt: 1,
};
const createdProject: Project = { ...project, id: 'created', name: 'Created' };
const template: ProjectTemplate = {
  id: 'saved', name: 'Saved starter', description: '',
  files: [{ name: 'prototype/App.jsx', content: '' }], createdAt: 1,
};
const skills: SkillSummary[] = [{
  id: 'prototype-skill', name: 'Prototype', description: 'Build prototypes',
  mode: 'prototype', surface: 'web', previewType: 'html', designSystemRequired: true,
  defaultFor: ['prototype'], triggers: [], upstream: null, hasBody: true,
  examplePrompt: 'Build a prototype.', aggregatesExamples: false,
}];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  // Execute deferred bootstrap at a microtask boundary, not by elapsed time.
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
  vi.mocked(listTemplates).mockResolvedValue([template]);
  vi.mocked(createProject).mockResolvedValue({ project: createdProject, conversationId: 'conversation' });
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(deleteTemplate).mockResolvedValue(true);
  vi.mocked(isReadableStudioHostAvailable).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderApp() {
  await act(async () => { render(<App />); });
}

async function click(testId: string) {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)); });
}

function expectClosed() {
  expect(screen.queryByTestId('new-project-modal')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
}

describe('App-owned New Project modal', () => {
  it('keeps only inactive mounted entry views inert across route changes', async () => {
    await renderApp();
    const home = screen.getByTestId('entry-view-home');
    const projects = screen.getByTestId('entry-view-projects');
    expect(home.hasAttribute('inert')).toBe(false);
    expect(projects.getAttribute('inert')).toBe('');
    expect(projects.style.display).toBe('none');
    expect(projects.getAttribute('aria-hidden')).toBe('true');

    await act(async () => { navigate({ kind: 'home', view: 'projects' }); });
    expect(screen.getByTestId('entry-view-home')).toBe(home);
    expect(screen.getByTestId('entry-view-projects')).toBe(projects);
    expect(home.getAttribute('inert')).toBe('');
    expect(home.style.display).toBe('none');
    expect(home.getAttribute('aria-hidden')).toBe('true');
    expect(projects.hasAttribute('inert')).toBe(false);
    expect(projects.style.display).toBe('');
    expect(projects.getAttribute('aria-hidden')).toBe('false');

    await act(async () => { navigate({ kind: 'home', view: 'home' }); });
    expect(home.hasAttribute('inert')).toBe(false);
    expect(home.style.display).toBe('');
    expect(home.getAttribute('aria-hidden')).toBe('false');
    expect(projects.getAttribute('inert')).toBe('');
  });

  it('opens from the workspace without navigating away, then closes and reopens from Home', async () => {
    window.history.replaceState(null, '', '/projects/existing');
    await renderApp();
    await click('hub-new-project');
    expect(window.location.pathname).toBe('/projects/existing');
    expect(screen.getAllByTestId('new-project-modal')).toHaveLength(1);
    expect(screen.getByTestId('new-project-tab-prototype').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expectClosed();
    await act(async () => { navigate({ kind: 'home', view: 'home' }); });
    await click('hub-new-project');
    expect(screen.getAllByTestId('new-project-modal')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('new-project-modal'), { clientY: 100 });
    expectClosed();
  });

  it('forwards template and Projects entry paths through EntryView and resets the initial tab on reopen', async () => {
    await renderApp();
    await click('hub-template');
    expect(screen.getByTestId('new-project-tab-template').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => { navigate({ kind: 'home', view: 'projects' }); });
    await click('projects-new-project');
    expect(screen.getByTestId('new-project-tab-prototype').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await click('hub-new-project');
    expect(screen.getAllByTestId('new-project-modal')).toHaveLength(1);
  });

  it('preserves normalized prototype input, plugin defaults and creation analytics', async () => {
    await renderApp();
    await click('hub-new-project');
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: '  Advanced wired project  ' },
    });
    await click('create-project');
    expect(createProject).toHaveBeenCalledExactlyOnceWith({
      name: 'Advanced wired project', skillId: 'prototype-skill', designSystemId: null,
      pendingPrompt: undefined,
      metadata: {
        kind: 'prototype', platform: 'responsive', platformTargets: ['responsive'],
        fidelity: 'high-fidelity', nameSource: 'user',
      },
      conversationMode: 'design', pluginId: 'example-web-prototype',
      pluginInputs: {
        artifactKind: 'web prototype', fidelity: 'high-fidelity', audience: 'product evaluators',
        designSystem: 'the active project design system', template: 'the bundled web prototype seed',
      },
    });
    expect(trackProjectCreateResult).toHaveBeenCalledWith(
      expect.any(Function), expect.objectContaining({ result: 'success', plugin_id: 'example-web-prototype' }),
      { requestId: expect.any(String) },
    );
    expect(window.location.pathname).toBe('/projects/created');
    expectClosed();
  });

  it.each([
    ['deck', 'example-simple-deck', { deckType: 'pitch deck', topic: 'My project', audience: 'decision makers', slideCount: '10-15 pages', speakerNotes: 'no speaker notes', designSystem: 'the active project design system' }],
    ['other', 'readable-new-generation', { artifactKind: 'custom design artifact', audience: 'product and design reviewers', topic: 'My project' }],
    ['template', 'readable-new-generation', { artifactKind: 'artifact based on a saved template', audience: 'product and design reviewers', topic: 'Saved starter' }],
  ] as const)('preserves %s plugin inputs', async (tab, pluginId, pluginInputs) => {
    await renderApp();
    await click('hub-new-project');
    await click(`new-project-tab-${tab}`);
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'My project' } });
    await click('create-project');
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ pluginId, pluginInputs }));
  });

  it('does not bind a scenario plugin to an Ask project', async () => {
    await renderApp();
    await click('hub-new-project');
    await click('newproj-mode-chat');
    await click('create-project');
    const input = vi.mocked(createProject).mock.calls[0]?.[0];
    expect(input).toMatchObject({ conversationMode: 'chat' });
    expect(input).not.toHaveProperty('pluginId');
    expect(input).not.toHaveProperty('pluginInputs');
  });

  it('keeps failed creation open and closes only after a successful retry', async () => {
    vi.mocked(createProject).mockResolvedValueOnce(null);
    await renderApp();
    await click('hub-new-project');
    await click('create-project');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('new-project-modal')).toBeTruthy();
    await click('create-project');
    expect(createProject).toHaveBeenCalledTimes(2);
    expectClosed();
  });

  it('keeps all relocated pre-creation controls reachable', async () => {
    await renderApp();
    await click('hub-new-project');
    const panel = within(screen.getByTestId('new-project-modal')).getByTestId('new-project-panel');
    expect(panel.querySelector<HTMLButtonElement>('button.newproj-working-dir')?.disabled).toBe(false);
    expect(within(panel).getByTestId<HTMLButtonElement>('new-project-import-claude-zip').disabled).toBe(false);
    expect(within(panel).getByTestId('new-project-import-claude-zip-input').getAttribute('type')).toBe('file');
    expect(within(panel).getByTestId<HTMLButtonElement>('new-project-import-folder').disabled).toBe(false);
    await click('new-project-tab-template');
    expect(screen.getByTestId('new-project-tab-template').getAttribute('aria-selected')).toBe('true');
  });

  it('refreshes templates after successful deletion but retains them after failure', async () => {
    vi.mocked(deleteTemplate).mockResolvedValueOnce(false);
    await renderApp();
    await click('hub-template');
    const previousReads = vi.mocked(listTemplates).mock.calls.length;
    fireEvent.click(screen.getByLabelText(/delete template/i));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete template' })); });
    expect(listTemplates).toHaveBeenCalledTimes(previousReads);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    vi.mocked(listTemplates).mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete template' })); });
    expect(deleteTemplate).toHaveBeenCalledWith('saved');
    expect(listTemplates).toHaveBeenCalledTimes(previousReads + 1);
    expect(screen.queryByLabelText(/delete template/i)).toBeNull();
  });

  it('keeps failed ZIP import open, then closes and routes after successful retry', async () => {
    vi.mocked(importClaudeDesignZip)
      .mockRejectedValueOnce(new Error('Invalid ZIP'))
      .mockResolvedValueOnce({ project: createdProject, entryFile: 'index.html', conversationId: 'conversation' });
    await renderApp();
    await click('hub-new-project');
    const file = new File(['zip'], 'design.zip', { type: 'application/zip' });
    const upload = async () => {
      await act(async () => {
        fireEvent.change(screen.getByTestId('new-project-import-claude-zip-input'), { target: { files: [file] } });
      });
    };
    await upload();
    expect(screen.getByTestId('new-project-modal')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    await upload();
    expect(importClaudeDesignZip).toHaveBeenCalledWith(file);
    expect(window.location.pathname).toContain('/projects/created');
    expectClosed();
  });

  it.each([true, false])('closes after folder import (desktop=%s)', async (desktop) => {
    vi.mocked(isReadableStudioHostAvailable).mockReturnValue(desktop);
    vi.mocked(pickAndImportHostProject).mockResolvedValue({ ok: true, projectId: 'created', conversationId: 'conversation', entryFile: null });
    vi.mocked(getProject).mockResolvedValue(createdProject);
    vi.mocked(pickLocalFolderPath).mockResolvedValue('D:/project');
    vi.mocked(importFolderProject).mockResolvedValue({ project: createdProject, conversationId: 'conversation', entryFile: null });
    await renderApp();
    await click('hub-new-project');
    await click('new-project-import-folder');
    if (desktop) {
      expect(pickAndImportHostProject).toHaveBeenCalledWith({ skillId: 'prototype-skill' });
      expect(getProject).toHaveBeenCalledWith('created');
    } else {
      expect(importFolderProject).toHaveBeenCalledWith({ baseDir: 'D:/project' });
    }
    expect(window.location.pathname).toBe('/projects/created');
    expectClosed();
  });
});
