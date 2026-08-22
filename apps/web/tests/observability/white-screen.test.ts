// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/types';

// Client-side telemetry network egress is hard-removed in this fork: the
// safety-event transport (`dispatch` in error-tracking.ts) is a no-op, so the
// white-screen detector can no longer be observed through a beacon `fetch`.
// We instead spy on `reportSafetyEvent` to assert the detector still RUNS its
// detection logic (it fires the event into the now-inert transport), while a
// real `fetch` spy proves no network request leaves the page.
const reportSafetyEvent = vi.fn();

vi.mock('../../src/analytics/error-tracking', () => ({
  reportSafetyEvent: (eventName: string, properties?: Record<string, unknown>) =>
    reportSafetyEvent(eventName, properties),
  // Retained as harmless stubs so any incidental imports resolve; the real
  // transport is bypassed by this mock.
  setExceptionTrackingContext: () => undefined,
  clearExceptionTrackingContext: () => undefined,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'home' as const }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ config, onOpenSettings }: { config: AppConfig; onOpenSettings: (section: string) => void }) => createElement(
    'main',
    { 'data-testid': 'home-ready' },
    createElement('button', { type: 'button' }, 'New project'),
    createElement('button', { type: 'button', onClick: () => onOpenSettings('codeAgents') }, 'Open agent settings'),
    createElement('span', { 'data-testid': 'selected-agent' }, config.agentId ?? 'none'),
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => createElement('main', null, 'Project view'),
}));

vi.mock('../../src/components/WorkspaceTabsBar', () => ({
  WorkspaceTabsBar: () => null,
  openWorkspaceTab: () => {},
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
  switchApiProtocolConfig: (config: AppConfig) => config,
  updateCurrentApiProtocolConfig: (config: AppConfig) => config,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/providers/daemon', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/daemon')>(
    '../../src/providers/daemon',
  );
  return {
    ...actual,
    fetchAmrModels: vi.fn().mockResolvedValue(null),
    fetchVelaLoginStatus: vi.fn().mockResolvedValue(null),
    listProjectRuns: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
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
    mergeDaemonConfig: vi.fn(actual.mergeDaemonConfig),
    saveConfig: vi.fn(),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

import { installWhiteScreenDetector } from '../../src/observability/white-screen';
import { App } from '../../src/App';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';
import {
  fetchDaemonConfig,
  loadConfig,
} from '../../src/state/config';

/**
 * The detector is allowed to be conservative on the false-negative side
 * (don't fire when the app actually rendered something) but must fire
 * when the user is really stuck on a non-app screen. The critical case —
 * called out by codex review on PR #2527 — is the dynamic-import loading
 * shell: `<div class="readable-loading-shell">A long loading label</div>`. That
 * string is well above the visible-text floor, so an earlier
 * implementation that only checked `body.innerText.length` would silently
 * treat the loading sentinel as a successful mount and cancel the timer.
 */

const fetchMock = vi.fn();
const ORIGINAL_FETCH = globalThis.fetch;

const appConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: 'default',
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  reportSafetyEvent.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-readable-app-mounted');
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgentsStream).mockReturnValue(new Promise(() => undefined));
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(fetchDesignSystems).mockResolvedValue([]);
  vi.mocked(fetchDesignTemplates).mockRejectedValue(new Error('deferred templates failed'));
  vi.mocked(fetchAppVersionInfo).mockRejectedValue(new Error('deferred version failed'));
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listTemplates).mockReturnValue(new Promise(() => undefined));
  vi.mocked(loadConfig).mockReturnValue({ ...appConfig });
  vi.mocked(fetchDaemonConfig).mockResolvedValue({ agentId: 'codex', designSystemId: 'default' });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  cleanup();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-readable-app-mounted');
  vi.clearAllMocks();
});

function lastSafetyEvent(): { event: string; properties: Record<string, unknown> } | null {
  const lastCall = reportSafetyEvent.mock.calls.at(-1);
  if (!lastCall) return null;
  return {
    event: lastCall[0] as string,
    properties: (lastCall[1] ?? {}) as Record<string, unknown>,
  };
}

describe('observability/white-screen', () => {
  it('lets Home mount before deferred registries settle or fail', () => {
    render(createElement(App));

    expect(screen.getByTestId('home-ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
    expect(document.documentElement.getAttribute('data-readable-app-mounted')).toBe('1');
    expect(screen.getByTestId('selected-agent').textContent).toBe('codex');
    expect(fetchAgentsStream).not.toHaveBeenCalled();
    expect(fetchDesignTemplates).not.toHaveBeenCalled();
    expect(fetchAppVersionInfo).not.toHaveBeenCalled();
  });

  it('starts agent detection when the agent settings section opens', async () => {
    render(createElement(App));

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchAgentsStream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open agent settings' }));

    expect(fetchAgentsStream).toHaveBeenCalledTimes(1);
  });

  it('runs the detector and reports client_white_screen (no network) when only the dynamic-import loading shell is in the DOM after the timeout', () => {
    // Reproduces the codex-review reported bug: the branded loading shell
    // is longer than the legacy 10-char floor.
    const shell = document.createElement('div');
    shell.className = 'readable-loading-shell';
    shell.textContent = 'A deliberately long loading label';
    document.body.appendChild(shell);

    installWhiteScreenDetector();
    // Drive the 5s timeout. requestIdleCallback/setTimeout are both fake-
    // timer-aware via vi.useFakeTimers above.
    vi.advanceTimersByTime(6000);

    // The detector still runs its detection logic and reports the event into
    // the (now-inert) safety transport — but nothing leaves over the network.
    expect(reportSafetyEvent).toHaveBeenCalled();
    const sent = lastSafetyEvent();
    expect(sent?.event).toBe('client_white_screen');
    expect(sent?.properties).toMatchObject({
      reason: 'app_not_mounted_after_timeout',
      timeout_ms: 5000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT report when the app sets the data-readable-app-mounted marker before the timeout', () => {
    // Simulate App.tsx's first useEffect setting the attribute.
    document.documentElement.setAttribute('data-readable-app-mounted', '1');

    installWhiteScreenDetector();
    vi.advanceTimersByTime(6000);

    expect(reportSafetyEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels the timer the moment a non-loading-shell child appears with real content', () => {
    // Start with only the loading shell.
    const shell = document.createElement('div');
    shell.className = 'readable-loading-shell';
    shell.textContent = 'A deliberately long loading label';
    document.body.appendChild(shell);

    installWhiteScreenDetector();
    // Wait halfway through the timeout window — still only loading shell.
    vi.advanceTimersByTime(2500);
    expect(reportSafetyEvent).not.toHaveBeenCalled();

    // Now the real App mounts — adds a meaningful child alongside the shell.
    const real = document.createElement('div');
    real.className = 'workspace-shell';
    real.textContent = 'New project · Recent · Plugins · …';
    document.body.appendChild(real);
    // Let MutationObserver microtasks process. jsdom runs them
    // synchronously after the mutation, but we still need to flush the
    // scheduled idle/timer queue.
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(3500);
      expect(reportSafetyEvent).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('reports when only sub-MIN_VISIBLE_TEXT non-shell content is present (still effectively blank)', () => {
    const tiny = document.createElement('div');
    tiny.textContent = '...';
    document.body.appendChild(tiny);

    installWhiteScreenDetector();
    vi.advanceTimersByTime(6000);

    expect(reportSafetyEvent).toHaveBeenCalled();
    const sent = lastSafetyEvent();
    expect(sent?.event).toBe('client_white_screen');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});