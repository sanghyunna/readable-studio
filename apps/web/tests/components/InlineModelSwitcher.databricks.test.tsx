// @vitest-environment jsdom

/**
 * Databricks model picker behavior.
 *
 * The Databricks agent owns its model catalogue: the dropdown always ends in a
 * quiet "Add Models" action row, that row is an action (never a model value),
 * and an empty catalogue shows the action row alone while sending stays
 * blocked by the explicit-model requirement.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import {
  applyDatabricksModels,
  DATABRICKS_ADD_MODELS_ACTION_ID,
  DATABRICKS_MODELS_CHANGED_EVENT,
  databricksModelsFromEvent,
} from '../../src/components/databricksModels';
import { hasRequiredModelSelection } from '../../src/components/agentModelSelection';
import type { AgentModelOption } from '@readable-studio/contracts';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
}));

// The modal is covered by its own suite; here it only needs to open.
vi.mock('../../src/components/DatabricksAddModelsModal', () => ({
  DatabricksAddModelsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="databricks-add-models-modal" /> : null,
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
  agentId: 'databricks',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

function databricksAgent(models: AgentModelOption[] = []): AgentInfo {
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

const lunaModel: AgentModelOption = {
  id: 'dbx-luna',
  label: 'oai-luna-model-service',
  source: 'databricks',
  connectionId: 'prof-1',
  endpointId: 'ep-luna',
  availability: 'compatible',
};

function renderModelSwitcher(
  config: Partial<AppConfig> = {},
  agents: AgentInfo[] = [databricksAgent()],
) {
  const onAgentModelChange = vi.fn();
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      daemonLive={true}
      variant="model"
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={onAgentModelChange}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  return { ...view, onAgentModelChange };
}

afterEach(cleanup);

const addModelsActionTestId =
  'inline-model-switcher-model-action-add-databricks-models';

function dropdownRows(root: HTMLElement): Array<string | null> {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[role="option"], [data-model-action]'),
  ).map((row) => row.dataset.modelAction ?? row.textContent?.trim() ?? null);
}

describe('Databricks model dropdown', () => {
  it('renders exactly one row — the Add Models action — when nothing is registered', () => {
    renderModelSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-model-popover');

    expect(within(popover).queryAllByRole('option')).toHaveLength(0);
    const action = within(popover).getByTestId(addModelsActionTestId);
    expect(action).toBeTruthy();
    expect(action.textContent).toBe('Add Models');
    // This direct model-only popover has exactly one row, the catalogue action.
    expect(Array.from(popover.children)).toEqual([action]);
    expect(dropdownRows(popover)).toEqual([DATABRICKS_ADD_MODELS_ACTION_ID]);
    // The action is not a listbox option, so it can never be picked as a value.
    expect(action.getAttribute('role')).toBeNull();
    expect(action.getAttribute('aria-selected')).toBeNull();
    // No generic settings row or "configure in Settings" hint may follow it.
    expect(within(popover).queryByTestId('inline-model-switcher-open-settings')).toBeNull();
    expect(within(popover).queryByText('Configure provider in Settings')).toBeNull();
    // Sending stays blocked by the explicit-model requirement.
    expect(
      hasRequiredModelSelection(
        { mode: 'daemon', model: '', agentId: 'databricks', agentModels: {} },
        [databricksAgent()],
      ),
    ).toBe(false);
  });

  it('never reports the action row as a selected model', () => {
    const { onAgentModelChange } = renderModelSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    fireEvent.click(
      screen.getByTestId('inline-model-switcher-model-action-add-databricks-models'),
    );

    expect(onAgentModelChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('databricks-add-models-modal')).toBeTruthy();
    // The dropdown closes behind the modal.
    expect(screen.queryByTestId('inline-model-switcher-model-popover')).toBeNull();
  });

  it('keeps the action row after the registered models and never marks it active', () => {
    const { onAgentModelChange } = renderModelSwitcher(
      { agentModels: { databricks: { model: 'dbx-luna' } } },
      [databricksAgent([lunaModel])],
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-model-popover');
    const options = within(popover).getAllByRole('option');

    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe('oai-luna-model-service');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    const action = within(popover).getByTestId(addModelsActionTestId);
    // Normal model rows precede the final action row, with no settings row.
    expect(Array.from(popover.children).map((child) => child.getAttribute('data-testid')))
      .toEqual(['inline-model-switcher-model-list', addModelsActionTestId]);
    expect(dropdownRows(popover)).toEqual([
      'oai-luna-model-service',
      DATABRICKS_ADD_MODELS_ACTION_ID,
    ]);
    expect(action.getAttribute('role')).toBeNull();
    expect(action.getAttribute('aria-selected')).toBeNull();
    expect(within(popover).queryByTestId('inline-model-switcher-open-settings')).toBeNull();

    fireEvent.click(action);
    expect(onAgentModelChange).not.toHaveBeenCalled();
  });

  it('excludes the action id from model resolution even if it were persisted', () => {
    renderModelSwitcher(
      { agentModels: { databricks: { model: DATABRICKS_ADD_MODELS_ACTION_ID } } },
      [databricksAgent([lunaModel])],
    );

    expect(screen.getByTestId('inline-model-switcher-model-label').textContent)
      .toContain('None selected');
    expect(
      hasRequiredModelSelection(
        {
          mode: 'daemon',
          model: '',
          agentId: 'databricks',
          agentModels: { databricks: { model: DATABRICKS_ADD_MODELS_ACTION_ID } },
        },
        [databricksAgent([lunaModel])],
      ),
    ).toBe(false);
  });

  it('adds a normal row above the action row when a model is registered', () => {
    // Mirrors the App.tsx wiring: the modal publishes the fresh catalogue and
    // the managed agent's model list is replaced.
    function Host() {
      const [agents, setAgents] = useState<AgentInfo[]>([databricksAgent()]);
      useEffect(() => {
        const onChanged = (event: Event) => {
          const models = databricksModelsFromEvent(event);
          if (models) setAgents((current) => applyDatabricksModels(current, models));
        };
        window.addEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
      }, []);
      return (
        <InlineModelSwitcher
          config={baseConfig}
          agents={agents}
          daemonLive={true}
          variant="model"
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );
    }
    render(<Host />);

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    let popover = screen.getByTestId('inline-model-switcher-model-popover');
    expect(within(popover).queryAllByRole('option')).toHaveLength(0);

    // The host's listener is a plain window listener, so React only schedules
    // the agents update; act() flushes that render before the DOM is read.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DATABRICKS_MODELS_CHANGED_EVENT, { detail: { models: [lunaModel] } }),
      );
    });

    popover = screen.getByTestId('inline-model-switcher-model-popover');
    const options = within(popover).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe('oai-luna-model-service');
    expect(
      within(popover).getByTestId('inline-model-switcher-model-action-add-databricks-models'),
    ).toBeTruthy();
    // Registration is not selection: nothing became the active model.
    expect(
      within(popover).queryByRole('option', { selected: true }),
    ).toBeNull();
    expect(screen.getByTestId('inline-model-switcher-model-label').textContent)
      .toContain('None selected');
  });

  it('uses Add Models as the combined switcher dropdown’s only row when nothing is registered', () => {
    render(
      <InlineModelSwitcher
        config={baseConfig}
        agents={[databricksAgent()]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const dropdown = screen.getByTestId('inline-model-switcher-agent-model-popover');
    const action = within(dropdown).getByTestId(addModelsActionTestId);

    expect(within(dropdown).queryAllByRole('option')).toHaveLength(0);
    expect(dropdownRows(dropdown)).toEqual([DATABRICKS_ADD_MODELS_ACTION_ID]);
    expect(action.getAttribute('role')).toBeNull();
    expect(action.getAttribute('aria-selected')).toBeNull();
    expect(within(dropdown).queryByTestId('inline-model-switcher-open-settings')).toBeNull();
  });

  it('shows the action row at the end of the combined switcher dropdown too', () => {
    const onAgentModelChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={baseConfig}
        agents={[databricksAgent([lunaModel])]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={onAgentModelChange}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const dropdown = screen.getByTestId('inline-model-switcher-agent-model-popover');

    const options = within(dropdown).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe('oai-luna-model-service');
    const action = within(dropdown).getByTestId(addModelsActionTestId);
    expect(dropdownRows(dropdown)).toEqual([
      'oai-luna-model-service',
      DATABRICKS_ADD_MODELS_ACTION_ID,
    ]);
    expect(action.getAttribute('role')).toBeNull();
    expect(action.getAttribute('aria-selected')).toBeNull();
    expect(within(dropdown).queryByTestId('inline-model-switcher-open-settings')).toBeNull();

    fireEvent.click(action);
    expect(onAgentModelChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('databricks-add-models-modal')).toBeTruthy();
  });

  it('does not add the action row to other agents', () => {
    const codex: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.133.0',
      models: [{ id: 'gpt-5', label: 'GPT-5' }],
    };
    renderModelSwitcher(
      { agentId: 'codex', agentModels: { codex: { model: 'gpt-5' } } },
      [codex],
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const popover = screen.getByTestId('inline-model-switcher-model-popover');

    expect(within(popover).getAllByRole('option')).toHaveLength(1);
    expect(within(popover).queryByTestId(addModelsActionTestId)).toBeNull();
    // Generic settings remains available for normal direct CLI model pickers.
    expect(within(popover).getByTestId('inline-model-switcher-open-settings')).toBeTruthy();
  });
});
