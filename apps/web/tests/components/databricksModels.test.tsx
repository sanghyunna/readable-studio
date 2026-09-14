// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksRegisteredEndpoint } from '@readable-studio/contracts';
import { registeredEndpointToModelOption } from '../../src/components/databricksModels';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: vi.fn() }));
vi.mock('../../src/components/DatabricksAddModelsModal', () => ({ DatabricksAddModelsModal: () => null }));
afterEach(cleanup);

const endpoint: DatabricksRegisteredEndpoint = {
  id: `dbe_${'a'.repeat(32)}`, profileId: `dbc_${'b'.repeat(32)}`, appModelId: `dbm_${'c'.repeat(32)}`,
  label: 'Serving endpoint 7e5e5', displayName: 'app_dev.default.oai-luna-model-service',
  servedModelName: 'gpt-5.6-luna', kind: 'uc-model-service', api: 'openai-completions',
  enabled: true, availability: 'compatible', evidence: 'metadata',
  capabilities: { tools: 'unknown', images: 'unknown', contextWindow: null, maxTokens: null },
};
const config: AppConfig = {
  mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', apiVersion: '', baseUrl: '', model: '',
  apiProviderBaseUrl: '', apiProtocolConfigs: {}, agentId: 'databricks', skillId: null,
  designSystemId: null, onboardingCompleted: true, agentModels: {}, agentCliEnv: {},
};

describe('Databricks composer identity', () => {
  it('allows the real served model in rendered UI and uses only its opaque alias for selection/storage', () => {
    const option = registeredEndpointToModelOption(endpoint);
    const onAgentModelChange = vi.fn();
    render(<InlineModelSwitcher config={config} agents={[{
      id: 'databricks', name: 'Databricks', bin: 'databricks', available: true,
      modelManagement: 'databricks', modelSelectionRequired: true, models: [option],
    }]} daemonLive variant="model" onAgentModelChange={onAgentModelChange}
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const row = within(screen.getByTestId('inline-model-switcher-model-popover')).getByRole('option');
    expect(row.textContent).toBe(endpoint.servedModelName);
    expect(option).toMatchObject({ id: endpoint.appModelId, endpointId: endpoint.id, connectionId: endpoint.profileId });
    fireEvent.click(row);
    expect(onAgentModelChange).toHaveBeenCalledWith('databricks', { model: endpoint.appModelId });
    expect(JSON.stringify(onAgentModelChange.mock.calls)).not.toContain(endpoint.displayName);
    expect(JSON.stringify(onAgentModelChange.mock.calls)).not.toContain(endpoint.servedModelName);
  });

  it('retains the real service as secondary DTO identity and falls back to it when model metadata is absent', () => {
    expect(registeredEndpointToModelOption(endpoint).label).toBe(endpoint.servedModelName);
    expect(endpoint.displayName).toBe('app_dev.default.oai-luna-model-service');
    const { servedModelName: _model, ...withoutModel } = endpoint;
    expect(registeredEndpointToModelOption(withoutModel).label).toBe(endpoint.displayName);
    const { displayName: _service, ...legacy } = withoutModel;
    expect(registeredEndpointToModelOption(legacy).label).toBe(endpoint.label);
  });
});
