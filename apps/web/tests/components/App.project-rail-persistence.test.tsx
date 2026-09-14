// @vitest-environment jsdom

/**
 * ONE project rail, carried across the surface swap.
 *
 * The Hub's left project panel is the product's single navigation model, and
 * it must be the SAME panel on the workspace: not a second implementation, not
 * an icon-only strip standing in for it. Everything the panel offers on the
 * Hub - search, New Project, the project/session rows with their row menus,
 * the collapsed/expanded state and the user's resized width - has to be right
 * there after opening a project, and still there after coming back.
 *
 * The assertions run against the real App tree with the route store driven
 * directly. Identity (`toBe`) is the test wherever possible: a remounted
 * look-alike satisfies every selector-based check while still being a
 * different rail whose state was rebuilt rather than kept.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

type TestRoute =
  | { kind: 'home'; view: 'home' | 'projects' | 'plugins' | 'tasks' | 'design-systems' | 'integrations' }
  | { kind: 'project'; projectId: string; conversationId: string | null; fileName: string | null }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string };

const HOME_ROUTE: TestRoute = { kind: 'home', view: 'home' };
const PROJECT_ROUTE: TestRoute = {
  kind: 'project',
  projectId: 'project-1',
  conversationId: null,
  fileName: null,
};

let currentRoute: TestRoute = HOME_ROUTE;
const routeListeners = new Set<() => void>();

function setRoute(next: TestRoute) {
  currentRoute = next;
  for (const listener of routeListeners) listener();
}

vi.mock('../../src/router', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    // In-app navigation (row clicks, brand, destinations) drives the same
    // store the tests drive, so nothing under test sees a different route
    // than the one the harness observes.
    navigate: (next: TestRoute) => setRoute(next),
    useRoute: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          routeListeners.add(listener);
          return () => routeListeners.delete(listener);
        },
        () => currentRoute,
        () => currentRoute,
      ),
  };
});

const { listConversations } = vi.hoisted(() => ({ listConversations: vi.fn() }));

// The workspace surface itself is out of scope: it is the thing the rail must
// survive, not the thing under test.
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
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => 'winuser' }));
// Entry sub-views that stay mounted behind the Hub and talk to the daemon on
// mount; none of them owns any part of the rail.
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: () => null }));
// Repeated Home mounts otherwise spend the test budget rendering the unrelated
// composer. Keep EntryView, HubHome and HomeView real: HomeView must still
// consume palette commands and open the real New Project modal. Only its leaf
// presentation is replaced, just as ProjectView's workspace content is above.
vi.mock('../../src/components/HomeHero', async () => {
  const { forwardRef } = await import('react');
  return { HomeHero: forwardRef(() => <div data-testid="home-hero" />) };
});
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/MarketplaceView', () => ({ MarketplaceView: () => <div data-testid="marketplace-root" /> }));
vi.mock('../../src/components/PluginDetailView', () => ({ PluginDetailView: () => <div data-testid="plugin-detail-root" /> }));
vi.mock('../../src/components/DesignSystemFlow', () => ({
  DesignSystemCreationFlow: () => <div data-testid="design-system-create-root" />,
  DesignSystemDetailView: () => <div data-testid="design-system-detail-root" />,
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
  return {
    ...actual,
    listProjects: vi.fn(),
    getProject: vi.fn(),
    listTemplates: vi.fn(),
    listConversations,
    readConversations: readConversationsFromListMock(listConversations),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    patchConversation: vi.fn(),
  };
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
import * as analyticsEvents from '../../src/analytics/events';

// jsdom has neither; the New Project panel observes its own size and scrolls
// its active tab into view, and the rail must be able to open it.
class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

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

function project(id: string, name: string, updatedAt: number): Project {
  return { id, name, skillId: null, designSystemId: null, createdAt: 1, updatedAt };
}

const PROJECTS = [
  project('project-1', 'Quarterly report', 900),
  project('project-2', 'Pricing page', 100),
];

function conversation(id: string, projectId: string, title: string) {
  return { id, projectId, title, createdAt: 1, updatedAt: 10, messageCount: 3 };
}

beforeEach(() => {
  currentRoute = HOME_ROUTE;
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchDesignSystems).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(getProject).mockResolvedValue(null);
  vi.mocked(listTemplates).mockResolvedValue([]);
  vi.mocked(fetchDaemonConfig).mockResolvedValue({});
  vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
  vi.mocked(saveConfig).mockImplementation(() => {});
  vi.mocked(syncConfigToDaemon).mockResolvedValue(undefined);
  vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  listConversations.mockImplementation(async (projectId: string) =>
    projectId === 'project-1'
      ? [
          conversation('c1', 'project-1', 'Chart palette'),
          conversation('c2', 'project-1', 'Executive summary'),
        ]
      : [conversation('c3', 'project-2', 'Plan comparison')],
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  routeListeners.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  listConversations.mockReset();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * Every rail node in the document, found through the attribute the shared
 * `ProjectRail` frame stamps on itself. The product rule is that there is
 * exactly one, so the accessor asserts the count and hands back that node.
 */
function theRail(): HTMLElement {
  const rails = [...document.querySelectorAll<HTMLElement>('[data-project-rail]')];
  expect(rails).toHaveLength(1);
  return rails[0]!;
}

/** The rail's single collapse/expand control, by the frame's own marker. */
function railToggle(): HTMLButtonElement {
  const toggles = [...document.querySelectorAll<HTMLButtonElement>('[data-project-rail-toggle]')];
  expect(toggles).toHaveLength(1);
  return toggles[0]!;
}

/** The rail's width handle, by its ARIA contract rather than its skin. */
function railResizer(): HTMLElement {
  const resizers = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="separator"][aria-orientation="vertical"][aria-valuenow]',
    ),
  ];
  expect(resizers).toHaveLength(1);
  return resizers[0]!;
}

async function renderHubWithSessions() {
  await act(async () => { render(<App />); });
  // Resolved bootstrap and session promises are drained by act, not polling.
  screen.getByTestId('hub-session-c1');
}

async function openWorkspace() {
  await act(async () => setRoute(PROJECT_ROUTE));
  screen.getByTestId('project-root');
}

async function returnToHub() {
  await act(async () => setRoute(HOME_ROUTE));
  screen.getByTestId('entry-view-home');
}

const PEEK_ROUTES: [string, TestRoute][] = [
  ['Home', HOME_ROUTE],
  ['workspace', PROJECT_ROUTE],
  ...(['projects', 'plugins', 'tasks', 'design-systems', 'integrations'] as const)
    .map((view): [string, TestRoute] => [view, { kind: 'home', view }]),
  ['marketplace', { kind: 'marketplace' }],
  ['plugin detail', { kind: 'marketplace-detail', pluginId: 'plugin-1' }],
  ['design system creation', { kind: 'design-system-create' }],
  ['design system detail', { kind: 'design-system-detail', designSystemId: 'ds-1' }],
];

describe.each(PEEK_ROUTES)('Shell Peek on %s', (_name, route) => {
  it.each(['button', 'context menu', 'Space'] as const)('shows %s Peek immediately without replacing route content or leaving stale Home state', async (trigger) => {
    await renderHubWithSessions();
    const rail = theRail();
    await act(async () => setRoute(route));
    const surface = document.querySelector<HTMLElement>('[data-surface]')!;
    const content = surface.firstElementChild;
    const row = screen.getByTestId('hub-session-c1');

    if (trigger === 'button') fireEvent.click(screen.getByTestId('hub-peek-c1'));
    else if (trigger === 'context menu') {
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByTestId('hub-row-menu-info'));
    } else {
      row.focus();
      fireEvent.keyDown(row, { key: ' ' });
    }

    // A hidden Home inspector is not a visible result. It must be a sibling
    // of the routed content, never inside a hidden/inert entry tab.
    const inspector = screen.getByRole('complementary');
    expect(inspector).toBe(screen.getByTestId('hub-inspector'));
    expect(inspector.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
    expect(surface.contains(inspector)).toBe(false);
    expect(screen.getByTestId('hub-inspector-name').textContent).toBe('Chart palette');
    expect(currentRoute).toEqual(route);
    expect(document.querySelector('[data-surface]')).toBe(surface);
    expect(surface.firstElementChild).toBe(content);
    expect(theRail()).toBe(rail);
    if (route.kind === 'project') expect(screen.getByTestId('project-root').isConnected).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
    expect(document.activeElement).toBe(row);
    await returnToHub();
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
    expect(theRail()).toBe(rail);
  });
});

describe('Project rail persistence across Hub -> workspace -> Hub', () => {
  it('keeps an open inspector visible through navigation and opens only the explicitly inspected session', async () => {
    await renderHubWithSessions();
    await openWorkspace();
    const rail = theRail();
    fireEvent.click(screen.getByTestId('hub-peek-c2'));
    const inspector = screen.getByRole('complementary');
    await returnToHub();
    expect(screen.getByRole('complementary')).toBe(inspector);
    expect(screen.getAllByTestId('hub-inspector')).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByTestId('hub-inspector-open')));
    expect(currentRoute).toEqual({ ...PROJECT_ROUTE, conversationId: 'c2' });
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
    expect(theRail()).toBe(rail);
    await returnToHub();
    expect(screen.queryByTestId('hub-inspector')).toBeNull();
  });

  it('handles Ctrl-B once on either route and preserves the one preference', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    screen.getByTestId('hub-brand').focus();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(rail.dataset['projectRailState']).toBe('collapsed');
    expect(window.localStorage.getItem('readable-studio:hub-rail-collapsed')).toBe('true');
    await openWorkspace();
    screen.getByTestId('hub-brand').focus();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(rail.dataset['projectRailState']).toBe('expanded');
    expect(window.localStorage.getItem('readable-studio:hub-rail-collapsed')).toBe('false');
    await returnToHub();
    expect(theRail()).toBe(rail);
    expect(rail.dataset['projectRailState']).toBe('expanded');
  });

  it('forces narrow collapse across routes without overwriting the expanded preference', async () => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    const narrowQuery = {
      matches: false,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
    };
    vi.stubGlobal('matchMedia', (query: string) => query === '(max-width: 900px)' ? narrowQuery : {
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    await renderHubWithSessions();
    const rail = theRail();
    act(() => {
      narrowQuery.matches = true;
      listeners.forEach((listener) => listener({ matches: true }));
    });
    expect(rail.dataset['projectRailState']).toBe('collapsed');
    expect(railToggle().disabled).toBe(true);
    expect(railResizer().hidden).toBe(true);
    await openWorkspace();
    expect(theRail()).toBe(rail);
    expect(railToggle().disabled).toBe(true);
    expect(window.localStorage.getItem('readable-studio:hub-rail-collapsed')).not.toBe('true');
    act(() => {
      narrowQuery.matches = false;
      listeners.forEach((listener) => listener({ matches: false }));
    });
    expect(rail.dataset['projectRailState']).toBe('expanded');
    expect(railToggle().disabled).toBe(false);
    expect(railResizer().hidden).toBe(false);
  });

  it('keeps the palette outside the keyed swap and hands its command to Home once', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    await openWorkspace();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = screen.getByTestId('hub-command-palette');
    const track = vi.spyOn(analyticsEvents, 'trackHomeNavClick');
    await act(async () => {
      fireEvent.click(screen.getByTestId('hub-palette-item-command-create-template'));
    });
    expect(currentRoute).toEqual(HOME_ROUTE);
    expect(track).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('hub-command-palette')).toBeNull();
    expect(palette.isConnected).toBe(false);
    expect(screen.getAllByTestId('new-project-modal')).toHaveLength(1);
    expect(theRail()).toBe(rail);
    railToggle();
  });

  it('retains the same rail and palette on non-home entry destinations', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    await openWorkspace();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = screen.getByTestId('hub-command-palette');
    await act(async () => { setRoute({ kind: 'home', view: 'plugins' }); });
    expect(theRail()).toBe(rail);
    expect(screen.getByTestId('hub-command-palette')).toBe(palette);
    railToggle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('hub-palette-item-command-create-template'));
    });
    expect(currentRoute).toEqual(HOME_ROUTE);
    expect(screen.getAllByTestId('new-project-modal')).toHaveLength(1);
    expect(theRail()).toBe(rail);
  });

  it('aborts fan-out during route hydration, keeps cached rows and resumes afterward', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    const readyRead = listConversations.getMockImplementation()!;
    let finishReads!: (value: never[]) => void;
    const reads = new Promise<never[]>((resolve) => { finishReads = resolve; });
    listConversations.mockImplementation(() => reads);
    fireEvent(window, new CustomEvent('readable-studio:runs-changed'));
    const signals = listConversations.mock.calls.slice(2).map((call) => call[1].signal as AbortSignal);
    expect(signals).toHaveLength(2);
    let finishHydration!: (value: Project) => void;
    const hydration = new Promise<Project>((resolve) => { finishHydration = resolve; });
    vi.mocked(getProject).mockReturnValue(hydration);
    act(() => setRoute({ ...PROJECT_ROUTE, projectId: 'project-3' }));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    screen.getByTestId('project-route-loading');
    expect(theRail()).toBe(rail);
    within(rail).getByTestId('hub-session-c1');
    await act(async () => { finishReads([]); await reads; });
    fireEvent(window, new CustomEvent('readable-studio:runs-changed'));
    expect(listConversations).toHaveBeenCalledTimes(4);
    listConversations.mockImplementation(readyRead);
    await act(async () => {
      finishHydration(project('project-3', 'Hydrated project', 1000));
      await hydration;
    });
    expect(listConversations).toHaveBeenCalledTimes(7);
    expect(theRail()).toBe(rail);
    within(rail).getByTestId('hub-session-c1');
  });

  it('mounts exactly one project rail and carries the same node through the swap and back', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    within(rail).getByTestId('hub-search');

    await openWorkspace();
    // The same node, not a look-alike. An icon-only strip would also be a
    // single `[data-project-rail]` node, but it is a different node and it
    // has no search field.
    expect(theRail()).toBe(rail);
    within(rail).getByTestId('hub-search');

    await returnToHub();
    expect(theRail()).toBe(rail);
    within(rail).getByTestId('hub-search');
  });

  it('keeps search, New Project and the project/session rows with their menus reachable on the workspace and again on the Hub', async () => {
    await renderHubWithSessions();
    await openWorkspace();

    const rail = theRail();
    const search = within(rail).getByTestId('hub-search') as HTMLInputElement;
    expect(search.disabled).toBe(false);
    const newProject = within(rail).getByTestId('hub-new-project') as HTMLButtonElement;
    expect(newProject.disabled).toBe(false);
    within(rail).getByTestId('hub-project-project-1');
    within(rail).getByTestId('hub-session-c1');
    within(rail).getByTestId('hub-new-session-project-1');

    // Row mutations stay wired: both menus still offer rename and delete.
    fireEvent.click(within(rail).getByTestId('hub-menu-session-c1'));
    const sessionMenu = screen.getByTestId('hub-row-menu');
    within(sessionMenu).getByTestId('hub-row-menu-rename');
    within(sessionMenu).getByTestId('hub-row-menu-delete');
    fireEvent.keyDown(sessionMenu, { key: 'Escape' });
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();

    fireEvent.click(within(rail).getByTestId('hub-menu-project-project-1'));
    const projectMenu = screen.getByTestId('hub-row-menu');
    within(projectMenu).getByTestId('hub-row-menu-rename');
    within(projectMenu).getByTestId('hub-row-menu-delete');
    fireEvent.keyDown(projectMenu, { key: 'Escape' });
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();

    // Search is live, not decorative: it filters the tree in place.
    fireEvent.change(search, { target: { value: 'pricing' } });
    expect(within(rail).queryByTestId('hub-project-project-1')).toBeNull();
    within(rail).getByTestId('hub-project-project-2');
    fireEvent.change(search, { target: { value: '' } });
    within(rail).getByTestId('hub-project-project-1');

    // New Project from the workspace opens the real creation surface.
    await act(async () => fireEvent.click(newProject));
    screen.getByTestId('new-project-modal');

    await returnToHub();
    const railOnHub = theRail();
    expect(railOnHub).toBe(rail);
    within(railOnHub).getByTestId('hub-search');
    within(railOnHub).getByTestId('hub-new-project');
    within(railOnHub).getByTestId('hub-project-project-1');
    within(railOnHub).getByTestId('hub-session-c1');
    within(railOnHub).getByTestId('hub-menu-project-project-1');
    within(railOnHub).getByTestId('hub-menu-session-c1');
  });

  it('carries the collapsed strip through the swap on the same node and expands it again from the workspace', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    expect(rail.getAttribute('data-project-rail-state')).toBe('expanded');

    fireEvent.click(railToggle());
    expect(rail.getAttribute('data-project-rail-state')).toBe('collapsed');
    expect(railToggle().getAttribute('aria-expanded')).toBe('false');

    await openWorkspace();
    expect(theRail()).toBe(rail);
    expect(rail.getAttribute('data-project-rail-state')).toBe('collapsed');
    expect(railToggle().getAttribute('aria-expanded')).toBe('false');

    // The one toggle acts on the one rail from either surface.
    fireEvent.click(railToggle());
    expect(rail.getAttribute('data-project-rail-state')).toBe('expanded');
    expect(railToggle().getAttribute('aria-expanded')).toBe('true');

    await returnToHub();
    expect(theRail()).toBe(rail);
    expect(rail.getAttribute('data-project-rail-state')).toBe('expanded');
  });

  it('renders exactly one toggle, inside the rail brand row, with no chrome slot host, on the same node across the swap in both states', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    const toggle = railToggle();

    const inBrandRow = () => {
      const current = railToggle();
      const head = current.parentElement as HTMLElement;
      // A descendant of the rail's brand row, right after the brand itself.
      expect(head.hasAttribute('data-project-rail-head')).toBe(true);
      expect(head.parentElement).toBe(rail);
      expect(current.previousElementSibling).toBe(screen.getByTestId('hub-brand'));
      // No portal target and no dead host anywhere in the document.
      expect(document.getElementById('app-window-chrome-rail-toggle')).toBeNull();
      expect(screen.queryByTestId('app-window-chrome-rail-toggle')).toBeNull();
      expect(screen.getByTestId('app-window-chrome').querySelector('[data-project-rail-toggle]')).toBeNull();
      return current;
    };

    expect(inBrandRow()).toBe(toggle);
    await openWorkspace();
    expect(theRail()).toBe(rail);
    expect(inBrandRow()).toBe(toggle);

    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('collapsed');
    expect(inBrandRow()).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await returnToHub();
    expect(theRail()).toBe(rail);
    expect(inBrandRow()).toBe(toggle);
    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('expanded');
    expect(inBrandRow()).toBe(toggle);
  });

  it('opens the Library menu outside the rail box and the content column in both rail states', async () => {
    await renderHubWithSessions();
    const rail = theRail();
    const trigger = screen.getByTestId('hub-library');

    const openAndCheck = () => {
      fireEvent.click(trigger);
      const menu = screen.getByTestId('hub-library-menu');
      // Escapes the rail's `overflow: hidden` box entirely: it is a child of
      // the body, not of the rail and not of the swapped content column, so
      // neither can clip it or paint over it.
      expect(rail.contains(menu)).toBe(false);
      expect(menu.parentElement).toBe(document.body);
      expect(menu.closest('[data-surface]')).toBeNull();
      expect(menu.closest('[data-project-rail]')).toBeNull();
      expect(menu.getAttribute('role')).toBe('menu');
      expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
      within(menu).getByTestId('hub-library-projects');
      within(menu).getByTestId('hub-workspace-folder');
      return menu;
    };

    // Collapsed strip: the 44px box that used to clip the menu.
    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('collapsed');
    const collapsedMenu = openAndCheck();
    fireEvent.keyDown(collapsedMenu, { key: 'Escape' });
    expect(screen.queryByTestId('hub-library-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Expanded panel, same placer, and outside-click dismissal still works.
    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('expanded');
    openAndCheck();
    fireEvent.mouseDown(screen.getByTestId('hub-search'));
    expect(screen.queryByTestId('hub-library-menu')).toBeNull();
  });

  it('opens the Theme modal from the collapsed rail, outside the rail box, and drives the app appearance path', async () => {
    // The real persistence for this one test: the choice must land in the
    // `readable-studio:config` blob the app reloads from, not just in a spy.
    const actualConfig = await vi.importActual<typeof import('../../src/state/config')>(
      '../../src/state/config',
    );
    vi.mocked(saveConfig).mockImplementation(actualConfig.saveConfig);
    await renderHubWithSessions();
    const rail = theRail();
    const trigger = screen.getByTestId('hub-theme');
    const library = screen.getByTestId('hub-library');

    // Theme sits directly above Library in the footer.
    expect(trigger.nextElementSibling).toBe(library.closest('.hub__dest-row'));

    // Collapsed strip: the 44px box that would clip anything left inside it.
    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('collapsed');

    // One click, straight to the dialog: no settings surface, no menu, no
    // route change.
    fireEvent.click(trigger);
    const modal = screen.getByTestId('hub-theme-modal');
    const backdrop = screen.getByTestId('hub-theme-backdrop');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(currentRoute).toEqual(HOME_ROUTE);
    expect(trigger.getAttribute('aria-controls')).toBe(modal.id);

    // A child of the body: not of the rail, not of the swapped content column,
    // so neither can clip it or paint over it.
    expect(backdrop.parentElement).toBe(document.body);
    expect(rail.contains(modal)).toBe(false);
    expect(modal.closest('[data-surface]')).toBeNull();
    expect(modal.closest('[data-project-rail]')).toBeNull();

    // Selecting a card goes through App's own theme handler: persisted to the
    // browser config, synced to the daemon, and applied to the document.
    fireEvent.click(screen.getByTestId('hub-theme-option-dark'));
    const stored = JSON.parse(window.localStorage.getItem('readable-studio:config') ?? '{}') as { theme?: string };
    expect(stored.theme).toBe('dark');
    expect(syncConfigToDaemon).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-scheme')).toBe('dark');
    expect(screen.getByTestId('hub-theme-option-dark').getAttribute('aria-checked')).toBe('true');

    // Escape dismisses and hands focus back to the Theme row.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByTestId('hub-theme-modal')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Expanded panel: same portal, and the backdrop dismisses too. The press
    // lands below the shared modal-backdrop's 56px desktop window-drag strip,
    // which the App-level guard reserves for dragging the window.
    fireEvent.click(railToggle());
    expect(rail.dataset['projectRailState']).toBe('expanded');
    fireEvent.click(trigger);
    expect(screen.getByTestId('hub-theme-backdrop').parentElement).toBe(document.body);
    fireEvent.mouseDown(screen.getByTestId('hub-theme-backdrop'), { clientY: 320 });
    expect(screen.queryByTestId('hub-theme-modal')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-scheme');
  });

  it('carries the resized expanded width through the swap and back', async () => {
    await renderHubWithSessions();
    const resizer = railResizer();
    const initialWidth = resizer.getAttribute('aria-valuenow');
    const maxWidth = resizer.getAttribute('aria-valuemax');
    expect(maxWidth).not.toBeNull();
    expect(maxWidth).not.toBe(initialWidth);

    fireEvent.keyDown(resizer, { key: 'End' });
    expect(resizer.getAttribute('aria-valuenow')).toBe(maxWidth);

    await openWorkspace();
    expect(railResizer().getAttribute('aria-valuenow')).toBe(maxWidth);

    await returnToHub();
    expect(railResizer().getAttribute('aria-valuenow')).toBe(maxWidth);
  });
});
