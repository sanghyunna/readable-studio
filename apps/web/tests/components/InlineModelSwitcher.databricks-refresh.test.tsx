// @vitest-environment jsdom

/**
 * Databricks catalogue refresh from the model picker.
 *
 * The daemon learns a Claude endpoint's thinking levels in the background, so
 * the browser's cached catalogue can be stale. Opening the model picker
 * refetches it once (de-duplicated while in flight), and selecting a model
 * without levels schedules a bounded follow-up (3 s, 15 s, then stop). Fresh
 * catalogues travel through DATABRICKS_MODELS_CHANGED_EVENT, which the host
 * here applies exactly like App does, so ChatPane's effort control re-evaluates.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksModelsResponse, DatabricksRegisteredEndpoint } from '@readable-studio/contracts';

import { ChatPane } from '../../src/components/ChatPane';
import {
  applyDatabricksModels,
  DATABRICKS_MODELS_CHANGED_EVENT,
  databricksModelsFromEvent,
} from '../../src/components/databricksModels';
import { fetchDatabricksModels } from '../../src/providers/databricks';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppConfig, Conversation } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchVelaLoginStatus: async () => null,
  startVelaLogin: async () => ({ ok: false }),
  cancelVelaLogin: async () => undefined,
}));

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: async () => ({ ok: false, models: [] }),
}));

vi.mock('../../src/providers/databricks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/databricks')>()),
  fetchDatabricksModels: vi.fn(),
}));

const fetchModels = vi.mocked(fetchDatabricksModels);

const conversations: Conversation[] = [
  { id: 'conv-1', projectId: 'project-1', title: 'Conversation 1', createdAt: 1, updatedAt: 1 },
];

const CONFIG: AppConfig = {
  ...DEFAULT_CONFIG,
  mode: 'daemon',
  agentId: 'databricks',
  agentModels: { databricks: { model: 'dbm-claude' } },
};

function endpoint(withLevels: boolean): DatabricksRegisteredEndpoint {
  return {
    id: 'ep-claude',
    appModelId: 'dbm-claude',
    label: 'claude-endpoint',
    servedModelName: 'Claude',
    profileId: 'prof-1',
    availability: 'compatible',
    capabilities: { contextWindow: null, maxTokens: null },
    ...(withLevels ? { reasoningOptions: [{ id: 'high', label: 'High' }] } : {}),
  } as unknown as DatabricksRegisteredEndpoint;
}

function response(withLevels: boolean): DatabricksModelsResponse {
  return { models: [endpoint(withLevels)], revision: 1, issues: [] };
}

const staleAgent: AgentInfo = {
  id: 'databricks',
  name: 'Databricks',
  available: true,
  modelManagement: 'databricks',
  models: [{ id: 'dbm-claude', label: 'Claude', source: 'databricks' }],
} as AgentInfo;

/** Applies the published catalogue the same way App.tsx does. */
function Host() {
  const [agents, setAgents] = useState<AgentInfo[]>([staleAgent]);
  useEffect(() => {
    const onChanged = (event: Event) => {
      const models = databricksModelsFromEvent(event);
      if (models) setAgents((current) => applyDatabricksModels(current, models));
    };
    window.addEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
  }, []);
  return (
    <ChatPane
      projectKindForTracking="prototype"
      messages={[]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      conversations={conversations}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      projectMetadata={{ kind: 'prototype' }}
      config={CONFIG}
      agents={agents}
      daemonLive
      onOpenSettings={vi.fn()}
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
    />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  fetchModels.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Databricks model picker catalogue refresh', () => {
  it('refetches once on open and shows the learned thinking dropdown without a reload', async () => {
    const pending = deferred<DatabricksModelsResponse>();
    fetchModels.mockReturnValue(pending.promise);
    render(<Host />);
    expect(screen.queryByTestId('inline-model-switcher-reasoning-trigger')).toBeNull();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    expect(fetchModels).toHaveBeenCalledTimes(1);
    // The cached list stays visible while the request is in flight.
    expect(screen.getByTestId('inline-model-switcher-model-option-dbm-claude')).toBeTruthy();

    await act(async () => { pending.resolve(response(true)); await pending.promise; });
    expect(await screen.findByTestId('inline-model-switcher-reasoning-trigger')).toBeTruthy();
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second catalogue request while one is in flight', async () => {
    const pending = deferred<DatabricksModelsResponse>();
    fetchModels.mockReturnValue(pending.promise);
    render(<Host />);
    const trigger = screen.getByTestId('inline-model-switcher-model-trigger');
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(response(true)); await pending.promise; });
  });

  it('follow-up refetch stops after the first attempt that learns levels', async () => {
    vi.useFakeTimers();
    fetchModels.mockResolvedValue(response(true));
    render(<Host />);
    expect(fetchModels).toHaveBeenCalledTimes(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('inline-model-switcher-reasoning-trigger')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('follow-up refetch gives up after two attempts when no levels are learned', async () => {
    vi.useFakeTimers();
    fetchModels.mockResolvedValue(response(false));
    render(<Host />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('inline-model-switcher-reasoning-trigger')).toBeNull();
  });
});
