// @vitest-environment jsdom

/**
 * Settings > Databricks models: lists registrations from the daemon, removes a
 * model only after inline confirmation, keeps the row and shows the error when
 * the daemon refuses, disconnects a whole workspace the same way, and shows an
 * empty state when nothing is registered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DatabricksProfile,
  DatabricksRegisteredEndpoint,
  DatabricksStatusResponse,
} from '@readable-studio/contracts';
import { DatabricksModelsSection } from '../../src/components/DatabricksModelsSection';
import { DATABRICKS_MODELS_CHANGED_EVENT } from '../../src/components/databricksModels';
import { I18nProvider } from '../../src/i18n';

const databricksClient = vi.hoisted(() => ({
  fetchDatabricksStatus: vi.fn(),
  fetchDatabricksModels: vi.fn(),
  disableDatabricksModel: vi.fn(),
  disconnectDatabricksConnection: vi.fn(),
}));

vi.mock('../../src/providers/databricks', () => databricksClient);

const profile: DatabricksProfile = {
  id: 'prof-main',
  label: 'main',
  workspaceLabel: 'workspace.example',
  workspaceDisplayLabel: 'acme.cloud.databricks.com',
  isDefault: true,
  auth: 'authenticated',
};

const status: DatabricksStatusResponse = {
  cli: 'ready',
  version: '0.240.0',
  auth: 'authenticated',
  profiles: [profile],
  enabledCount: 2,
  issues: [],
};

function registered(id: string, name: string): DatabricksRegisteredEndpoint {
  return {
    id,
    profileId: profile.id,
    label: name,
    displayName: `catalog.schema.${name}`,
    servedModelName: name,
    kind: 'uc-model-service',
    availability: 'compatible',
    api: 'openai-completions',
    enabled: true,
    appModelId: `databricks:${id}`,
    capabilities: {
      tools: 'supported',
      images: 'unknown',
      contextWindow: 128000,
      maxTokens: 8192,
      limitSources: { contextWindow: 'metadata', maxTokens: 'model-table' },
    },
    evidence: 'metadata',
  };
}

const alpha = registered('ep-alpha', 'alpha-70b');
const beta = registered('ep-beta', 'beta-8b');

function renderSection() {
  return render(
    <I18nProvider initial="en">
      <DatabricksModelsSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  databricksClient.fetchDatabricksStatus.mockResolvedValue(status);
  databricksClient.fetchDatabricksModels.mockResolvedValue({
    models: [alpha, beta],
    revision: 7,
    issues: [],
  });
  databricksClient.disableDatabricksModel.mockReset();
  databricksClient.disconnectDatabricksConnection.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DatabricksModelsSection', () => {
  it('lists registered models under their workspace with limits as secondary detail', async () => {
    renderSection();
    const rows = await screen.findAllByTestId('databricks-model-row');
    expect(rows).toHaveLength(2);
    const group = screen.getByTestId('databricks-workspace-group');
    expect(within(group).getByText(profile.workspaceDisplayLabel!)).toBeTruthy();
    const first = rows[0]!;
    expect(within(first).getByText('alpha-70b').tagName).toBe('STRONG');
    expect(within(first).getByText('catalog.schema.alpha-70b').tagName).toBe('CODE');
    // Limits never leak into the title.
    expect(within(first).getByText('alpha-70b').textContent).not.toMatch(/128/);
    expect(within(first).getByText(/128,000/).tagName).toBe('SMALL');
  });

  it('removes a model only after confirmation and republishes the catalogue', async () => {
    databricksClient.disableDatabricksModel.mockResolvedValue({
      models: [beta],
      revision: 8,
      issues: [],
    });
    const published: unknown[] = [];
    const onChanged = (event: Event) => published.push((event as CustomEvent).detail);
    window.addEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
    try {
      renderSection();
      const rows = await screen.findAllByTestId('databricks-model-row');
      fireEvent.click(within(rows[0]!).getByTestId('databricks-remove'));
      expect(databricksClient.disableDatabricksModel).not.toHaveBeenCalled();
      fireEvent.click(within(rows[0]!).getByTestId('databricks-remove-confirm'));
      await waitFor(() => expect(screen.getAllByTestId('databricks-model-row')).toHaveLength(1));
      expect(databricksClient.disableDatabricksModel).toHaveBeenCalledTimes(1);
      expect(databricksClient.disableDatabricksModel).toHaveBeenCalledWith('ep-alpha', {
        expectedRevision: 7,
      });
      expect(published).toHaveLength(1);
      expect((published[0] as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual([
        'databricks:ep-beta',
      ]);
    } finally {
      window.removeEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
    }
  });

  it('does not call DELETE when the confirmation is cancelled', async () => {
    renderSection();
    const rows = await screen.findAllByTestId('databricks-model-row');
    fireEvent.click(within(rows[0]!).getByTestId('databricks-remove'));
    fireEvent.click(within(rows[0]!).getByTestId('databricks-remove-cancel'));
    expect(databricksClient.disableDatabricksModel).not.toHaveBeenCalled();
    expect(within(rows[0]!).getByTestId('databricks-remove')).toBeTruthy();
    expect(screen.getAllByTestId('databricks-model-row')).toHaveLength(2);
  });

  it('keeps the row and surfaces the error when removal fails', async () => {
    databricksClient.disableDatabricksModel.mockRejectedValue(new Error('DATABRICKS_STALE_REVISION'));
    renderSection();
    const rows = await screen.findAllByTestId('databricks-model-row');
    fireEvent.click(within(rows[0]!).getByTestId('databricks-remove'));
    fireEvent.click(within(rows[0]!).getByTestId('databricks-remove-confirm'));
    const alert = await within(rows[0]!).findByRole('alert');
    expect(alert.textContent).toContain('DATABRICKS_STALE_REVISION');
    expect(screen.getAllByTestId('databricks-model-row')).toHaveLength(2);
  });

  it('disconnects a workspace only after confirmation and refreshes the list', async () => {
    databricksClient.disconnectDatabricksConnection.mockResolvedValue({ ...status, profiles: [] });
    databricksClient.fetchDatabricksModels
      .mockResolvedValueOnce({ models: [alpha, beta], revision: 7, issues: [] })
      .mockResolvedValueOnce({ models: [], revision: 9, issues: [] });
    renderSection();
    await screen.findAllByTestId('databricks-model-row');
    fireEvent.click(screen.getByTestId('databricks-disconnect'));
    expect(databricksClient.disconnectDatabricksConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('databricks-disconnect-confirm'));
    await screen.findByTestId('databricks-models-empty');
    expect(databricksClient.disconnectDatabricksConnection).toHaveBeenCalledWith('prof-main');
    expect(screen.queryAllByTestId('databricks-model-row')).toHaveLength(0);
  });

  it('renders the empty state when nothing is registered', async () => {
    databricksClient.fetchDatabricksModels.mockResolvedValue({ models: [], revision: 0, issues: [] });
    renderSection();
    await screen.findByTestId('databricks-models-empty');
    expect(screen.queryAllByTestId('databricks-model-row')).toHaveLength(0);
  });
});
