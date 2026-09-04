// @vitest-environment jsdom

// Hub -> workspace transition wiring.
//
// The swap between EntryView (Hub) and ProjectView is decided by the route
// state that already exists in App.tsx. These tests pin the contract that the
// animation rides on that state: the incoming surface is keyed per surface
// identity, carries the direction as a data attribute, is interactive on the
// first rendered frame, and leaves no residue behind when the user returns to
// the Hub.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { listProjects, listTemplates } from '../../src/state/projects';

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

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({ onBack }: { onBack: () => void }) => (
    <div className="app">
      <button type="button" onClick={onBack}>
        Back to hub
      </button>
      <input aria-label="Workspace composer" />
    </div>
  ),
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/WorkspaceTabsBar', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/WorkspaceTabsBar')>(
    '../../src/components/WorkspaceTabsBar',
  );
  return { ...actual, WorkspaceTabsBar: () => null };
});

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
  return { ...actual, listProjects: vi.fn(), listTemplates: vi.fn() };
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
  const node = document.querySelector<HTMLElement>('.workspace-shell__body > *');
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
  it('does not animate the first surface painted in the session', async () => {
    render(<App />);

    await screen.findByRole('button', { name: 'Open work' });
    expect(surface().dataset.transition).toBe('none');
    expect(surface().dataset.surface).toBe('hub');
  });

  it('marks the workspace direction when the existing route state opens a project', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Open work' });

    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });

    await waitFor(() => {
      expect(surface().dataset.surface).toBe('project:project-1');
    });
    expect(surface().dataset.transition).toBe('workspace');
  });

  it('mounts the workspace fully interactive in the same commit as the animation', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Open work' });

    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });

    // The composer exists and takes focus on the very first frame the animated
    // surface is present: the animation cannot be gating input or focus.
    const composer = await screen.findByLabelText('Workspace composer');
    expect(surface().dataset.transition).toBe('workspace');
    composer.focus();
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: 'typed during transition' } });
    expect((composer as HTMLInputElement).value).toBe('typed during transition');
  });

  it('keeps the Hub re-enterable with no leftover overlay or stuck state', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Open work' });

    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await screen.findByRole('button', { name: 'Back to hub' });

    setRoute({ kind: 'home', view: 'home' });
    await screen.findByRole('button', { name: 'Open work' });

    // Exactly one surface is mounted — the outgoing view is gone, not parked
    // behind an overlay — and the return direction is the Hub one.
    expect(document.querySelectorAll('.workspace-shell__body > *')).toHaveLength(1);
    expect(surface().dataset.surface).toBe('hub');
    expect(surface().dataset.transition).toBe('hub');

    // And re-entering the workspace still animates forward.
    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await screen.findByRole('button', { name: 'Back to hub' });
    expect(surface().dataset.transition).toBe('workspace');
  });
});
