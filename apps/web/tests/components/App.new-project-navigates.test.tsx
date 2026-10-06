// @vitest-environment jsdom

// "새 프로젝트" no longer opens a modal. Every trigger (rail button, Ctrl/Cmd+N,
// the Projects-tab empty-state CTA) lands on the Hub and puts the caret in the
// composer; typing a brief and sending IS project creation now. The imports and
// the saved-template start that used to live in the modal moved into the Hub
// composer's existing "+" menu.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { Project, ProjectTemplate, SkillSummary } from '../../src/types';
import { navigate } from '../../src/router';
import { daemonIsLive } from '../../src/providers/registry';
import { isReadableStudioHostAvailable, pickAndImportHostProject } from '@readable-studio/host';
import {
  createProject, getProject, importClaudeDesignZip,
  importFolderProject, listProjects, listTemplates, pickLocalFolderPath,
} from '../../src/state/projects';

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
vi.mock('@readable-studio/host', async (importOriginal) => ({
  ...await importOriginal<typeof import('@readable-studio/host')>(),
  isReadableStudioHostAvailable: vi.fn(() => true),
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  daemonIsLive: vi.fn(async () => true),
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
  listProjects: vi.fn(async () => [project]),
  listConversations: vi.fn(async () => []),
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
  window.localStorage.setItem('readable-studio:welcome-modal-shown', '1');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(listProjects).mockResolvedValue([project]);
  vi.mocked(listTemplates).mockResolvedValue([template]);
  vi.mocked(createProject).mockResolvedValue({ project: createdProject, conversationId: 'conversation' });
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(isReadableStudioHostAvailable).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function renderApp() {
  await act(async () => { render(<App />); });
}

async function click(testId: string) {
  const target = await screen.findByTestId(testId);
  await act(async () => { fireEvent.click(target); });
}

function expectNoModal() {
  expect(screen.queryByTestId('new-project-modal')).toBeNull();
  expect(screen.queryByTestId('new-project-panel')).toBeNull();
  expect(screen.queryByRole('dialog', { name: /new project/i })).toBeNull();
}

async function expectComposerFocused() {
  const input = await screen.findByTestId('home-hero-input');
  expect(document.activeElement).toBe(input);
  expectNoModal();
}

async function openPlusMenu() {
  await click('home-hero-plus-trigger');
  const popup = document.querySelector<HTMLElement>('.plus-menu__popup');
  if (!popup) throw new Error('composer + menu did not open');
  return popup;
}

// Captures the first reconnect probe (1 s backoff) and the 60 s "still
// failing" stall timer so a test drives both deterministically.
function holdReconnectTimers() {
  const callbacks: Array<() => void> = [];
  const stalls: Array<() => void> = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === 1_000) { callbacks.push(callback); return 0; }
    if (delay === 60_000) { stalls.push(callback); return 0; }
    return original(callback, delay);
  }) as typeof setTimeout);
  return Object.assign(callbacks, { stalls });
}

describe('startup guards (unchanged by the modal removal)', () => {
  it('does not treat failed project listing as an empty workspace when health was briefly available', async () => {
    vi.mocked(listProjects).mockRejectedValueOnce(new TypeError('connection refused'));
    await renderApp();
    expect(screen.getByTestId('startup-reconnecting')).toBeTruthy();
    expect(screen.queryByTestId('entry-view-home')).toBeNull();
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
  });

  it('shows one calm reconnect state - no startup error, no retry button, no false empty rail - while the daemon is unreachable', async () => {
    const retries = holdReconnectTimers();
    vi.mocked(daemonIsLive).mockResolvedValue(false);
    await renderApp();
    expect(screen.getByTestId('startup-reconnecting')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/데이터를 여는 중|opening your data/i);
    expect(screen.queryByRole('button', { name: /^retry$|^다시 시도$/i })).toBeNull();
    expect(screen.queryByTestId('entry-view-home')).toBeNull();
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
    vi.mocked(daemonIsLive).mockResolvedValue(true);
    expect(retries.length).toBeGreaterThan(0);
    await act(async () => { retries.forEach(retry => retry()); });
    expect(screen.getByTestId('entry-view-home')).toBeTruthy();
    expect(screen.queryByTestId('startup-reconnecting')).toBeNull();
    expect(listProjects).toHaveBeenCalledWith({ strict: true });
  }, 15_000);

  it('escalates to the data-safe startup error with an inline retry button only after reconnecting has stalled', async () => {
    const retries = holdReconnectTimers();
    vi.mocked(daemonIsLive).mockResolvedValue(false);
    await renderApp();
    expect(screen.getByTestId('startup-reconnecting')).toBeTruthy();
    expect(retries.stalls).toHaveLength(1);
    await act(async () => { retries.stalls.forEach(stall => stall()); });
    expect(screen.getByRole('alert').textContent).toMatch(/data|데이터/i);
    expect(screen.getByRole('button', { name: /^retry$|^다시 시도$/i })).toBeTruthy();
    expect(screen.queryByTestId('entry-view-home')).toBeNull();
    expect(screen.queryByTestId('hub-tree-no-projects')).toBeNull();
    vi.mocked(daemonIsLive).mockResolvedValue(true);
    expect(retries.length).toBeGreaterThan(0);
    await act(async () => { retries.forEach(retry => retry()); });
    expect(screen.getByTestId('entry-view-home')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('startup-reconnecting')).toBeNull();
    expect(listProjects).toHaveBeenCalledWith({ strict: true });
  }, 15_000);

  it.each([new Error('HTTP 502'), new Error('HTTP 503'), new Error('HTTP 504'), new SyntaxError('non-JSON proxy body')])
  ('automatically retries a failed strict data-open request without painting an empty workspace (%s)', async error => {
    const retries = holdReconnectTimers();
    vi.mocked(listProjects).mockRejectedValueOnce(error).mockResolvedValue([project]);
    await renderApp();
    expect(screen.getByTestId('startup-reconnecting')).toBeTruthy();
    expect(screen.queryByTestId('entry-view-home')).toBeNull();
    expect(retries.length).toBeGreaterThan(0);
    await act(async () => { retries.forEach(retry => retry()); });
    expect(screen.getByTestId('entry-view-home')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 15_000);

  it('reloads an open project during a daemon gap without opening import and recovers automatically', async () => {
    const retries = holdReconnectTimers();
    window.history.replaceState(null, '', '/projects/existing');
    vi.mocked(daemonIsLive).mockResolvedValue(false);
    let reachable = false;
    const fetcher = vi.fn(async (url: string) => url === '/api/data-import/candidates' && !reachable
      ? new Response('connect ECONNREFUSED', { status: 502 })
      : new Response(JSON.stringify({ state: 'done', candidates: [] })));
    vi.stubGlobal('fetch', fetcher);
    await renderApp();
    expect(screen.getByTestId('startup-reconnecting')).toBeTruthy();
    expect(screen.queryByTestId('data-import-modal')).toBeNull();
    expect(screen.queryByTestId('entry-view-home')).toBeNull();
    vi.mocked(daemonIsLive).mockResolvedValue(true);
    reachable = true;
    expect(retries.length).toBeGreaterThan(0);
    await act(async () => { retries.forEach(retry => retry()); });
    expect(screen.getByTestId('project-view')).toBeTruthy();
    expect(screen.queryByTestId('data-import-modal')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 15_000);

  it('keeps only inactive mounted entry views inert across route changes', async () => {
    await renderApp();
    const home = screen.getByTestId('entry-view-home');
    const projects = screen.getByTestId('entry-view-projects');
    expect(home.hasAttribute('inert')).toBe(false);
    expect(projects.getAttribute('inert')).toBe('');
    await act(async () => { navigate({ kind: 'home', view: 'projects' }); });
    expect(home.getAttribute('inert')).toBe('');
    expect(projects.hasAttribute('inert')).toBe(false);
    await act(async () => { navigate({ kind: 'home', view: 'home' }); });
    expect(home.hasAttribute('inert')).toBe(false);
    expect(projects.getAttribute('inert')).toBe('');
  });
});

describe('새 프로젝트 navigates to the Hub and focuses the composer', () => {
  it('leaves an open project for the Hub and puts the caret in the composer', async () => {
    window.history.replaceState(null, '', '/projects/existing');
    await renderApp();
    expect(await screen.findByTestId('project-view')).toBeTruthy();
    await click('hub-new-project');
    expect(window.location.pathname).toBe('/');
    await expectComposerFocused();
  });

  it('still focuses the composer when already on the Hub (not a no-op)', async () => {
    await renderApp();
    await screen.findByTestId('home-hero-input');
    // Park focus elsewhere first so the assertion proves the click moved it.
    (screen.getByTestId('hub-search') as HTMLInputElement).focus();
    await click('hub-new-project');
    expect(window.location.pathname).toBe('/');
    await expectComposerFocused();
  });

  it('Ctrl/Cmd+N routes through the same path', async () => {
    window.history.replaceState(null, '', '/projects/existing');
    await renderApp();
    await screen.findByTestId('project-view');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    });
    expect(window.location.pathname).toBe('/');
    await expectComposerFocused();
  });

  it('the Projects-tab empty-state CTA lands on the Hub composer', async () => {
    await renderApp();
    await act(async () => { navigate({ kind: 'home', view: 'projects' }); });
    await click('projects-new-project');
    expect(window.location.pathname).toBe('/');
    await expectComposerFocused();
  });

  it('the modal component no longer exists', async () => {
    const modulePath = ['../../src/components', 'NewProjectModal'].join('/');
    await expect(import(/* @vite-ignore */ modulePath)).rejects.toThrow();
    const panelPath = ['../../src/components', 'NewProjectPanel'].join('/');
    await expect(import(/* @vite-ignore */ panelPath)).rejects.toThrow();
  });
});

describe('relocated imports in the Hub composer "+" menu', () => {
  it.each([true, false])('Open folder imports a folder as a project (desktop=%s)', async (desktop) => {
    vi.mocked(isReadableStudioHostAvailable).mockReturnValue(desktop);
    vi.mocked(pickAndImportHostProject).mockResolvedValue({ ok: true, projectId: 'created', conversationId: 'conversation', entryFile: null });
    vi.mocked(getProject).mockResolvedValue(createdProject);
    vi.mocked(pickLocalFolderPath).mockResolvedValue('D:/project');
    vi.mocked(importFolderProject).mockResolvedValue({ project: createdProject, conversationId: 'conversation', entryFile: null });
    await renderApp();
    await screen.findByTestId('home-hero-input');
    await openPlusMenu();
    await click('composer-plus-open-folder');
    if (desktop) {
      expect(pickAndImportHostProject).toHaveBeenCalledWith({ skillId: null });
      expect(getProject).toHaveBeenCalledWith('created');
    } else {
      expect(importFolderProject).toHaveBeenCalledWith({ baseDir: 'D:/project' });
    }
    expect(window.location.pathname).toBe('/projects/created');
    expectNoModal();
  });

  it('Import Claude design ZIP keeps the Hub on failure and routes after a successful retry', async () => {
    vi.mocked(importClaudeDesignZip)
      .mockRejectedValueOnce(new Error('Invalid ZIP'))
      .mockResolvedValueOnce({ project: createdProject, entryFile: 'index.html', conversationId: 'conversation' });
    await renderApp();
    await screen.findByTestId('home-hero-input');
    await openPlusMenu();
    await click('composer-plus-import-claude-zip');
    const file = new File(['zip'], 'design.zip', { type: 'application/zip' });
    const upload = async () => {
      await act(async () => {
        fireEvent.change(screen.getByTestId('composer-plus-import-claude-zip-input'), { target: { files: [file] } });
      });
    };
    await upload();
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('alert').textContent).toContain('Invalid ZIP');
    await openPlusMenu();
    await click('composer-plus-import-claude-zip');
    await upload();
    expect(importClaudeDesignZip).toHaveBeenCalledWith(file);
    expect(window.location.pathname).toContain('/projects/created');
  });

  it('From template lists saved templates and creates the project the way the modal did', async () => {
    await renderApp();
    await screen.findByTestId('home-hero-input');
    const popup = await openPlusMenu();
    await click('composer-plus-templates');
    const row = within(popup).getByTestId('composer-plus-template-saved');
    expect(row.textContent).toContain('Saved starter');
    await act(async () => { fireEvent.click(row); });
    expect(createProject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      skillId: null,
      designSystemId: null,
      metadata: expect.objectContaining({
        kind: 'template', templateId: 'saved', templateLabel: 'Saved starter',
        platform: 'responsive', platformTargets: ['responsive'], nameSource: 'generated',
      }),
      conversationMode: 'design',
      pluginId: 'readable-new-generation',
      pluginInputs: {
        artifactKind: 'artifact based on a saved template',
        audience: 'product and design reviewers',
        topic: 'Saved starter',
      },
    }));
    expect(window.location.pathname).toBe('/projects/created');
  });

  it('shows the save-from-Share hint when no template is saved yet', async () => {
    vi.mocked(listTemplates).mockResolvedValue([]);
    await renderApp();
    await screen.findByTestId('home-hero-input');
    const popup = await openPlusMenu();
    await click('composer-plus-templates');
    expect(within(popup).getByTestId('composer-plus-templates-empty')).toBeTruthy();
  });

  it('the "From template" Hub chip opens the template list instead of a modal', async () => {
    await renderApp();
    await screen.findByTestId('home-hero-input');
    const trigger = await screen.findByTestId<HTMLButtonElement>('home-hero-shortcuts-trigger');
    await waitFor(() => expect(trigger.disabled).toBe(false));
    await click('home-hero-shortcuts-trigger');
    await click('home-hero-rail-template');
    expect(await screen.findByTestId('composer-plus-template-saved')).toBeTruthy();
    expectNoModal();
  });
});
