// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { getEn } from '../../src/i18n/locales/en';
const en = getEn();
import type { AgentInfo, AppConfig } from '../../src/types';

afterEach(cleanup);

const baseAgent: AgentInfo = {
  id: 'fixture',
  name: 'Fixture CLI',
  bin: 'fixture',
  available: true,
  models: [
    { id: 'fixture-a', label: 'fixture-a' },
    { id: 'fixture-b', label: 'fixture-b' },
  ],
};

const config: AppConfig = {
  mode: 'daemon', agentId: baseAgent.id, agentModels: {}, agentCliEnv: {},
  apiKey: '', apiProtocol: 'anthropic', apiVersion: '', baseUrl: '', model: '',
  apiProviderBaseUrl: '', apiProtocolConfigs: {}, skillId: null, designSystemId: null,
  onboardingCompleted: true,
};

function renderModelPicker(agent: AgentInfo) {
  const onAgentModelChange = vi.fn();
  render(
    <InlineModelSwitcher
      config={config}
      agents={[agent]}
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
  fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
  return { onAgentModelChange };
}

const expectedNote = en['modelSource.builtInDefaults'].replace('{agent}', baseAgent.name);

describe('InlineModelSwitcher model source marker', () => {
  test('a fallback-source agent exposes the built-in defaults note and links it to the listbox', () => {
    renderModelPicker({ ...baseAgent, modelsSource: 'fallback' });

    const note = screen.getByTestId('inline-model-switcher-source-note');
    expect(note.textContent).toBe(expectedNote);
    const list = screen.getByRole('listbox', { name: en['inlineSwitcher.modelLabel'] });
    expect(list.getAttribute('aria-describedby')).toBe(note.id);
  });

  test('a live-source agent renders no source note', () => {
    renderModelPicker({ ...baseAgent, modelsSource: 'live' });

    expect(screen.queryByTestId('inline-model-switcher-source-note')).toBeNull();
    expect(screen.queryByText(expectedNote)).toBeNull();
    const list = screen.getByRole('listbox', { name: en['inlineSwitcher.modelLabel'] });
    expect(list.getAttribute('aria-describedby')).toBeNull();
  });

  test.each(['fallback', 'live'] as const)(
    'selecting a model behaves the same for a %s-source agent',
    (modelsSource) => {
      const { onAgentModelChange } = renderModelPicker({ ...baseAgent, modelsSource });

      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['fixture-a', 'fixture-b']);
      fireEvent.click(screen.getByRole('option', { name: 'fixture-b' }));

      expect(onAgentModelChange).toHaveBeenCalledTimes(1);
      expect(onAgentModelChange).toHaveBeenCalledWith('fixture', { model: 'fixture-b' });
    },
  );
});
