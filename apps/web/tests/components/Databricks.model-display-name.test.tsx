// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { displayDatabricksModelName, registeredEndpointToModelOption } from '../../src/components/databricksModels';
import { effectiveAgentModelChoice } from '../../src/components/agentModelSelection';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig, ChatMessage } from '../../src/types';
import type { DatabricksRegisteredEndpoint } from '@readable-studio/contracts';

afterEach(cleanup);
vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: vi.fn() }));
vi.mock('../../src/components/DatabricksAddModelsModal', () => ({ DatabricksAddModelsModal: () => null }));
const id = `dbm_${'b'.repeat(32)}`;
const endpoint: DatabricksRegisteredEndpoint = {
  id: 'dbe_test', profileId: 'dbc_test', appModelId: id, label: 'databricks-claude-opus-5-5',
  displayName: 'system.ai.databricks-claude-opus-5-5', kind: 'uc-model-service',
  availability: 'compatible', api: 'anthropic-messages', enabled: true, evidence: 'metadata',
  capabilities: { tools: 'unknown', images: 'unknown', contextWindow: null, maxTokens: null },
};
const agents: AgentInfo[] = [{
  id: 'databricks', name: 'Databricks', bin: 'databricks', available: true,
  modelManagement: 'databricks', models: [
    { id: 'dbm_other_selection', label: 'another-model' },
    { id, label: 'databricks-claude-opus-5-5' },
  ],
}];

describe('Databricks model display identity', () => {
  it('uses a short picker label and preserves the selection id', () => {
    const option = registeredEndpointToModelOption(endpoint);
    expect(option.label).toBe('databricks-claude-opus-5-5');
    expect(option.id).toBe(id);
    expect(effectiveAgentModelChoice({ ...agents[0]!, models: [option] }, { model: id })?.model).toBe(id);
  });

  it('renders distinct picker rows and submits only the original model id', () => {
    const options = [{ ...endpoint, label: 'databricks-claude-opus-5-5 (system.ai.databricks-claude-opus-5-5)' }, {
      ...endpoint, id: 'dbe_other', appModelId: 'dbm_other',
      displayName: 'other.schema.databricks-claude-opus-5-5',
      label: 'databricks-claude-opus-5-5 (other.schema.databricks-claude-opus-5-5)',
    }].map(registeredEndpointToModelOption);
    expect(new Set(options.map(option => option.label)).size).toBe(2);
    const change = vi.fn();
    const config: AppConfig = {
      mode: 'daemon', agentId: 'databricks', agentModels: {}, agentCliEnv: {},
      apiProtocol: 'anthropic', model: '', apiProtocolConfigs: {}, apiKey: '',
      apiVersion: '', baseUrl: '', apiProviderBaseUrl: '', skillId: null,
      designSystemId: null, onboardingCompleted: true,
    };
    render(<I18nProvider initial="en"><InlineModelSwitcher config={config}
      agents={[{ ...agents[0]!, models: options }]} daemonLive variant="model"
      onAgentModelChange={change} onModeChange={vi.fn()} onAgentChange={vi.fn()}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />
    </I18nProvider>);
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    const rows = within(screen.getByTestId('inline-model-switcher-model-popover')).getAllByRole('option');
    expect(rows.map(row => row.textContent)).toEqual(options.map(option => option.label));
    fireEvent.click(rows[0]!);
    expect(change).toHaveBeenCalledWith('databricks', { model: id });
  });

  it.each(['gpt-5.6-luna', 'claude-3.5-sonnet', 'llama-3.1-70b', 'meta-llama-3.3-70b-instruct', 'vendor.model.v3.5'])(
    'does not parse model or serving-endpoint periods in %s', name => {
      const serving = { ...endpoint, kind: 'serving-endpoint' as const, displayName: name, label: name };
      expect(registeredEndpointToModelOption(serving).label).toBe(name);
      expect(displayDatabricksModelName(serving).model).toBe(name);
      expect(displayDatabricksModelName(serving).path).toBeNull();
      expect(registeredEndpointToModelOption({ ...endpoint, label: name, servedModelName: name }).label).toBe(name);
    },
  );

  it('uses the canonical UC label as the exact boundary in management lists', () => {
    expect(displayDatabricksModelName({
      ...endpoint, label: 'vendor.model.v3.5',
      displayName: 'catalog.with.dot.schema.vendor.model.v3.5',
    })).toMatchObject({ model: 'vendor.model.v3.5', path: 'catalog.with.dot.schema' });
  });

  it.each(['new', 'saved'])('resolves the %s assistant header from the current catalogue', kind => {
    const message: ChatMessage = {
      id: kind, role: 'assistant', content: 'done', agentId: 'databricks',
      agentName: `Databricks · ${id}`, runStatus: 'succeeded',
      ...(kind === 'new' ? { events: [{ kind: 'status' as const, label: 'initializing', detail: id }] } : {}),
    };
    const { container, rerender } = render(<I18nProvider initial="en">
      <AssistantMessage message={message} streaming={false} projectId="p" agents={[]} />
    </I18nProvider>);
    expect(container.querySelector('.role-model')?.textContent).toBe(id);
    rerender(<I18nProvider initial="en">
      <AssistantMessage message={message} streaming={false} projectId="p" agents={agents} />
    </I18nProvider>);
    expect(container.querySelector('.role-model')?.textContent).toBe('databricks-claude-opus-5-5');
    expect(container.querySelector('.role')?.textContent).not.toContain('dbm_');
  });

  it('resolves legacy saved aliases even when the saved message lacks agentId', () => {
    const message: ChatMessage = { id: 'legacy', role: 'assistant', content: 'done', agentName: `Databricks · ${id}` };
    const { container } = render(<I18nProvider initial="en">
      <AssistantMessage message={message} streaming={false} projectId="p" agents={agents} />
    </I18nProvider>);
    expect(container.querySelector('.role-model')?.textContent).toBe('databricks-claude-opus-5-5');
  });
});
