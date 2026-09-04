// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AgentInfo, AppConfig } from '../../src/types';
import { loadConfig, mergeDaemonConfig, fetchDaemonConfig } from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { fetchAmrModels } from '../../src/providers/daemon';
import { listProjects, listTemplates } from '../../src/state/projects';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'home' as const }),
}));

// Surface the config passed to the real entry controls without pulling their
// unrelated UI behavior into these App-level bootstrap tests.
vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ config, agentsLoading }: { config: AppConfig; agentsLoading?: boolean }) => (
    <>
      <div data-testid="agent-id">
        {config.agentId ?? (agentsLoading ? 'detecting' : 'none')}
      </div>
      <div data-testid="onboarding-completed">
        {String(config.onboardingCompleted)}
      </div>
    </>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
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
    fetchAmrModels: vi.fn(),
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
    loadConfig: vi.fn(),
    // Keep the production overlay semantics: a daemon agentId must land before
    // App is allowed to fill an empty slot.
    mergeDaemonConfig: vi.fn(actual.mergeDaemonConfig),
    saveConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchDesignTemplates = vi.mocked(fetchDesignTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedFetchAmrModels = vi.mocked(fetchAmrModels);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);

function firstRunConfig(): AppConfig {
  return {
    mode: 'daemon',
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
    onboardingCompleted: false,
    agentModels: {},
    agentCliEnv: {},
  };
}

function agent(id: string, available = true): AgentInfo {
  return {
    id,
    name: id,
    bin: id,
    available,
    version: available ? '1.0.0' : null,
    models: available ? [{ id: 'default', label: 'Default' }] : [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const claudeOnly = [agent('claude')];

function wroteAgent(config: AppConfig | undefined, id: string): boolean {
  return config?.agentId === id;
}

describe('App first-run agent auto-select', () => {
  beforeEach(() => {
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([...claudeOnly]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchDesignTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListProjects.mockResolvedValue([]);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchAmrModels.mockResolvedValue({
      source: 'preset',
      refreshing: false,
      models: [{ id: 'amr-model', label: 'AMR Model' }],
    });
    mockedLoadConfig.mockReturnValue(firstRunConfig());
    mockedFetchDaemonConfig.mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('starts agent detection before health readiness and the deferred startup callback', async () => {
    const health = deferred<boolean>();
    const probe = deferred<AgentInfo[]>();
    mockedDaemonIsLive.mockReturnValue(health.promise);
    mockedFetchAgentsStream.mockReturnValue(probe.promise);
    let idleCallback: (() => void) | null = null;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    render(<App />);

    expect(mockedFetchAgentsStream).toHaveBeenCalledTimes(1);
    expect(idleCallback).toBeNull();
    expect(screen.getByTestId('agent-id').textContent).toBe('detecting');
    expect(screen.queryByText('none')).toBeNull();

    health.resolve(true);
    await waitFor(() => expect(idleCallback).not.toBeNull());
    expect(mockedListTemplates).not.toHaveBeenCalled();
    expect(mockedFetchAppVersionInfo).not.toHaveBeenCalled();
    probe.resolve([]);
  });

  it('auto-selects an available detected agent during onboarding', async () => {
    const { syncConfigToDaemon } = await import('../../src/state/config');
    const mockedSync = vi.mocked(syncConfigToDaemon);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-completed').textContent).toBe('false');
      expect(screen.getByTestId('agent-id').textContent).toBe('claude');
      expect(
        mockedSync.mock.calls.some(([config]) => wroteAgent(config, 'claude')),
      ).toBe(true);
    });
  });

  it.each([
    ['daemon response order', [agent('codex'), agent('gemini'), agent('claude'), agent('amr', false)]],
    ['reversed response order', [agent('amr', false), agent('claude'), agent('gemini'), agent('codex')]],
  ])('selects deterministically in registry order for the same set: %s', async (_label, agents) => {
    mockedFetchAgentsStream.mockResolvedValue(agents);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('claude');
    });
  });

  it('keeps a daemon-stored AMR choice during onboarding', async () => {
    const { saveConfig, syncConfigToDaemon } = await import('../../src/state/config');
    const mockedSave = vi.mocked(saveConfig);
    const mockedSync = vi.mocked(syncConfigToDaemon);
    mockedFetchAgentsStream.mockResolvedValue([agent('claude'), agent('amr')]);
    mockedFetchDaemonConfig.mockResolvedValue({ agentId: 'amr' });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('amr');
    });
    expect(
      mockedSave.mock.calls.some(([config]) => config.agentId === 'claude'),
    ).toBe(false);
    expect(
      mockedSync.mock.calls.some(([config]) => config.agentId === 'claude'),
    ).toBe(false);
  });

  it('shows a streamed detected agent temporarily without persisting a partial result', async () => {
    const { syncConfigToDaemon } = await import('../../src/state/config');
    const mockedSync = vi.mocked(syncConfigToDaemon);
    const probe = deferred<AgentInfo[]>();
    const codex = agent('codex');
    mockedFetchAgentsStream.mockImplementation(({ onAgent }) => {
      onAgent(codex);
      return probe.promise;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('codex');
    });
    expect(
      mockedSync.mock.calls.some(([config]) => wroteAgent(config, 'codex')),
    ).toBe(false);

    probe.resolve([codex]);
    await waitFor(() => {
      expect(
        mockedSync.mock.calls.some(([config]) => wroteAgent(config, 'codex')),
      ).toBe(true);
    });
  });
});
