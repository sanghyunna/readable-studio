// @vitest-environment jsdom

// Exercise the shell ownership contract with an explicit test provider.
// Async work is controlled at the provider boundary and drained with act;
// no polling or elapsed-time assumptions are needed for session reads.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());
const deleteConversation = vi.hoisted(() => vi.fn());
const patchConversation = vi.hoisted(() => vi.fn());
const listPlugins = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
  createConversation,
  deleteConversation,
  patchConversation,
  listPlugins,
}));

import { HomeView } from '../../src/components/HomeView';
import { HubHome } from '../../src/components/hub/HubHome';
import { HubRail } from '../../src/components/hub/HubRail';
import { HubRailProvider, useHubRail } from '../../src/components/hub/HubRailContext';
import { HubRailOverlays, HUB_DELETE_UNDO_MS } from '../../src/components/hub/HubRailOverlays';
import {
  useHubRailController,
  type HubRailControllerInputs,
} from '../../src/components/hub/useHubRailController';
import type { Conversation, Project } from '../../src/types';

const PROJECTS: Project[] = ['p1', 'p2'].map((id) => ({
  id, name: id, skillId: null, designSystemId: null, createdAt: 1, updatedAt: 10,
}));
const SESSION = {
  id: 'c1', projectId: 'p1', title: 'Session one', createdAt: 1, updatedAt: 10,
  messageCount: 3,
};

const PLUGINS = [{
  id: 'example-web-prototype', name: 'Web prototype', title: 'Web prototype', version: '1.0.0',
  manifest: { title: 'Web prototype', readable: { useCase: { query: 'Build a prototype' }, inputs: [] } },
}];

function seedSessions() {
  listConversations.mockImplementation(async (id: string) => id === 'p1' ? [SESSION] : []);
  listPlugins.mockResolvedValue([]);
}

afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem('readable-studio:hub-open-work');
  window.localStorage.removeItem('readable-studio:hub-rail-collapsed');
  window.localStorage.removeItem('readable-studio:hub-rail-width');
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function RailReadout() {
  const rail = useHubRail();
  return (
    <>
      <output data-testid="rail-readout">
        {`${rail.railCollapsed ? 'collapsed' : 'expanded'}:${rail.openWork.map((item) => item.sessionId).join(',')}`}
      </output>
      <output data-testid="pending-chip">{rail.commandChip?.nonce ?? ''}</output>
      <button data-testid="consume-old-chip" onClick={() => rail.consumeCommandChip(1)}>Consume</button>
    </>
  );
}

function ShellWithHub({
  showHub = true,
  controllerInputs = {},
  onOpenNewProject,
}: {
  showHub?: boolean;
  controllerInputs?: Partial<HubRailControllerInputs>;
  onOpenNewProject?: (tab: 'template') => void;
}) {
  const rail = useHubRailController({
    projects: PROJECTS,
    currentSessionId: null,
    onOpenSession: () => undefined,
    onNewProject: () => undefined,
    ...controllerInputs,
  });
  return (
    <HubRailProvider value={rail}>
      <HubRail />
      <HubRailOverlays />
      <RailReadout />
      {showHub ? (
        <div key="home" data-testid="keyed-surface">
          <HubHome
            projects={PROJECTS}
            onOpenSession={() => undefined}
            onSubmit={() => undefined}
            onNewProject={() => undefined}
            onOpenNewProject={onOpenNewProject}
          />
        </div>
      ) : <div key="workspace" data-testid="workspace-stand-in" />}
    </HubRailProvider>
  );
}

function theRail(): HTMLElement {
  expect(screen.getAllByTestId('hub-nav')).toHaveLength(1);
  return screen.getByTestId('hub-nav');
}

function pickCommand(id: string) {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  expect(screen.getAllByTestId('hub-command-palette')).toHaveLength(1);
  fireEvent.click(screen.getByTestId(`hub-palette-item-command-create-${id}`));
}

describe('hub rail boundary', () => {
  it('drives the rail and a sibling consumer from one shell-owned controller', async () => {
    seedSessions();
    const onOpenSession = vi.fn();
    await act(async () => { render(<ShellWithHub showHub={false} controllerInputs={{ onOpenSession }} />); });
    expect(screen.getByTestId('rail-readout').textContent).toBe('expanded:');
    fireEvent.click(screen.getByTestId('hub-session-c1'));
    expect(onOpenSession).toHaveBeenCalledWith('p1', 'c1');
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
    expect(screen.getByTestId('rail-readout').textContent).toBe('expanded:c1');
    fireEvent.click(screen.getByTestId('hub-rail-toggle'));
    expect(theRail().dataset['projectRailState']).toBe('collapsed');
    expect(screen.getByTestId('rail-readout').textContent).toBe('collapsed:c1');
    expect(window.localStorage.getItem('readable-studio:hub-rail-collapsed')).toBe('true');
  });

  it.each([
    ['rail consumer', <RailReadout />],
    ['Home stage', <HubHome projects={[]} onOpenSession={() => undefined} onNewProject={() => undefined} />],
  ])('refuses to render %s with no provider', (_name, consumer) => {
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedError);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(consumer)).toThrow(/HubRailProvider/);
    } finally {
      error.mockRestore();
      window.removeEventListener('error', preventExpectedError);
    }
  });

  it('keeps HubHome as the stage only under a shell-owned provider', async () => {
    seedSessions();
    await act(async () => { render(<ShellWithHub />); });
    const rail = theRail();
    const surface = screen.getByTestId('keyed-surface');
    expect(surface.contains(rail)).toBe(false);
    expect(surface.querySelector('[data-project-rail]')).toBeNull();
    expect(surface.querySelector('[data-testid="home-hero-input"]')).not.toBeNull();
    expect(screen.getByTestId('hub-live-region').parentElement?.dataset['railHost']).toBe('shell');
    expect(listConversations).toHaveBeenCalledTimes(PROJECTS.length);
  });

  it('preserves the rail node, search, open work, and width through keyed surface swaps', async () => {
    seedSessions();
    const view = render(<ShellWithHub />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    const rail = theRail();
    fireEvent.click(screen.getByTestId('hub-session-c1'));
    fireEvent.change(screen.getByTestId('hub-search'), { target: { value: 'Session one' } });
    const resizer = screen.getByTestId('hub-rail-resizer');
    fireEvent.keyDown(resizer, { key: 'End' });
    expect(resizer.getAttribute('aria-valuenow')).toBe('420');
    await act(async () => { view.rerender(<ShellWithHub showHub={false} />); });
    expect(theRail()).toBe(rail);
    expect(screen.getByTestId('hub-rail-resizer')).toBe(resizer);
    expect(screen.queryByTestId('hub-live-region')).toBeNull();
    await act(async () => { view.rerender(<ShellWithHub />); });
    expect(theRail()).toBe(rail);
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
    expect((screen.getByTestId('hub-search') as HTMLInputElement).value).toBe('Session one');
    expect(resizer.getAttribute('aria-valuenow')).toBe('420');
    expect(listConversations).toHaveBeenCalledTimes(PROJECTS.length);
  });

  it('holds session reads while paused and starts one wave when resumed', async () => {
    seedSessions();
    const view = render(<ShellWithHub controllerInputs={{ pauseSessionReads: true }} />);
    expect(listConversations).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-sessions-loading-p1')).toBeTruthy();
    fireEvent(window, new CustomEvent('readable-studio:runs-changed'));
    expect(listConversations).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<ShellWithHub controllerInputs={{ pauseSessionReads: false }} />); });
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(listConversations).toHaveBeenCalledTimes(PROJECTS.length);
  });

  it('aborts in-flight reads on pause, preserves cache, and ignores late responses', async () => {
    seedSessions();
    const view = render(<ShellWithHub />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    let resolvePending!: (sessions: Conversation[]) => void;
    const pending = new Promise<Conversation[]>((resolve) => { resolvePending = resolve; });
    listConversations.mockImplementation(() => pending);
    fireEvent(window, new CustomEvent('readable-studio:runs-changed'));
    const signals = listConversations.mock.calls.slice(2).map((call) => call[1].signal as AbortSignal);
    expect(signals).toHaveLength(2);
    view.rerender(<ShellWithHub controllerInputs={{ pauseSessionReads: true }} />);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      resolvePending([{ ...SESSION, id: 'late' }]);
      await pending;
    });
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.queryByTestId('hub-session-late')).toBeNull();
    expect(listConversations).toHaveBeenCalledTimes(4);
    seedSessions();
    await act(async () => { view.rerender(<ShellWithHub />); });
    expect(listConversations).toHaveBeenCalledTimes(6);
  });

  it('does not bypass paused reads through a stale row retry', async () => {
    seedSessions();
    const view = render(<ShellWithHub />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    listConversations.mockRejectedValue(new Error('offline'));
    await act(async () => { fireEvent(window, new CustomEvent('readable-studio:runs-changed')); });
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.getByTestId('hub-sessions-error-p1').dataset['status']).toBe('stale');
    view.rerender(<ShellWithHub controllerInputs={{ pauseSessionReads: true }} />);
    fireEvent.click(screen.getByTestId('hub-sessions-retry-p1'));
    expect(listConversations).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
  });

  it('uses the provider current session for selection and inspector shortcuts', async () => {
    seedSessions();
    const view = render(<ShellWithHub />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    view.rerender(<ShellWithHub controllerInputs={{ currentSessionId: 'c1' }} />);
    expect(screen.getByTestId('hub-session-c1').getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(screen.getByTestId('hub-inspector')).toBeTruthy();
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('keeps deletion undoable when only the keyed hub surface unmounts', async () => {
    seedSessions();
    deleteConversation.mockResolvedValue(true);
    const view = render(<ShellWithHub />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('hub-session-c1'));
    fireEvent.click(screen.getByTestId('hub-menu-session-c1'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    view.rerender(<ShellWithHub showHub={false} />);
    expect(deleteConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('hub-session-c1')).toBeTruthy();
    expect(screen.getByTestId('hub-open-work-c1')).toBeTruthy();
    act(() => vi.advanceTimersByTime(HUB_DELETE_UNDO_MS));
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('gives each command its own nonce and ignores stale acknowledgements', async () => {
    seedSessions();
    vi.spyOn(Date, 'now').mockReturnValue(10);
    const onCommandChip = vi.fn();
    await act(async () => { render(<ShellWithHub showHub={false} controllerInputs={{ onCommandChip }} />); });
    pickCommand('template');
    pickCommand('prototype');
    expect(onCommandChip.mock.calls.map(([chip]) => chip)).toEqual([
      { id: 'template', nonce: 1 }, { id: 'prototype', nonce: 2 },
    ]);
    fireEvent.click(screen.getByTestId('consume-old-chip'));
    expect(screen.getByTestId('pending-chip').textContent).toBe('2');
  });

  it('delivers a template command once when the composer mounts on a later surface', async () => {
    seedSessions();
    const onOpenNewProject = vi.fn();
    const view = render(<ShellWithHub showHub={false} onOpenNewProject={onOpenNewProject} />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    pickCommand('template');
    expect(onOpenNewProject).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<ShellWithHub onOpenNewProject={onOpenNewProject} />); });
    expect(onOpenNewProject).toHaveBeenCalledExactlyOnceWith('template');
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
    view.rerender(<ShellWithHub showHub={false} onOpenNewProject={onOpenNewProject} />);
    await act(async () => { view.rerender(<ShellWithHub onOpenNewProject={onOpenNewProject} />); });
    expect(onOpenNewProject).toHaveBeenCalledTimes(1);
  });

  it('hands a palette plugin command across a surface swap to the real composer', async () => {
    seedSessions();
    let resolveCatalog!: (plugins: typeof PLUGINS) => void;
    const catalog = new Promise<typeof PLUGINS>((resolve) => { resolveCatalog = resolve; });
    listPlugins.mockReturnValue(catalog);
    const onCommandChip = vi.fn();
    const view = render(<ShellWithHub showHub={false} controllerInputs={{ onCommandChip }} />);
    await act(async () => { await Promise.all(listConversations.mock.results.map((result) => result.value)); });
    pickCommand('prototype');
    expect(onCommandChip).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('hub-command-palette')).toBeNull();
    await act(async () => { view.rerender(<ShellWithHub controllerInputs={{ onCommandChip }} />); });
    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pending-chip').textContent).toBe('1');
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    await act(async () => { resolveCatalog(PLUGINS); await catalog; });
    expect(screen.getByTestId('home-hero-active-type-chip').dataset['chipId']).toBe('prototype');
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
    fireEvent.click(screen.getByTestId('home-hero-active-type-chip'));
    await act(async () => { fireEvent(window, new CustomEvent('readable-studio:plugins-changed')); });
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    view.rerender(<ShellWithHub showHub={false} controllerInputs={{ onCommandChip }} />);
    await act(async () => { view.rerender(<ShellWithHub controllerInputs={{ onCommandChip }} />); });
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    // A new selection of the same command is a new intent, not a replay.
    pickCommand('prototype');
    expect(screen.getByTestId('home-hero-active-type-chip').dataset['chipId']).toBe('prototype');
    expect(onCommandChip.mock.calls.map(([chip]) => chip.nonce)).toEqual([1, 2]);
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
  });

  it('keeps an unaccepted command through unmount and ignores the old catalogue response', async () => {
    seedSessions();
    let resolveCatalog!: (plugins: typeof PLUGINS) => void;
    const catalog = new Promise<typeof PLUGINS>((resolve) => { resolveCatalog = resolve; });
    listPlugins.mockReturnValueOnce(catalog);
    const view = render(<ShellWithHub />);
    pickCommand('prototype');
    view.rerender(<ShellWithHub showHub={false} />);
    await act(async () => { resolveCatalog(PLUGINS); await catalog; });
    expect(screen.getByTestId('pending-chip').textContent).toBe('1');
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    listPlugins.mockResolvedValue(PLUGINS);
    await act(async () => { view.rerender(<ShellWithHub />); });
    expect(screen.getByTestId('home-hero-active-type-chip').dataset['chipId']).toBe('prototype');
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
  });

  it('does not acknowledge a missing plugin and accepts it when the catalogue changes', async () => {
    seedSessions();
    await act(async () => { render(<ShellWithHub />); });
    pickCommand('prototype');
    expect(screen.getByTestId('pending-chip').textContent).toBe('1');
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    listPlugins.mockResolvedValue(PLUGINS);
    await act(async () => { fireEvent(window, new CustomEvent('readable-studio:plugins-changed')); });
    expect(screen.getByTestId('home-hero-active-type-chip').dataset['chipId']).toBe('prototype');
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
  });

  it('keeps a template command pending until its destination can accept it', async () => {
    seedSessions();
    const view = render(<ShellWithHub />);
    pickCommand('template');
    expect(screen.getByTestId('pending-chip').textContent).toBe('1');
    const onOpenNewProject = vi.fn();
    await act(async () => { view.rerender(<ShellWithHub onOpenNewProject={onOpenNewProject} />); });
    expect(onOpenNewProject).toHaveBeenCalledExactlyOnceWith('template');
    expect(screen.getByTestId('pending-chip').textContent).toBe('');
  });

  it.each(['prototype', 'template', 'continue'])('acknowledges %s once even if the owner retains the nonce', async (id) => {
    seedSessions();
    listPlugins.mockResolvedValue(PLUGINS);
    const onCommandChipAccepted = vi.fn();
    const onOpenNewProject = vi.fn();
    const onSubmit = vi.fn();
    const home = () => (
      <StrictMode>
        <HomeView
          projects={PROJECTS}
          onSubmit={onSubmit}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
          onOpenNewProject={onOpenNewProject}
          commandChip={{ id, nonce: 7 }}
          onCommandChipAccepted={onCommandChipAccepted}
        />
      </StrictMode>
    );
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(home()); });
    expect(onCommandChipAccepted).toHaveBeenCalledExactlyOnceWith(7);
    if (id === 'prototype') fireEvent.click(screen.getByTestId('home-hero-active-type-chip'));
    await act(async () => {
      view.rerender(home());
      fireEvent(window, new CustomEvent('readable-studio:plugins-changed'));
    });
    expect(onCommandChipAccepted).toHaveBeenCalledExactlyOnceWith(7);
    expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    expect(onOpenNewProject).toHaveBeenCalledTimes(id === 'template' ? 1 : 0);
    expect(onSubmit).toHaveBeenCalledTimes(id === 'continue' ? 1 : 0);
  });
});
