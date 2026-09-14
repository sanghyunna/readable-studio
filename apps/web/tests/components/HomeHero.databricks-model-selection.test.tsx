// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { KEY_ENTER_COMMAND } from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeHero } from '../../src/components/HomeHero';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import {
  hasRequiredModelSelection,
  requireModelSelection,
} from '../../src/components/agentModelSelection';
import {
  getHomeHeroEditor,
  homeHeroPromptText,
  setHomeHeroPrompt,
} from '../helpers/home-hero-lexical';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
}));

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: '',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'databricks',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const databricksModel = { id: 'dbx-luna', label: 'Luna' };

function databricksAgent(models: AgentInfo['models'] = []): AgentInfo {
  return {
    id: 'databricks',
    name: 'Databricks',
    bin: 'databricks',
    available: true,
    version: '0.276.0',
    models,
    modelSelectionRequired: true,
    modelManagement: 'databricks',
  };
}

const piAgent: AgentInfo = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [{ id: 'gpt-5', label: 'GPT-5' }],
};

interface HarnessProps {
  agents?: AgentInfo[];
  config?: AppConfig;
  draft?: string;
  submitReady?: boolean;
  submitDisabled?: boolean;
  interactionLocked?: boolean;
  submitting?: boolean;
  onProjectSubmit?: () => void;
}

function SubmitHarness({
  agents = [databricksAgent()],
  config = baseConfig,
  draft = 'Retain this draft',
  submitReady,
  submitDisabled = false,
  interactionLocked = false,
  submitting = false,
  onProjectSubmit = vi.fn(),
}: HarnessProps) {
  const [currentConfig, setCurrentConfig] = useState(config);
  const modelSelected = hasRequiredModelSelection(currentConfig, agents);
  const handleSubmit = () => {
    if (!requireModelSelection(currentConfig, agents)) return;
    onProjectSubmit();
  };

  return (
    <HomeHero
      surface="hub"
      prompt={draft}
      onPromptChange={vi.fn()}
      onSubmit={handleSubmit}
      submitting={submitting}
      activePluginTitle={null}
      activeChipId={null}
      onClearActivePlugin={vi.fn()}
      pluginOptions={[]}
      pluginsLoading={false}
      pendingPluginId={null}
      pendingChipId={null}
      onPickPlugin={vi.fn()}
      onPickChip={vi.fn()}
      contextItemCount={0}
      error={null}
      submitDisabled={submitDisabled}
      interactionLocked={interactionLocked}
      submitReady={submitReady ?? modelSelected}
      executionSwitcher={
        <InlineModelSwitcher
          config={currentConfig}
          agents={agents}
          daemonLive
          variant="model"
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={(agentId, choice) => {
            setCurrentConfig((current) => ({
              ...current,
              agentModels: {
                ...current.agentModels,
                [agentId]: { ...current.agentModels?.[agentId], ...choice },
              },
            }));
          }}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      }
    />
  );
}

function pressEnterInHomeHero(): void {
  const event = {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault() {},
  } as unknown as KeyboardEvent;
  act(() => {
    getHomeHeroEditor().dispatchCommand(KEY_ENTER_COMMAND, event);
  });
}

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {});
}

describe('HomeHero model-selection submission gate', () => {
  it('routes a click with an unselected Databricks model through the existing warning without submitting', async () => {
    const onProjectSubmit = vi.fn();
    render(<SubmitHarness onProjectSubmit={onProjectSubmit} submitReady={false} />);
    await settle();
    setHomeHeroPrompt('Retain this draft');

    const send = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    expect(onProjectSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .toContain('is-model-warning');
    expect(screen.getByTestId('inline-model-switcher-model-toast')).toBeTruthy();
    expect(homeHeroPromptText()).toBe('Retain this draft');
  });

  it('routes Enter with an unselected Databricks model through the same warning without submitting', async () => {
    const onProjectSubmit = vi.fn();
    render(<SubmitHarness onProjectSubmit={onProjectSubmit} submitReady={false} />);
    await settle();
    setHomeHeroPrompt('Retain this draft');

    pressEnterInHomeHero();

    expect(onProjectSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .toContain('is-model-warning');
    expect(screen.getByTestId('inline-model-switcher-model-toast')).toBeTruthy();
    expect(homeHeroPromptText()).toBe('Retain this draft');
  });

  it('keeps Send disabled without a draft', () => {
    render(<SubmitHarness draft="" submitReady={false} />);

    expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['active run lock', { interactionLocked: true }],
    ['hydration lock', { submitDisabled: true }],
    ['ordinary submitting state', { submitting: true }],
  ])('keeps Send disabled for a %s', (_name, locks) => {
    render(<SubmitHarness submitReady {...locks} />);

    expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits normally after an explicit Databricks model selection', () => {
    const onProjectSubmit = vi.fn();
    render(
      <SubmitHarness
        agents={[databricksAgent([databricksModel])]}
        onProjectSubmit={onProjectSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-option-dbx-luna'));
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onProjectSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('inline-model-switcher-model-toast')).toBeNull();
  });

  it.each([
    ['Pi', piAgent, { ...baseConfig, agentId: 'pi', agentModels: {} }],
    ['another selected agent', codexAgent, {
      ...baseConfig,
      agentId: 'codex',
      agentModels: { codex: { model: 'gpt-5' } },
    }],
  ])('keeps normal submission for %s', (_name, agent, config) => {
    const onProjectSubmit = vi.fn();
    render(<SubmitHarness agents={[agent]} config={config} onProjectSubmit={onProjectSubmit} />);

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onProjectSubmit).toHaveBeenCalledTimes(1);
  });
});
