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
import { MODEL_SELECTION_REQUIRED_EVENT } from '../../src/components/agentModelSelection';
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
  const controls = (configOverrides: Partial<AppConfig>) => (
    <div className="home-hero__execution-switcher home-hero__execution-switcher--agent-model">
      <InlineModelSwitcher {...props} config={{ ...baseConfig, ...configOverrides }} variant="agent" />
      <InlineModelSwitcher {...props} config={{ ...baseConfig, ...configOverrides }} variant="model" />
    </div>
  );
  const view = render(controls(overrides));
  return {
    ...view,
    onAgentChange,
    onAgentModelChange,
    rerenderSplit: (configOverrides: Partial<AppConfig>) => view.rerender(controls(configOverrides)),
  };
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

  it('shows the localized unselected label with a small warning mark', () => {
    renderSplit({ agentModels: {} });

    expect(screen.getByTestId('inline-model-switcher-model-label').textContent)
      .toContain('None selected');
    expect(screen.getByTestId('inline-model-switcher-model-warning-mark').textContent)
      .toBe('!');
  });

  it('shakes the model name and keeps the required-selection toast in an unclipped layer', () => {
    const { rerenderSplit } = renderSplit({ agentModels: {} });
    const trigger = screen.getByTestId('inline-model-switcher-model-trigger');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(180, 10, 120, 30),
    );

    fireEvent(window, new Event(MODEL_SELECTION_REQUIRED_EVENT));

    const toast = screen.getByTestId('inline-model-switcher-model-toast');
    expect(trigger.className).toContain('is-model-warning');
    expect(toast.textContent).toBe('You must select a model');
    expect(toast.parentElement).toBe(document.body);
    expect(toast.style.right).toBe(`${window.innerWidth - 300}px`);
    expect(toast.style.top).toBe('45px');

    const firstLabel = screen.getByTestId('inline-model-switcher-model-label');
    fireEvent(firstLabel, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .toContain('is-model-warning');

    fireEvent(window, new Event(MODEL_SELECTION_REQUIRED_EVENT));

    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .toContain('is-model-warning');
    expect(screen.getByTestId('inline-model-switcher-model-label')).not.toBe(firstLabel);
    expect(screen.getByTestId('inline-model-switcher-model-toast')).toBe(toast);

    rerenderSplit({ agentModels: { codex: { model: 'gpt-5-mini' } } });
    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .not.toContain('is-model-warning');
    expect(screen.queryByTestId('inline-model-switcher-model-toast')).toBeNull();
  });

  it('shows a default-only CLI as usable without an unselected warning', () => {
    renderSplit(
      { agentId: 'claude', agentModels: {} },
      { agents: [codexAgent, claudeAgent] },
    );

    expect(screen.getByTestId('inline-model-switcher-model-label').textContent)
      .toContain('Default');
    expect(screen.queryByTestId('inline-model-switcher-model-warning-mark')).toBeNull();
  });

  it('gives the agent trigger the model trigger\'s chevron, after its icon', () => {
    renderSplit();

    const agent = screen.getByTestId('inline-model-switcher-agent-trigger');
    const model = screen.getByTestId('inline-model-switcher-model-trigger');
    const agentChevron = agent.querySelector('.inline-switcher__chip-chevron');
    const modelChevron = model.querySelector('.inline-switcher__chip-chevron');
    expect(agentChevron).not.toBeNull();
    expect(modelChevron).not.toBeNull();
    // Identical glyph: same element, size and class, so the two chevrons can
    // only ever be styled together.
    expect(agentChevron!.outerHTML).toBe(modelChevron!.outerHTML);
    // Right of the icon: the chevron is the trigger's last child and the icon
    // precedes it, so the button reads icon -> chevron like label -> chevron.
    const icon = agent.querySelector('.inline-switcher__chip-icon');
    expect(icon).not.toBeNull();
    expect(agent.lastElementChild).toBe(agentChevron);
    expect(icon!.compareDocumentPosition(agentChevron!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    // The agent button stays icon-only otherwise: no text label sneaks in.
    expect(agent.textContent).toBe('');
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

    fireEvent.click(within(popover).getByRole('option', { name: /GPT-5 mini/i }));
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
