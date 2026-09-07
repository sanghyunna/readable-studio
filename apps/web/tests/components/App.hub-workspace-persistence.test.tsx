// @vitest-environment jsdom

/**
 * "The screen blinks once, as if entering a new window."
 *
 * A single blink is the signature of a tree that unmounts and remounts, or of a
 * frame painted with neither surface in it. `App.hub-workspace-transition`
 * already pins the ENTRANCE ANIMATION; this file pins the thing the animation
 * cannot rescue — CONTINUITY OF IDENTITY across the swap.
 *
 * Three properties are asserted against the real App tree:
 *
 *  1. The shell and its window chrome are the SAME DOM NODES before and after
 *     the swap. Node identity is the only assertion that distinguishes "React
 *     reconciled in place" from "React tore the tree down and rebuilt an
 *     identical-looking one"; a `querySelector` count cannot tell them apart,
 *     and the remount is exactly what reads as entering a new window.
 *  2. A rail is mounted on BOTH surfaces, and it is mounted continuously — at
 *     no observed commit is the window without one. The rail is the product's
 *     stated continuity anchor, so a gap in it is a visible discontinuity even
 *     if both endpoints look right.
 *  3. No commit between the two surfaces renders the opaque loading
 *     interstitial as the ONLY content. That interstitial is the literal blank
 *     frame; the pending route must keep project surface identity (which it
 *     does, and which must not regress) without painting a full-window slab.
 *
 * The route store is driven directly, so this exercises the real state that
 * decides which surface renders rather than a parallel animation machine.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

// Both stand-ins carry a rail marked the way the shared ProjectRail marks it,
// so "a rail exists on this surface" is observed through the same attribute the
// real component emits rather than through a test-only hook.
vi.mock('../../src/components/EntryView', () => ({
  EntryView: () => (
    <div className="entry-shell entry-shell--no-header">
      <nav data-project-rail="hub" data-project-rail-state="collapsed" />
      <div className="entry-main__inner entry-main__inner--home">
        <div data-testid="entry-view-home" />
      </div>
    </div>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => (
    <div className="app">
      <div data-testid="project-root" />
    </div>
  ),
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/components/MemoryToast', () => ({ MemoryToast: () => null }));
vi.mock('../../src/components/SettingsDialog', () => ({ SettingsDialog: () => null }));

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

/**
 * Records every DOM state the shell body passes through, so an intermediate
 * blank commit cannot hide between two good end states. A MutationObserver is
 * used rather than a timer: it fires on the mutations themselves, so the
 * observation is driven by the commits under test and never by elapsed time.
 */
function observeBody(): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const body = document.querySelector('.workspace-shell__body');
  if (!body) throw new Error('No workspace shell body to observe');
  frames.push(body.innerHTML);
  const observer = new MutationObserver(() => {
    frames.push(body.innerHTML);
  });
  observer.observe(body, { childList: true, subtree: true, attributes: true });
  return { frames, stop: () => observer.disconnect() };
}

describe('Hub <-> workspace surface persistence', () => {
  it('reconciles the shell and window chrome in place instead of remounting them', async () => {
    render(<App />);
    await screen.findByTestId('entry-view-home');

    const shellBefore = document.querySelector('.workspace-shell');
    const chromeBefore = document.querySelector('[data-testid="app-window-chrome"]');
    const bodyBefore = document.querySelector('.workspace-shell__body');
    expect(shellBefore).not.toBeNull();
    expect(chromeBefore).not.toBeNull();

    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await screen.findByTestId('project-root');

    // Node identity, not node presence. A remounted shell would satisfy every
    // selector-based check while still producing the "new window" blink.
    expect(document.querySelector('.workspace-shell')).toBe(shellBefore);
    expect(document.querySelector('[data-testid="app-window-chrome"]')).toBe(chromeBefore);
    expect(document.querySelector('.workspace-shell__body')).toBe(bodyBefore);
  });

  it('keeps a rail mounted on both surfaces and through the swap', async () => {
    render(<App />);
    await screen.findByTestId('entry-view-home');
    expect(document.querySelector('[data-project-rail]')).not.toBeNull();

    const observed = observeBody();
    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await screen.findByTestId('project-root');
    observed.stop();

    // The workspace mounts EntryNavRail directly in App.tsx, so a rail is on
    // screen for the destination too.
    expect(document.querySelector('[data-testid="workspace-rail-host"]')).not.toBeNull();
    // And no observed intermediate state was railless.
    const railless = observed.frames.filter((frame) => !frame.includes('rail'));
    expect(railless).toEqual([]);
  });

  it('paints no blank interstitial frame between the two surfaces', async () => {
    render(<App />);
    await screen.findByTestId('entry-view-home');

    const observed = observeBody();
    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await screen.findByTestId('project-root');
    observed.stop();

    // Every observed commit carried one of the two real surfaces. A frame with
    // neither is the blink, whether it is empty or the loading slab.
    const blank = observed.frames.filter(
      (frame) => !frame.includes('entry-view-home') && !frame.includes('project-root'),
    );
    expect(blank).toEqual([]);
  });

  it('does not paint a full-window opaque slab while a project route hydrates', async () => {
    // The pending-project path: the route resolves to a project the bootstrap
    // list does not contain yet, so App renders the workspace loading state
    // until ProjectView can mount. Keeping project surface identity here is
    // correct and must not regress — but the interstitial must not be an
    // opaque full-viewport canvas, because that IS the blink on the
    // create-a-project path, where it is guaranteed to be shown.
    vi.mocked(listProjects).mockResolvedValue([]);
    render(<App />);
    await screen.findByTestId('entry-view-home');

    setRoute({ kind: 'project', projectId: 'unhydrated-1', conversationId: null, fileName: null });
    const loading = await screen.findByTestId('project-route-loading');

    // The shell canvas is already behind it, so the interstitial must let that
    // canvas through rather than restart a canvas of its own.
    expect(loading.className).toContain('readable-loading-shell--surface');
  });

  it('holds the surface still when only route detail changes inside the workspace', async () => {
    render(<App />);
    await screen.findByTestId('entry-view-home');

    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    const workspaceRoot = await screen.findByTestId('project-root');

    // Re-emitting the same surface identity must not swap the keyed wrapper;
    // if it did, every in-workspace navigation would replay the entrance.
    setRoute({ kind: 'project', projectId: 'project-1', conversationId: null, fileName: null });
    await waitFor(() => {
      expect(screen.getByTestId('project-root')).toBe(workspaceRoot);
    });
  });
});
