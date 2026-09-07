// @vitest-environment jsdom

// Hub -> workspace transition wiring.
//
// The swap between EntryView (Hub) and ProjectView is decided by the route
// state that already exists in App.tsx. These tests pin the contract that the
// animation rides on that state: the incoming surface is keyed per surface
// identity, carries the direction as a data attribute, is interactive on the
// first rendered frame, and leaves no residue behind when the user returns to
// the Hub.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig, Project } from '../../src/types';
import {
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgents,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { getProject, listProjects, listTemplates } from '../../src/state/projects';

const moduleReadiness = vi.hoisted(() => ({ ready: Promise.resolve() }));

type TestRoute =
  | { kind: 'home'; view: 'home' }
  | { kind: 'project'; projectId: string; conversationId: null; fileName: null };

let currentRoute: TestRoute = { kind: 'home', view: 'home' };
const routeListeners = new Set<() => void>();

function setRoute(next: TestRoute) {
  currentRoute = next;
  for (const listener of routeListeners) listener();
}

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => {
    // Minimal external-store subscription so tests can drive the real route
    // state instead of introducing a parallel animation state machine.
    const { useSyncExternalStore } = require('react') as typeof import('react');
    return useSyncExternalStore(
      (listener: () => void) => {
        routeListeners.add(listener);
        return () => routeListeners.delete(listener);
      },
      () => currentRoute,
      () => currentRoute,
    );
  },
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ onOpenProject }: { onOpenProject: (id: string) => void }) => (
    <div className="entry-shell entry-shell--no-header">
      <button type="button" onClick={() => onOpenProject('project-1')}>
        Open work
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/ProjectView', async () => {
  // Keep next/dynamic real: hold the module itself, not a mock loading UI.
  await moduleReadiness.ready;
  return {
    ProjectView: ({ onBack }: { onBack: () => void }) => (
      <div className="app">
        <button type="button" onClick={onBack}>Back to hub</button>
        <input aria-label="Workspace composer" />
      </div>
    ),
  };
});

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/MemoryToast', () => ({
  MemoryToast: () => null,
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgents: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, getProject: vi.fn(), listProjects: vi.fn(), listTemplates: vi.fn() };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchDaemonConfig: vi.fn(),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

function surface(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.workspace-shell__body > [data-surface]');
  if (!node) throw new Error('No workspace surface rendered');
  return node;
}

beforeEach(() => {
  currentRoute = { kind: 'home', view: 'home' };
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchDesignSystems).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(listProjects).mockResolvedValue([project]);
  vi.mocked(getProject).mockResolvedValue(null);
  vi.mocked(listTemplates).mockResolvedValue([]);
  vi.mocked(fetchDaemonConfig).mockResolvedValue({});
  vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
  vi.mocked(saveConfig).mockImplementation(() => {});
  vi.mocked(syncConfigToDaemon).mockResolvedValue(undefined);
  vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  cleanup();
  routeListeners.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Hub -> workspace transition wiring', () => {
  it('carries visible content through separate data and cold-module readiness commits', async () => {
    let finishModule!: () => void;
    moduleReadiness.ready = new Promise<void>((resolve) => { finishModule = resolve; });
    let finishProject!: (value: Project) => void;
    const projectReady = new Promise<Project>((resolve) => { finishProject = resolve; });
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(getProject).mockReturnValue(projectReady);
    await act(async () => { render(<App />); });
    const rail = document.querySelector('[data-project-rail]');
    const states: boolean[] = [];
    const sample = () => {
      const content = surface();
      states.push(Boolean(content.querySelector('.entry-shell, .app, [data-testid="project-route-loading"]')));
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector('.workspace-shell__body')!, {
      childList: true, subtree: true, attributes: true,
    });
    sample();
    try {
      await act(async () => setRoute({ kind: 'project', projectId: project.id, conversationId: null, fileName: null }));
      const pendingSurface = surface();
      const loading = screen.getByTestId('project-route-loading');
      expect(loading.querySelectorAll('[aria-hidden="true"] span')).toHaveLength(6);
      expect(loading.querySelector('button, input, [tabindex]')).toBeNull();
      expect(pendingSurface.dataset.surface).toBe(`project:${project.id}`);
      expect(screen.queryByLabelText('Workspace composer')).toBeNull();
      sample();

      await act(async () => { finishProject(project); await projectReady; });
      // Data alone must not clear the fallback while next/dynamic is pending.
      expect(surface()).toBe(pendingSurface);
      screen.getByTestId('project-route-loading');
      expect(screen.queryByLabelText('Workspace composer')).toBeNull();
      sample();

      await act(async () => {
        finishModule();
        await import('../../src/components/ProjectView');
      });
      screen.getByLabelText('Workspace composer');
      expect(screen.queryByTestId('project-route-loading')).toBeNull();
      expect(surface()).toBe(pendingSurface);
      expect(document.querySelector('[data-project-rail]')).toBe(rail);
      sample();
      expect(states.length).toBeGreaterThanOrEqual(4);
      expect(states.every(Boolean)).toBe(true);
    } finally {
      finishModule();
      observer.disconnect();
    }
  });

  it('discards stale readiness after a new route or a return to Home', async () => {
    let finishOld!: (value: Project) => void;
    const oldReady = new Promise<Project>((resolve) => { finishOld = resolve; });
    let finishNew!: (value: Project) => void;
    const newReady = new Promise<Project>((resolve) => { finishNew = resolve; });
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(getProject).mockImplementation((id) => id === 'old' ? oldReady : newReady);
    await act(async () => { render(<App />); });
    const rail = document.querySelector('[data-project-rail]');
    await act(async () => setRoute({ kind: 'project', projectId: 'old', conversationId: null, fileName: null }));
    screen.getByTestId('project-route-loading');
    await act(async () => setRoute({ kind: 'project', projectId: 'new', conversationId: null, fileName: null }));
    screen.getByTestId('project-route-loading');
    await act(async () => { finishOld({ ...project, id: 'old' }); await oldReady; });
    expect(surface().dataset.surface).toBe('project:new');
    screen.getByTestId('project-route-loading');
    await act(async () => setRoute({ kind: 'home', view: 'home' }));
    await act(async () => { finishNew({ ...project, id: 'new' }); await newReady; });
    expect(surface().dataset.surface).toBe('hub');
    screen.getByRole('button', { name: 'Open work' });
    expect(screen.queryByTestId('project-route-loading')).toBeNull();
    expect(document.querySelector('[data-project-rail]')).toBe(rail);
  });

  it('does not animate the first surface painted in the session', async () => {
    await act(async () => { render(<App />); });
    screen.getByRole('button', { name: 'Open work' });
    expect(surface().dataset.transition).toBe('none');
    expect(surface().dataset.surface).toBe('hub');
  });

  it('marks the workspace direction when the existing route state opens a project', async () => {
    await act(async () => { render(<App />); });
    screen.getByRole('button', { name: 'Open work' });
    await act(async () => {
      setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
      await import('../../src/components/ProjectView');
    });
    expect(surface().dataset.surface).toBe('project:project-1');
    expect(surface().dataset.transition).toBe('workspace');
  });

  it('mounts the workspace fully interactive in the same commit as the animation', async () => {
    await act(async () => { render(<App />); });
    screen.getByRole('button', { name: 'Open work' });
    await act(async () => {
      setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
      await import('../../src/components/ProjectView');
    });

    // jsdom has no live animations; the gate must fail open in this case.
    const composer = screen.getByLabelText('Workspace composer');
    expect(surface().dataset.transition).toBe('workspace');
    composer.focus();
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: 'typed during transition' } });
    expect((composer as HTMLInputElement).value).toBe('typed during transition');
  });

  it('keeps the Hub re-enterable with no leftover overlay or stuck state', async () => {
    await act(async () => { render(<App />); });
    screen.getByRole('button', { name: 'Open work' });
    await act(async () => {
      setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
      await import('../../src/components/ProjectView');
    });
    screen.getByRole('button', { name: 'Back to hub' });

    await act(async () => setRoute({ kind: 'home', view: 'home' }));
    screen.getByRole('button', { name: 'Open work' });

    // Exactly one surface is mounted — the outgoing view is gone, not parked
    // behind an overlay — and the return direction is the Hub one.
    expect(document.querySelectorAll('.workspace-shell__body > [data-surface]')).toHaveLength(1);
    expect(document.querySelectorAll('.workspace-shell__body > [data-project-rail]')).toHaveLength(1);
    expect(surface().dataset.surface).toBe('hub');
    expect(surface().dataset.transition).toBe('hub');

    // And re-entering the workspace still animates forward.
    await act(async () => setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null }));
    screen.getByRole('button', { name: 'Back to hub' });
    expect(surface().dataset.transition).toBe('workspace');
  });
});
