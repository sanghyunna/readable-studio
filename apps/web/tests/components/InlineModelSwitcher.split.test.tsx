// @vitest-environment jsdom

/**
 * Split mounts of InlineModelSwitcher.
 *
 * The Hub composer footer asks for two separate buttons — agent, then model to
 * its right — each opening only its own concern. They are the same component
 * in a different `variant`, so agent selection, model selection and the
 * provider-models fetch each still exist exactly once.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
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
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: { codex: { model: 'gpt-5' } },
  agentCliEnv: {},
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0',
  models: [
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-5-mini', label: 'GPT-5 mini' },
  ],
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
};

function renderSplit(
  overrides: Partial<AppConfig> = {},
  options: { agents?: AgentInfo[]; agentsLoading?: boolean } = {},
) {
  const onAgentChange = vi.fn();
  const onAgentModelChange = vi.fn();
  const props = {
    config: { ...baseConfig, ...overrides },
    agents: options.agents ?? [codexAgent, claudeAgent],
    agentsLoading: options.agentsLoading ?? false,
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange,
    onAgentModelChange,
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const view = render(
    <div className="home-hero__execution-switcher home-hero__execution-switcher--agent-model">
      <InlineModelSwitcher {...props} variant="agent" />
      <InlineModelSwitcher {...props} variant="model" />
    </div>,
  );
  return { ...view, onAgentChange, onAgentModelChange };
}

afterEach(cleanup);

describe('InlineModelSwitcher split variants', () => {
  it('renders two distinct triggers, agent before model', () => {
    renderSplit();

    const agent = screen.getByTestId('inline-model-switcher-agent-trigger');
    const model = screen.getByTestId('inline-model-switcher-model-trigger');

    expect(agent).not.toBe(model);
    expect(agent.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    // The model button is labelled with the model, the agent button with the agent.
    expect(model.textContent).toContain('GPT-5');
    expect(agent.getAttribute('aria-label')).toContain('Codex CLI');
  });

  it('renders a neutral detecting state instead of no-agent while probing', () => {
    renderSplit(
      { agentId: null, agentModels: {} },
      { agents: [], agentsLoading: true },
    );

    const agent = screen.getByTestId('inline-model-switcher-agent-trigger');
    expect(agent.getAttribute('aria-label')).toContain('detecting');
    expect(agent.getAttribute('aria-label')).not.toContain('no agent');
    expect(agent.querySelector('svg')).not.toBeNull();
  });

  it('neither trigger shows a chevron that would imply an inline dropdown', () => {
    renderSplit();

    for (const id of ['agent', 'model'] as const) {
      const trigger = screen.getByTestId(`inline-model-switcher-${id}-trigger`);
      expect(trigger.querySelector('.inline-switcher__chip-chevron')).toBeNull();
    }
  });

  it('agent button opens agent switching only', () => {
    const { onAgentChange } = renderSplit();

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-agent-popover');

    // Agent choices are present…
    fireEvent.click(within(popover).getByTestId('inline-model-switcher-agent-claude'));
    expect(onAgentChange).toHaveBeenCalledWith('claude');
    // …and the model picker is not the popover's content.
    expect(
      screen.queryByTestId('inline-model-switcher-agent-model'),
    ).toBeNull();
  });

  it('model button opens model switching only', () => {
    const { onAgentModelChange } = renderSplit();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-model-popover');

    // No agent grid and no execution-mode segmented control in the model popover.
    expect(popover.querySelector('.inline-switcher__agent-grid')).toBeNull();
    expect(
      within(popover).queryByTestId('inline-model-switcher-mode-daemon'),
    ).toBeNull();

    fireEvent.click(within(popover).getByTestId('inline-model-switcher-agent-model'));
    fireEvent.click(screen.getByRole('option', { name: /GPT-5 mini/i }));
    expect(onAgentModelChange).toHaveBeenCalledWith('codex', { model: 'gpt-5-mini' });
  });

  it('Escape closes the popover and returns focus to its own trigger', () => {
    renderSplit();

    const model = screen.getByTestId('inline-model-switcher-model-trigger');
    fireEvent.click(model);
    expect(screen.getByTestId('inline-model-switcher-model-popover')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('inline-model-switcher-model-popover')).toBeNull();
    expect(document.activeElement).toBe(model);
  });

  it('click outside closes the popover', () => {
    renderSplit();

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-trigger'));
    expect(screen.getByTestId('inline-model-switcher-agent-popover')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('inline-model-switcher-agent-popover')).toBeNull();
  });

  it('portals each popover to document.body as a fixed layer', () => {
    renderSplit();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-model-popover');

    expect(popover.parentElement).toBe(document.body);
    expect(popover.className).toContain('inline-switcher__popover--layer');
  });
});
