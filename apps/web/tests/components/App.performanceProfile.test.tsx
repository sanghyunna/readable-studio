// @vitest-environment jsdom

// `performanceProfile` is one App-owned state: the Hub toggle and the Settings
// switch both write it through the existing save/sync path, and App stamps the
// root (`data-performance-profile`) plus flips the root MotionConfig to
// `reducedMotion="always"` only while low. A daemon-reconciled value on
// startup must restamp the root the same way.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import { detectClientType } from '../../src/analytics/identity';
import { listProjectRuns } from '../../src/providers/daemon';

vi.mock('../../src/analytics/identity', () => ({ detectClientType: vi.fn(() => 'web') }));
vi.mock('../../src/providers/daemon', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/daemon')>(),
  listProjectRuns: vi.fn().mockResolvedValue([]),
}));
import type { AppConfig } from '../../src/types';
import {
  DEFAULT_PET,
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

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home', view: 'home' }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    config,
    onConfigPersist,
  }: {
    config: AppConfig;
    onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  }) => {
    return (
      <div className="entry-shell entry-shell--no-header">
        <span data-testid="profile-probe">{config.performanceProfile ?? 'full'}</span>
        <button
          type="button"
          onClick={() =>
            void onConfigPersist({
              ...config,
              performanceProfile: config.performanceProfile === 'low' ? 'full' : 'low',
            })
          }
        >
          flip
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/ProjectView', () => ({ ProjectView: () => null }));
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
  performanceProfile: 'full',
};

beforeEach(() => {
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchDesignSystems).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(listProjects).mockResolvedValue([]);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('data-performance-profile');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// The vitest alias for motion/react renders the root MotionConfig as a probe
// carrying its `reducedMotion` mode.
function motionMode(): string | null {
  return document.querySelector('[data-testid="motion-config"]')?.getAttribute('data-reduced-motion') ?? null;
}

describe('App performance profile state', () => {
  it.each([
    { performanceProfile: 'full', client: 'desktop', adopted: true },
    { performanceProfile: 'low', client: 'desktop', adopted: true },
    { performanceProfile: 'full', client: 'web', adopted: true },
    { performanceProfile: 'low', client: 'web', adopted: true },
    { performanceProfile: 'full', client: 'web', adopted: false },
    { performanceProfile: 'low', client: 'web', adopted: false },
  ] as const)('requests pet state only for a consumed surface in $client/$performanceProfile', async ({ performanceProfile, client, adopted }) => {
    // Given a main window with the pet enabled.
    vi.useFakeTimers();
    vi.mocked(detectClientType).mockReturnValueOnce(client);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.mocked(loadConfig).mockReturnValue({
      ...baseConfig, performanceProfile,
      pet: { ...DEFAULT_PET, adopted, enabled: true },
    });
    // When startup and multiple fallback deadlines complete.
    await act(async () => { render(<App />); });
    await act(async () => { vi.advanceTimersByTime(45000); });
    // Then only the browser App, which renders the overlay, requests run state.
    expect(vi.mocked(listProjectRuns).mock.calls.length > 0).toBe(client === 'web' && adopted);
  });

  it('removes a stale low stamp when the profile defaults to full', async () => {
    // Given a stale pre-hydration stamp and the default full profile.
    document.documentElement.setAttribute('data-performance-profile', 'low');
    // When App mounts and React flushes the resolved startup work.
    await act(async () => { render(<App />); });
    // Then full removes the stamp and respects the OS motion preference.
    expect(document.documentElement.getAttribute('data-performance-profile')).toBeNull();
    expect(motionMode()).toBe('user');
  });

  it.each([
    { initial: 'full', next: 'low', stamp: 'low', motion: 'always' },
    { initial: 'low', next: 'full', stamp: null, motion: 'user' },
  ] as const)('applies $next when toggled from $initial', async ({ initial, next, stamp, motion }) => {
    // Given App mounted with the opposite profile.
    vi.mocked(loadConfig).mockReturnValue({ ...baseConfig, performanceProfile: initial });
    await act(async () => { render(<App />); });
    // When the profile is toggled through App's persistence callback.
    await act(async () => {
      fireEvent.click(screen.getByText('flip'));
    });
    // Then the stamp, motion mode, and saved preference agree.
    expect(screen.getByTestId('profile-probe').textContent).toBe(next);
    expect(document.documentElement.getAttribute('data-performance-profile')).toBe(stamp);
    expect(motionMode()).toBe(motion);
    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ performanceProfile: next }),
    );
    expect(vi.mocked(syncConfigToDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ performanceProfile: next }),
    );
  });

  it.each([
    ['low', 'full'],
    ['full', 'low'],
    ['low', 'low'],
  ] as const)('keeps daemon %s across reload when the mirror is %s', async (profile, mirror) => {
    // Given the real persistence adapter and a CLI-updated daemon.
    const actual = await vi.importActual<typeof import('../../src/state/config')>('../../src/state/config');
    vi.mocked(loadConfig).mockImplementation(actual.loadConfig);
    vi.mocked(saveConfig).mockImplementation(actual.saveConfig);
    vi.mocked(mergeDaemonConfig).mockImplementation(actual.mergeDaemonConfig);
    vi.mocked(fetchDaemonConfig).mockImplementation(actual.fetchDaemonConfig);
    vi.mocked(syncConfigToDaemon).mockImplementation(actual.syncConfigToDaemon);
    actual.saveConfig({ ...baseConfig, performanceProfile: mirror });
    actual.applyPerformanceProfileToDocument(mirror);
    const writes: Record<string, unknown>[] = [];
    const resolveResponse = vi.fn<(response: Response) => void>();
    const response = new Promise<Response>((resolve) => { resolveResponse.mockImplementation(resolve); });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/app-config') return new Response('{}');
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return new Response('{}');
      }
      return response;
    }));
    // When reload waits for the daemon and then reconciles its response.
    await act(async () => { render(<App />); });
    expect(document.documentElement.getAttribute('data-performance-profile')).toBe(mirror === 'low' ? 'low' : null);
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ config: { performanceProfile: profile, enabledAgentIds: [] } })));
    });
    // Then the authoritative value repaints, updates the hint, and is never pushed back on load.
    expect(screen.getByTestId('profile-probe').textContent).toBe(profile);
    expect(document.documentElement.getAttribute('data-performance-profile')).toBe(profile === 'low' ? 'low' : null);
    expect(actual.loadConfig().performanceProfile).toBe(profile);
    expect(writes.every((body) => !Object.hasOwn(body, 'performanceProfile'))).toBe(true);
  });

  it('restamps the root when startup reconciles a low daemon profile', async () => {
    // Given a full local profile reconciled to the daemon's low profile.
    vi.mocked(mergeDaemonConfig).mockImplementation((local) => ({
      ...local,
      performanceProfile: 'low',
    }));
    // When App mounts and React flushes the resolved startup work.
    await act(async () => { render(<App />); });
    // Then the daemon preference controls the stamp and motion mode.
    expect(document.documentElement.getAttribute('data-performance-profile')).toBe('low');
    expect(motionMode()).toBe('always');
  });
});
