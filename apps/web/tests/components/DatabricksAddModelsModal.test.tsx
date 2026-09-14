// @vitest-environment jsdom

/**
 * Databricks Add Models registration modal.
 *
 * The modal picks an authenticated CLI profile, scans the workspace with
 * incremental progress, and registers discovered endpoints. Registration and
 * selection stay separate: the modal publishes the catalogue and never touches
 * the active model. A partial scan is surfaced honestly, and a missing or
 * unauthenticated CLI shows a guided state instead of the scan UI.
 *
 * When the daemon reports `setupRequired`, the modal opens on a setup step
 * (workspace URL + personal access token) and a successful submit drops
 * straight into scanning; the credential never survives the submit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DatabricksEndpoint,
  DatabricksProfile,
  DatabricksRegisteredEndpoint,
  DatabricksScanResponse,
  DatabricksSetupResponse,
  DatabricksStatusResponse,
} from '@readable-studio/contracts';
import { DatabricksAddModelsModal } from '../../src/components/DatabricksAddModelsModal';
import {
  DATABRICKS_MODELS_CHANGED_EVENT,
  databricksModelsFromEvent,
} from '../../src/components/databricksModels';

vi.mock('../../src/providers/registry', () => ({
  openExternalUrl: vi.fn(async () => true),
}));

const databricksClient = vi.hoisted(() => ({
  fetchDatabricksStatus: vi.fn(),
  probeDatabricks: vi.fn(),
  startDatabricksScan: vi.fn(),
  fetchDatabricksScan: vi.fn(),
  cancelDatabricksScan: vi.fn(),
  lookupDatabricksEndpoint: vi.fn(),
  fetchDatabricksModels: vi.fn(),
  enableDatabricksModel: vi.fn(),
  disableDatabricksModel: vi.fn(),
  streamDatabricksScanEvents: vi.fn(),
  setupDatabricks: vi.fn(),
}));

vi.mock('../../src/providers/databricks', () => databricksClient);

const profile: DatabricksProfile = {
  id: 'prof-main',
  label: 'main',
  workspaceLabel: 'workspace.example',
  isDefault: true,
  auth: 'authenticated',
};

const readyStatus: DatabricksStatusResponse = {
  cli: 'ready',
  version: '0.276.0',
  auth: 'authenticated',
  profiles: [profile],
  enabledCount: 0,
  issues: [],
};

/** First run: no CLI on the machine, nothing saved, so the daemon asks for setup. */
const setupRequiredStatus: DatabricksStatusResponse = {
  ...readyStatus,
  cli: 'missing',
  version: null,
  auth: 'unchecked',
  profiles: [],
  setupRequired: true,
};

/** The saved workspace connection the daemon surfaces as a scannable profile. */
const connectionProfile: DatabricksProfile = {
  id: 'conn-1',
  label: 'workspace.example',
  workspaceLabel: 'workspace.example',
  isDefault: true,
  auth: 'authenticated',
};

const setupResponse: DatabricksSetupResponse = {
  profile: connectionProfile,
  status: {
    ...setupRequiredStatus,
    auth: 'authenticated',
    profiles: [connectionProfile],
    setupRequired: false,
  },
};

// Deliberately not shaped like a real Databricks PAT.
const TEST_TOKEN = 'test-token-not-a-real-credential';

function hostInput(): HTMLInputElement {
  return screen.getByTestId('databricks-setup-host') as HTMLInputElement;
}

function tokenInput(): HTMLInputElement {
  return screen.getByTestId('databricks-setup-token') as HTMLInputElement;
}

/** Types both fields and submits; queries per step because the motion mock remounts on every render. */
function fillAndSubmitSetup(host: string, token: string) {
  fireEvent.change(hostInput(), { target: { value: host } });
  fireEvent.change(tokenInput(), { target: { value: token } });
  fireEvent.click(screen.getByTestId('databricks-setup-submit'));
}

function endpoint(overrides: Partial<DatabricksEndpoint> = {}): DatabricksEndpoint {
  return {
    id: 'ep-luna',
    profileId: 'prof-main',
    label: 'oai-luna-model-service',
    kind: 'uc-model-service',
    availability: 'compatible',
    api: 'openai-completions',
    enabled: false,
    capabilities: {
      tools: 'supported',
      images: 'unknown',
      contextWindow: 128000,
      maxTokens: null,
    },
    evidence: 'metadata',
    ...overrides,
  };
}

function registeredEndpoint(
  overrides: Partial<DatabricksRegisteredEndpoint> = {},
): DatabricksRegisteredEndpoint {
  return {
    ...endpoint(),
    enabled: true,
    appModelId: 'dbx-luna',
    ...overrides,
  };
}

function scanResponse(overrides: Partial<DatabricksScanResponse> = {}): DatabricksScanResponse {
  return {
    scanId: 'scan-1',
    profileId: 'prof-main',
    revision: 1,
    state: 'running',
    createdAt: '2026-09-10T04:00:00.000Z',
    startedAt: '2026-09-10T04:00:01.000Z',
    completedAt: null,
    endpoints: [],
    cursor: null,
    counters: { scopesChecked: 0, scopesInaccessible: 0, candidates: 0, excluded: 0 },
    completeness: { serving: false, uc: false, truncated: false },
    issues: [],
    ...overrides,
  };
}

function renderModal(props: Partial<Parameters<typeof DatabricksAddModelsModal>[0]> = {}) {
  return render(
    <DatabricksAddModelsModal open={true} onClose={vi.fn()} {...props} />,
  );
}

function ComposerModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="databricks-modal-composer"
      style={{ overflow: 'hidden', backdropFilter: 'blur(22px)' }}
    >
      <button type="button" data-testid="databricks-add-models-trigger" onClick={() => setOpen(true)}>
        Add Models
      </button>
      <DatabricksAddModelsModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function clippingAncestors(node: HTMLElement): string[] {
  const ancestors: string[] = [];
  let current = node.parentElement;
  while (current && current !== document.body) {
    const { backdropFilter, filter, overflow, overflowX, overflowY } = current.style;
    if (
      backdropFilter ||
      filter ||
      overflow === 'hidden' ||
      overflow === 'clip' ||
      overflowX === 'hidden' ||
      overflowY === 'hidden'
    ) {
      ancestors.push(current.dataset.testid ?? current.tagName.toLowerCase());
    }
    current = current.parentElement;
  }
  return ancestors;
}

async function waitForProfiles() {
  await waitFor(() =>
    expect(screen.getByTestId('databricks-profile-prof-main')).toBeTruthy(),
  );
}

beforeEach(() => {
  databricksClient.fetchDatabricksStatus.mockResolvedValue(readyStatus);
  databricksClient.fetchDatabricksModels.mockResolvedValue({
    models: [],
    revision: 0,
    issues: [],
  });
  databricksClient.probeDatabricks.mockResolvedValue({ profiles: [profile], issues: [] });
  databricksClient.startDatabricksScan.mockResolvedValue(scanResponse());
  databricksClient.streamDatabricksScanEvents.mockResolvedValue(true);
  databricksClient.fetchDatabricksScan.mockResolvedValue(
    scanResponse({ state: 'complete', completedAt: '2026-09-10T04:00:05.000Z' }),
  );
  databricksClient.cancelDatabricksScan.mockResolvedValue(undefined);
  databricksClient.enableDatabricksModel.mockResolvedValue({
    endpoint: registeredEndpoint(),
    appModelId: 'dbx-luna',
    revision: 2,
  });
  databricksClient.disableDatabricksModel.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DatabricksAddModelsModal', () => {
  it.each([
    { contextWindow: 131_072, maxTokens: 128_000 },
    { contextWindow: null, maxTokens: null },
    { contextWindow: 200_000, maxTokens: null },
  ])('renders structured limits outside the identity: %j', async (limits) => {
    const model = registeredEndpoint({
      label: 'system.ai.gpt-oss-120b',
      capabilities: { tools: 'unknown', images: 'unknown', ...limits },
    });
    databricksClient.fetchDatabricksModels.mockResolvedValue({ models: [model], revision: 1, issues: [] });
    await act(async () => { renderModal(); });

    const row = screen.getByTestId(`databricks-endpoint-${model.id}`);
    const title = within(row).getByTitle(model.label);
    expect(title.textContent).toBe(model.label);
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const detail = row.querySelector(`[data-limit="${field}"]`)!;
      expect(detail).not.toBeNull();
      expect(title.contains(detail)).toBe(false);
      expect(detail.parentElement).not.toBe(title.parentElement);
      expect(detail.getAttribute('data-limit-state')).toBe(limits[field] === null ? 'unknown' : 'known');
      if (limits[field] === null) expect(detail.textContent).toMatch(/unknown/i);
      else expect(Number(detail.textContent!.replace(/\D/g, ''))).toBe(limits[field]);
    }
    expect(within(row).getByTestId(`databricks-endpoint-toggle-${model.id}`)).toBeTruthy();
    expect(databricksClient.enableDatabricksModel).not.toHaveBeenCalled();
  });

  it('discovers profiles when ready status has none and selects the discovered default', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      auth: 'unchecked',
      profiles: [],
    });

    renderModal();

    await waitForProfiles();
    expect(databricksClient.probeDatabricks).toHaveBeenCalledTimes(1);
    expect(databricksClient.probeDatabricks).toHaveBeenCalledWith();
    expect(screen.getByTestId('databricks-scan-start').hasAttribute('disabled')).toBe(false);
  });

  it('coalesces initial discovery under StrictMode', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      auth: 'unchecked',
      profiles: [],
    });

    render(
      <StrictMode>
        <DatabricksAddModelsModal open={true} onClose={vi.fn()} />
      </StrictMode>,
    );

    await waitForProfiles();
    expect(databricksClient.probeDatabricks).toHaveBeenCalledTimes(1);
  });

  it('retries failed profile discovery through Check again', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      auth: 'unchecked',
      profiles: [],
    });
    databricksClient.probeDatabricks
      .mockRejectedValueOnce(new Error('Could not discover profiles'))
      .mockResolvedValueOnce({ profiles: [profile], issues: [] });

    renderModal();

    const guided = await screen.findByTestId('databricks-guided-state');
    expect(guided.textContent).toContain('Could not discover profiles');

    fireEvent.click(screen.getByTestId('databricks-check-again'));

    await waitForProfiles();
    expect(databricksClient.probeDatabricks).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('databricks-guided-state')).toBeNull();
  });

  it('does not discover profiles again when status already provides them', async () => {
    renderModal();

    await waitForProfiles();
    expect(databricksClient.probeDatabricks).not.toHaveBeenCalled();
  });

  it('surfaces a partial scan honestly and offers a rescan', async () => {
    const partialScan = scanResponse({
      state: 'partial',
      completedAt: '2026-09-10T04:00:05.000Z',
      endpoints: [endpoint()],
      counters: { scopesChecked: 4, scopesInaccessible: 2, candidates: 1, excluded: 0 },
      completeness: { serving: true, uc: false, truncated: false },
      issues: [{ code: 'DATABRICKS_PERMISSION_DENIED', action: 'check-permissions', retryable: true }],
    });
    databricksClient.startDatabricksScan.mockResolvedValue(partialScan);
    databricksClient.streamDatabricksScanEvents.mockImplementation(
      async (_scanId: string, handlers: { onEvent: (event: unknown) => void }) => {
        handlers.onEvent({ type: 'done', revision: 2, scan: partialScan });
        return true;
      },
    );

    renderModal();
    await waitForProfiles();
    fireEvent.click(screen.getByTestId('databricks-scan-start'));

    const warning = await screen.findByTestId('databricks-scan-partial');
    expect(warning.textContent).toContain('Partial scan');
    expect(warning.textContent).toContain('2 of 4 scopes could not be read');
    expect(warning.textContent).toContain('Check workspace permissions.');
    // The discovered endpoint still shows up for registration.
    expect(screen.getByTestId('databricks-endpoint-ep-luna')).toBeTruthy();
    // Rescanning is offered from the same surface.
    const rescan = screen.getByTestId('databricks-scan-start');
    expect(rescan.textContent).toContain('Rescan');
    fireEvent.click(rescan);
    await waitFor(() =>
      expect(databricksClient.startDatabricksScan).toHaveBeenCalledTimes(2),
    );
  });

  it('shows the guided state when the CLI is missing', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      cli: 'missing',
      auth: 'unchecked',
      profiles: [],
      issues: [{ code: 'DATABRICKS_CLI_MISSING', action: 'install-cli', retryable: false }],
    });

    renderModal({ installUrl: 'https://docs.databricks.com/en/dev-tools/cli/install.html' });

    const guided = await screen.findByTestId('databricks-guided-state');
    expect(guided.textContent).toContain('Databricks CLI not found');
    expect(guided.textContent).toContain('Install the Databricks CLI.');
    expect(within(guided).getByText('Install CLI')).toBeTruthy();
    // No scan affordance while the CLI is missing.
    expect(screen.queryByTestId('databricks-scan-start')).toBeNull();
  });

  it('shows the sign-in guidance when no profile is authenticated', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      auth: 'auth-required',
      profiles: [{ ...profile, auth: 'auth-required' }],
    });

    renderModal();

    const guided = await screen.findByTestId('databricks-guided-state');
    expect(guided.textContent).toContain('Sign in to Databricks');
    expect(guided.textContent).toContain('databricks auth login');
    expect(screen.queryByTestId('databricks-scan-start')).toBeNull();
  });

  it('recovers from the guided state through Check again', async () => {
    databricksClient.fetchDatabricksStatus
      .mockResolvedValueOnce({
        ...readyStatus,
        cli: 'missing',
        auth: 'unchecked',
        profiles: [],
      })
      .mockResolvedValueOnce(readyStatus);

    renderModal();
    await screen.findByTestId('databricks-guided-state');

    fireEvent.click(screen.getByTestId('databricks-check-again'));

    await waitForProfiles();
    expect(screen.queryByTestId('databricks-guided-state')).toBeNull();
    expect(databricksClient.fetchDatabricksStatus).toHaveBeenCalledTimes(2);
  });

  it('registers a discovered model without changing the active selection', async () => {
    const events: CustomEvent[] = [];
    const onChanged = (event: Event) => {
      if (event instanceof CustomEvent) events.push(event);
    };
    window.addEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
    try {
      const running = scanResponse();
      const done = scanResponse({
        state: 'complete',
        completedAt: '2026-09-10T04:00:05.000Z',
        endpoints: [endpoint()],
        counters: { scopesChecked: 2, scopesInaccessible: 0, candidates: 1, excluded: 0 },
        completeness: { serving: true, uc: true, truncated: false },
      });
      databricksClient.startDatabricksScan.mockResolvedValue(running);
      databricksClient.streamDatabricksScanEvents.mockImplementation(
        async (_scanId: string, handlers: { onEvent: (event: unknown) => void }) => {
          handlers.onEvent({
            type: 'progress',
            scanId: 'scan-1',
            revision: 2,
            state: 'running',
            counters: { scopesChecked: 1, scopesInaccessible: 0, candidates: 0, excluded: 0 },
            completeness: { serving: true, uc: false, truncated: false },
            issues: [],
          });
          handlers.onEvent({ type: 'endpoint', scanId: 'scan-1', revision: 3, endpoint: endpoint() });
          handlers.onEvent({ type: 'done', revision: 4, scan: done });
          return true;
        },
      );
      databricksClient.fetchDatabricksModels
        .mockResolvedValueOnce({ models: [], revision: 0, issues: [] })
        .mockResolvedValueOnce({ models: [registeredEndpoint()], revision: 1, issues: [] });

      renderModal();
      await waitForProfiles();
      fireEvent.click(screen.getByTestId('databricks-scan-start'));

      await screen.findByTestId('databricks-endpoint-toggle-ep-luna');
      // Incremental progress was rendered while the scan ran.
      expect(screen.getByTestId('databricks-scan-progress').textContent).toContain('Scan complete');
      expect(screen.getByTestId('databricks-scan-progress').textContent).toContain('2 scopes checked · 1 found');

      // Query the toggle at click time: the motion mock re-creates its element
      // types per render, so the scan-settled re-render replaced the node the
      // findBy above resolved with.
      fireEvent.click(screen.getByTestId('databricks-endpoint-toggle-ep-luna'));

      await waitFor(() =>
        expect(databricksClient.enableDatabricksModel).toHaveBeenCalledWith('ep-luna', {
          scanId: 'scan-1',
          expectedRevision: 4,
        }),
      );
      await waitFor(() => expect(events).toHaveLength(1));
      const models = databricksModelsFromEvent(events[0]!);
      expect(models).toEqual([
        expect.objectContaining({
          id: 'dbx-luna',
          label: 'oai-luna-model-service',
          source: 'databricks',
          endpointId: 'ep-luna',
        }),
      ]);
      await waitFor(() =>
        expect(screen.getByTestId('databricks-registered-count').textContent).toBe('1 registered'),
      );
      // The modal has no selection callback at all: registration cannot pick a model.
    } finally {
      window.removeEventListener(DATABRICKS_MODELS_CHANGED_EVENT, onChanged);
    }
  });

  it('blocks scanning until a signed-in profile is selected', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({
      ...readyStatus,
      profiles: [
        { ...profile, id: 'prof-out', label: 'signed-out', isDefault: false, auth: 'auth-required' },
        profile,
      ],
    });

    renderModal();
    await waitForProfiles();

    // The default-signed-in profile is preselected, so scanning is allowed.
    const start = screen.getByTestId('databricks-scan-start');
    expect(start.hasAttribute('disabled')).toBe(false);

    // Switching to the signed-out profile disables the scan action.
    fireEvent.click(screen.getByTestId('databricks-profile-prof-out'));
    expect(screen.getByTestId('databricks-scan-start').hasAttribute('disabled')).toBe(true);
  });

  it('ports the modal above a clipping composer so its centered title remains a dialog hit target', () => {
    render(<ComposerModalHarness />);
    const composer = screen.getByTestId('databricks-modal-composer');
    const trigger = screen.getByTestId('databricks-add-models-trigger');
    trigger.focus();
    fireEvent.click(trigger);

    const backdrop = screen.getByTestId('databricks-add-models-modal-backdrop');
    const dialog = screen.getByRole('dialog');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');

    expect(backdrop.parentElement).toBe(document.body);
    expect(composer.contains(backdrop)).toBe(false);
    expect(clippingAncestors(backdrop)).toEqual([]);
    expect(title).not.toBeNull();
    expect(dialog.contains(title)).toBe(true);
  });

  it('traps focus and restores the Add Models trigger after Escape and backdrop dismissal', async () => {
    render(<ComposerModalHarness />);
    const trigger = screen.getByTestId('databricks-add-models-trigger');
    trigger.focus();
    fireEvent.click(trigger);

    // Opening always starts in the dialog. Wait for the status update before
    // exercising the boundaries because the motion test double replaces nodes
    // when async modal content resolves.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    await waitForProfiles();
    const close = screen.getByRole('button', { name: 'Close' });
    const done = screen.getByTestId('databricks-add-models-done');
    done.focus();

    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const backdrop = screen.getByTestId('databricks-add-models-modal-backdrop');
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('cancels a running scan when the modal closes', async () => {
    let releaseStream: (() => void) | null = null;
    databricksClient.streamDatabricksScanEvents.mockImplementation(
      (_scanId: string, _handlers: unknown, options: { signal?: AbortSignal }) =>
        new Promise<boolean>((resolve) => {
          releaseStream = () => resolve(false);
          options.signal?.addEventListener('abort', () => resolve(false));
        }),
    );

    const onClose = vi.fn();
    renderModal({ onClose });
    await waitForProfiles();
    fireEvent.click(screen.getByTestId('databricks-scan-start'));
    await waitFor(() =>
      expect(databricksClient.startDatabricksScan).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByTestId('databricks-add-models-done'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Unmounting (what the host does after onClose) cancels the daemon scan.
    cleanup();
    await waitFor(() =>
      expect(databricksClient.cancelDatabricksScan).toHaveBeenCalledWith('scan-1'),
    );
    await act(async () => releaseStream?.());
  });
});

describe('DatabricksAddModelsModal setup step', () => {
  beforeEach(() => {
    databricksClient.setupDatabricks.mockResolvedValue(setupResponse);
  });

  it('opens on the setup step instead of a dead end when status reports setup is required', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);

    renderModal({ installUrl: 'https://docs.databricks.com/en/dev-tools/cli/install.html' });

    const step = await screen.findByTestId('databricks-setup-step');
    expect(screen.queryByTestId('databricks-guided-state')).toBeNull();
    expect(screen.queryByTestId('databricks-scan-start')).toBeNull();
    // URL field, credential field, a clear submit, and what the token is for.
    expect(hostInput().type).toBe('url');
    expect(tokenInput().type).toBe('password');
    expect(tokenInput().getAttribute('autocomplete')).toBe('off');
    expect(step.textContent).toContain('Workspace URL');
    expect(step.textContent).toContain('Personal access token');
    expect(step.textContent).toContain(
      'Used only to authenticate this computer against the workspace.',
    );
    expect(screen.getByTestId('databricks-setup-submit').textContent).toContain('Connect and scan');
    expect(screen.getByTestId('databricks-setup-submit').hasAttribute('disabled')).toBe(true);
    // Nothing to go back to: there is no profile step yet.
    expect(screen.queryByTestId('databricks-setup-back')).toBeNull();
    // A missing CLI is not a dead end, but the CLI route stays visible.
    expect(within(step).getByText('Install CLI')).toBeTruthy();
    // No probe on a machine without the CLI.
    expect(databricksClient.probeDatabricks).not.toHaveBeenCalled();
  });

  it('connects and starts scanning without a second action after a successful setup', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);
    // The response profile, not the first/default status profile, owns the scan.
    const connected = { ...connectionProfile, isDefault: false };
    databricksClient.setupDatabricks.mockResolvedValueOnce({
      profile: connected,
      status: { ...setupResponse.status, profiles: [profile, connected] },
    } satisfies DatabricksSetupResponse);

    await act(async () => { renderModal(); });
    expect(screen.getByTestId('databricks-setup-step')).toBeTruthy();

    // A bare hostname is accepted and normalised to the https origin.
    await act(async () => { fillAndSubmitSetup('workspace.example', TEST_TOKEN); });

    expect(databricksClient.setupDatabricks).toHaveBeenCalledExactlyOnceWith({
      mode: 'workspace-token',
      host: 'https://workspace.example',
      token: TEST_TOKEN,
    });
    expect(databricksClient.startDatabricksScan).toHaveBeenCalledExactlyOnceWith({ profileId: connected.id });
    expect(screen.getByTestId('databricks-scan-progress')).toBeTruthy();
    expect(screen.queryByTestId('databricks-setup-step')).toBeNull();
    expect(screen.queryByTestId('databricks-scan-error')).toBeNull();
    expect(screen.getByTestId(`databricks-profile-${connected.id}`).getAttribute('aria-checked')).toBe('true');
    expect(document.body.innerHTML).not.toContain(TEST_TOKEN);
  });

  it('shows the typed error and keeps the host after a rejected credential', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);
    databricksClient.setupDatabricks.mockRejectedValue(
      Object.assign(new Error('Databricks rejected this token.'), {
        name: 'DatabricksApiError',
        status: 401,
        code: 'DATABRICKS_AUTH_REQUIRED',
        retryable: false,
      }),
    );

    renderModal();
    await screen.findByTestId('databricks-setup-step');
    fillAndSubmitSetup('https://workspace.example', TEST_TOKEN);

    const error = await screen.findByTestId('databricks-setup-error');
    expect(error.textContent).toContain('Could not connect to the workspace.');
    expect(error.textContent).toContain('Databricks rejected this token.');
    // The credential is gone and the UI says so; the host survives for a quick fix.
    expect(error.textContent).toContain('Re-enter the token to try again.');
    expect(hostInput().value).toBe('https://workspace.example');
    expect(tokenInput().value).toBe('');
    expect(screen.getByTestId('databricks-setup-submit').hasAttribute('disabled')).toBe(true);
    expect(databricksClient.startDatabricksScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('databricks-setup-step')).toBeTruthy();

    // Re-entering the token re-arms the submit action.
    fireEvent.change(tokenInput(), { target: { value: 'second-attempt-not-a-real-credential' } });
    expect(screen.getByTestId('databricks-setup-submit').hasAttribute('disabled')).toBe(false);
  });

  it('removes the token from the DOM the moment it is submitted', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);
    let settle: ((response: DatabricksSetupResponse) => void) | null = null;
    databricksClient.setupDatabricks.mockImplementation(
      () =>
        new Promise<DatabricksSetupResponse>((resolve) => {
          settle = resolve;
        }),
    );

    renderModal();
    await screen.findByTestId('databricks-setup-step');
    fillAndSubmitSetup('https://workspace.example', TEST_TOKEN);

    await waitFor(() => expect(databricksClient.setupDatabricks).toHaveBeenCalledTimes(1));
    // The request is in flight: the credential is in its body and nowhere else.
    expect(tokenInput().value).toBe('');
    expect(document.body.innerHTML).not.toContain(TEST_TOKEN);
    expect(
      Array.from(document.querySelectorAll('input')).some((input) => input.value.includes(TEST_TOKEN)),
    ).toBe(false);
    expect(screen.getByTestId('databricks-setup-submit').textContent).toContain('Connecting');

    await act(async () => settle?.(setupResponse));
    await waitFor(() => expect(screen.queryByTestId('databricks-setup-step')).toBeNull());
    expect(document.body.innerHTML).not.toContain(TEST_TOKEN);
  });

  it('does not start a scan when the modal closed while setup was in flight', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);
    let settle: ((response: DatabricksSetupResponse) => void) | null = null;
    databricksClient.setupDatabricks.mockImplementation(
      () =>
        new Promise<DatabricksSetupResponse>((resolve) => {
          settle = resolve;
        }),
    );

    renderModal();
    await screen.findByTestId('databricks-setup-step');
    fillAndSubmitSetup('https://workspace.example', TEST_TOKEN);
    await waitFor(() => expect(databricksClient.setupDatabricks).toHaveBeenCalledTimes(1));

    // The host unmounts the modal after onClose; the late response must not
    // start a daemon scan that nothing can cancel any more.
    cleanup();
    await act(async () => settle?.(setupResponse));
    expect(databricksClient.startDatabricksScan).not.toHaveBeenCalled();
  });

  it('rejects a non-https workspace address before calling the daemon', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue(setupRequiredStatus);

    renderModal();
    await screen.findByTestId('databricks-setup-step');
    fillAndSubmitSetup('http://insecure.example', TEST_TOKEN);

    expect(await screen.findByText('Enter the full https:// workspace URL.')).toBeTruthy();
    expect(databricksClient.setupDatabricks).not.toHaveBeenCalled();
    // A local validation miss keeps both fields: nothing was submitted.
    expect(hostInput().value).toBe('http://insecure.example');
    expect(tokenInput().value).toBe(TEST_TOKEN);
  });

  it('still opens on the profile step when authenticated profiles exist and reaches the form deliberately', async () => {
    databricksClient.fetchDatabricksStatus.mockResolvedValue({ ...readyStatus, setupRequired: false });

    renderModal();
    await waitForProfiles();
    expect(screen.queryByTestId('databricks-setup-step')).toBeNull();

    // A different workspace is one quiet action away, and the way back is explicit.
    fireEvent.click(screen.getByTestId('databricks-setup-open'));
    expect(screen.getByTestId('databricks-setup-step')).toBeTruthy();
    expect(screen.queryByTestId('databricks-profile-prof-main')).toBeNull();
    fireEvent.click(screen.getByTestId('databricks-setup-back'));
    expect(screen.getByTestId('databricks-profile-prof-main')).toBeTruthy();
    expect(screen.queryByTestId('databricks-setup-step')).toBeNull();
    expect(databricksClient.setupDatabricks).not.toHaveBeenCalled();
  });

  it('leaves the setup step through Check again once a signed-in CLI profile appears', async () => {
    databricksClient.fetchDatabricksStatus
      .mockResolvedValueOnce(setupRequiredStatus)
      .mockResolvedValueOnce({ ...readyStatus, setupRequired: false });

    renderModal();
    await screen.findByTestId('databricks-setup-step');

    fireEvent.click(screen.getByTestId('databricks-check-again'));

    await waitForProfiles();
    expect(screen.queryByTestId('databricks-setup-step')).toBeNull();
    expect(databricksClient.setupDatabricks).not.toHaveBeenCalled();
  });

  describe('profile row', () => {
    const LONG_WORKSPACE =
      'https://dbc-48383de7-db32-with-a-very-long-deployment-name-that-keeps-going.cloud.databricks.com';

    const profileCss = readFileSync(
      resolve(process.cwd(), 'src/components/DatabricksAddModelsModal.module.css'),
      'utf8',
    );

    function declarations(selector: string): string {
      const match = profileCss.match(
        new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`),
      );
      if (!match?.[1]) throw new Error(`missing ${selector} rule`);
      return match[1];
    }

    it('renders the sign-in state and the workspace URL as separate boxes on separate lines', async () => {
      databricksClient.fetchDatabricksStatus.mockResolvedValue({
        ...readyStatus,
        profiles: [{ ...profile, workspaceLabel: LONG_WORKSPACE }],
      });
      renderModal();
      await waitForProfiles();

      const card = screen.getByTestId('databricks-profile-prof-main');
      const auth = screen.getByTestId('databricks-profile-auth-prof-main');
      const workspace = screen.getByTestId('databricks-profile-workspace-prof-main');

      expect(auth).not.toBe(workspace);
      expect(auth.contains(workspace)).toBe(false);
      expect(workspace.contains(auth)).toBe(false);
      // Different lines: the status lives on the primary line, the URL is a
      // direct child of the card underneath it.
      expect(auth.parentElement).not.toBe(workspace.parentElement);
      expect(workspace.parentElement).toBe(card);
      expect(auth.parentElement?.parentElement).toBe(card);
      expect(workspace.textContent).toBe(LONG_WORKSPACE);
      expect(auth.textContent).not.toContain(LONG_WORKSPACE);

      // Real spacing: the card stacks its lines with a gap and the URL is the
      // element that truncates, so a long URL cannot displace the status.
      const cardRule = declarations('.profileCard');
      expect(cardRule).toMatch(/flex-direction:\s*column/);
      expect(cardRule).toMatch(/\bgap:\s*var\(--dbx-tight\)/);
      expect(cardRule).toMatch(/text-align:\s*start/);
      expect(declarations('.profilePrimary')).toMatch(/\bgap:\s*6px/);
      const workspaceRule = declarations('.profileWorkspace');
      expect(workspaceRule).toMatch(/text-overflow:\s*ellipsis/);
      expect(workspaceRule).toMatch(/min-width:\s*0/);
      const authRule = declarations('.profileAuth');
      expect(authRule).toMatch(/flex:\s*none/);
      expect(authRule).toMatch(/margin-inline-start:\s*auto/);
    });

    it('marks signed-in and signed-out profiles with distinct status tones', async () => {
      databricksClient.fetchDatabricksStatus.mockResolvedValue({
        ...readyStatus,
        profiles: [
          profile,
          { ...profile, id: 'prof-out', label: 'signed-out', isDefault: false, auth: 'auth-required' },
        ],
      });
      renderModal();
      await waitForProfiles();

      const signedIn = screen.getByTestId('databricks-profile-auth-prof-main');
      const signedOut = screen.getByTestId('databricks-profile-auth-prof-out');
      expect(signedIn.dataset.auth).toBe('ok');
      expect(signedOut.dataset.auth).toBe('required');
      expect(signedIn.className).not.toBe(signedOut.className);
      expect(signedIn.textContent).not.toBe(signedOut.textContent);
      expect(signedIn.textContent?.trim().length).toBeGreaterThan(0);
      expect(signedOut.textContent?.trim().length).toBeGreaterThan(0);
    });

    it('keeps the primary line intact when the profile is not the default', async () => {
      databricksClient.fetchDatabricksStatus.mockResolvedValue({
        ...readyStatus,
        profiles: [{ ...profile, isDefault: false }],
      });
      renderModal();
      await waitForProfiles();

      const card = screen.getByTestId('databricks-profile-prof-main');
      expect(within(card).queryByTestId('databricks-profile-default-prof-main')).toBeNull();
      const name = within(card).getByTestId('databricks-profile-name-prof-main');
      const auth = within(card).getByTestId('databricks-profile-auth-prof-main');
      expect(name.parentElement).toBe(auth.parentElement);
      expect(name.textContent).toBe('main');
      expect(within(card).getByTestId('databricks-profile-workspace-prof-main').parentElement).toBe(card);
    });
  });
});
