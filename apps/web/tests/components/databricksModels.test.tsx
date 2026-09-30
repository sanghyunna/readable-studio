// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksEndpoint, DatabricksRegisteredEndpoint } from '@readable-studio/contracts';
import { displayDatabricksModelName, registeredEndpointToModelOption } from '../../src/components/databricksModels';
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

describe('displayDatabricksModelName', () => {
  // Real scan shape: `label` is the served model, `displayName` is the UC name.
  const real: DatabricksEndpoint[] = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/databricks-real-scan.json'), 'utf8'));
  const byName = (displayName: string) => real.find((e) => e.displayName === displayName)!;

  it('splits a UC name at the first two periods: remainder is the title, catalog.schema the path', () => {
    expect(displayDatabricksModelName(byName('system.ai.gpt-oss-120b'))).toEqual({
      model: 'gpt-oss-120b', path: 'system.ai', title: 'system.ai.gpt-oss-120b', secondary: null,
    });
    expect(displayDatabricksModelName({ label: 'qwen3-next-80b-a3b-instruct', displayName: 'system.ai.qwen3-next-80b-a3b-instruct', servedModelName: 'qwen3-next-80b-a3b-instruct' })).toEqual({
      model: 'qwen3-next-80b-a3b-instruct', path: 'system.ai', title: 'system.ai.qwen3-next-80b-a3b-instruct', secondary: null,
    });
  });

  it('keeps the UC remainder as the title and demotes a differing served model to secondary', () => {
    expect(displayDatabricksModelName(byName('app_dev.default.oai-luna-model-service'))).toEqual({
      model: 'oai-luna-model-service', path: 'app_dev.default', title: 'app_dev.default.oai-luna-model-service', secondary: 'gpt-5.6-luna',
    });
    expect(displayDatabricksModelName({ label: 'claude-sonnet-4-5', displayName: 'app_dev.default.c-sonnet-model-service', servedModelName: 'claude-sonnet-4-5' })).toEqual({
      model: 'c-sonnet-model-service', path: 'app_dev.default', title: 'app_dev.default.c-sonnet-model-service', secondary: 'claude-sonnet-4-5',
    });
  });

  it('shows a name with fewer than two periods whole, with no path', () => {
    expect(displayDatabricksModelName(byName('gpt-5.6-luna'))).toEqual({
      model: 'gpt-5.6-luna', path: null, title: 'gpt-5.6-luna', secondary: null,
    });
    expect(displayDatabricksModelName(byName('corp-claude-endpoint'))).toEqual({
      model: 'corp-claude-endpoint', path: null, title: 'corp-claude-endpoint', secondary: 'claude-opus-4-1',
    });
  });
});

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
