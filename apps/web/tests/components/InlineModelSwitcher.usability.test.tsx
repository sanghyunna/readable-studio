// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

afterEach(cleanup);

test('a failed rescan removes stale model options from an already-open picker', () => {
  const agent: AgentInfo = { id: 'fixture', name: 'Fixture', bin: 'fixture', available: true, models: [{ id: 'fixture-model', label: 'fixture-model' }] };
  const config: AppConfig = {
    mode: 'daemon', agentId: agent.id, agentModels: {}, agentCliEnv: {},
    apiKey: '', apiProtocol: 'anthropic', apiVersion: '', baseUrl: '', model: '',
    apiProviderBaseUrl: '', apiProtocolConfigs: {}, skillId: null, designSystemId: null,
    onboardingCompleted: true,
  };
  const props = {
    config, agents: [agent], daemonLive: true, variant: 'model' as const,
    onModeChange: vi.fn(), onAgentChange: vi.fn(), onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(), onApiModelChange: vi.fn(), onOpenSettings: vi.fn(),
  };
  const view = render(<InlineModelSwitcher {...props} />);
  fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
  expect(screen.getByRole('option', { name: 'fixture-model' })).toBeTruthy();
  view.rerender(<InlineModelSwitcher {...props} agents={[{ ...agent, available: false }]} />);
  expect(screen.queryByRole('option', { name: 'fixture-model' })).toBeNull();
  expect(props.onAgentModelChange).not.toHaveBeenCalled();
});
