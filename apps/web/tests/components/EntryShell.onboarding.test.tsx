// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: analyticsMocks.track,
    }),
    useAppVersion: () => null,
  };
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// AMR is intentionally excluded from the collapsed single-step onboarding, but
// it can still be present in the agent catalogue. Keep a factory so tests can
// assert the runtime card list filters it out.
function amrAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'amr',
    name: 'AMR',
    bin: 'amr',
    available: true,
    models: [{ id: 'amr-model', label: 'AMR Model' }],
    ...overrides,
  };
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: null,
    agentModels: {},
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    ...overrides,
  } as AppConfig;
}

function renderOnboarding(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/onboarding');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    defaultDesignSystemId: null,
    config: baseConfig(),
    agents: [amrAgent(), cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [amrAgent(), cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  function Harness() {
    const [config, setConfig] = useState(props.config);
    return (
      <I18nProvider initial="en">
        <EntryShell
          {...props}
          config={config}
          onConfigPersist={(next) => {
            props.onConfigPersist(next);
            setConfig(next as AppConfig);
          }}
        />
      </I18nProvider>
    );
  }

  render(
    <Harness />,
  );

  return props;
}

function renderHome(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    defaultDesignSystemId: null,
    config: baseConfig({
      agentId: 'claude-code',
      agentModels: { 'claude-code': { model: 'sonnet' } },
      theme: 'system',
    }),
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

function trackedEvents(name: string) {
  return analyticsMocks.track.mock.calls.filter(([eventName]) => eventName === name);
}

function latestTrackedEvent<T extends Record<string, unknown>>(name: string): T {
  const calls = trackedEvents(name);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[1] as T;
}

function findTrackedEvent<T extends Record<string, unknown>>(
  name: string,
  predicate: (payload: T) => boolean,
): T {
  const payload = trackedEvents(name)
    .map(([, eventPayload]) => eventPayload as T)
    .find(predicate);
  expect(payload).toBeTruthy();
  return payload as T;
}

function chooseDropdownOption(label: string, option: string | RegExp) {
  const field = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-view__select-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (!field) throw new Error(`dropdown field not found: ${label}`);
  const trigger = field.querySelector('button');
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`dropdown trigger not found: ${label}`);
  }
  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole('option', {
      name: option instanceof RegExp ? option : new RegExp(option, 'i'),
    }),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  analyticsMocks.track.mockReset();
  window.sessionStorage.clear();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  analyticsMocks.track.mockReset();
});

describe('EntryShell settings menu', () => {
  it('opens quick actions before opening the full settings dialog', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const props = renderHome();

    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    expect(props.onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();

    fireEvent.click(screen.getByTestId('entry-settings-open-details'));

    expect(props.onOpenSettings).toHaveBeenCalledWith();
  });
});

describe('EntryShell onboarding single runtime-pick step', () => {
  it('renders one runtime-pick step with Local CLI and BYOK and no AMR card', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    // Connect step heading + the two runtime alternatives.
    expect(screen.getByText('Choose a runtime')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Local coding agent/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bring your own key/i })).toBeTruthy();

    // The AMR cloud upsell card is gone, and nothing is pre-selected.
    expect(screen.queryByRole('button', { name: /AMR/i })).toBeNull();
    expect(document.querySelector('.onboarding-view__amr-cloud-card')).toBeNull();
    expect(document.querySelector('.onboarding-view__card--skeleton')).toBeNull();

    // The About-you and newsletter steps no longer exist.
    expect(screen.queryByRole('heading', { name: 'About you' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Stay in the loop' })).toBeNull();
    expect(document.querySelector('.onboarding-view__email-input')).toBeNull();

    // Exactly the connect page-view fires (no about_you / newsletter views).
    const pageViews = trackedEvents('page_view').map(([, payload]) => payload);
    expect(pageViews).toEqual([
      expect.objectContaining({
        page_name: 'onboarding',
        area: 'runtime',
        step_index: '1',
        step_name: 'connect',
      }),
    ]);
  });

  it('excludes AMR from the Local CLI agent list', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    renderOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /Local coding agent/i }));
    await vi.advanceTimersByTimeAsync(300);

    const localPanel = screen.getByText('Local CLI').closest('.onboarding-view__setup-panel');
    expect(localPanel?.textContent).toContain('Claude Code');
    expect(localPanel?.textContent).not.toContain('AMR');
  });

  it('finishes onboarding and reports the local CLI runtime on the completion event', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const props = renderOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /Local coding agent/i }));
    await waitFor(() => {
      expect(props.onModeChange).toHaveBeenCalledWith('daemon');
    });

    fireEvent.click(screen.getByRole('button', { name: /Finish setup/i }));

    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);

    expect(findTrackedEvent('ui_click', (payload) => payload.element === 'continue')).toMatchObject({
      page_name: 'onboarding',
      area: 'runtime',
      element: 'continue',
      action: 'continue',
    });

    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      page_name: 'onboarding',
      area: 'onboarding',
      result: 'completed',
      completion_type: 'completed_without_design_system',
      runtime_type: 'local_cli',
      has_about_you: false,
      has_design_system_request: false,
      source_count: 0,
    });

    // No survey snapshot is emitted any more.
    expect(
      trackedEvents('ui_click')
        .map(([, payload]) => payload as Record<string, unknown>)
        .some((payload) => payload.element === 'about_you_submit'),
    ).toBe(false);
  });

  it('persists the BYOK config before finishing onboarding', async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
            { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
          ],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'claude-opus-4-8',
          sample: 'Connected',
        });
      }
      return jsonResponse({});
    }) as typeof fetch;
    const props = renderOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /Bring your own key/i }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-api-key' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.anthropic.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Fetch models/i }));
    await waitFor(() => {
      expect(screen.getByText('Fetched 2 models.')).toBeTruthy();
    });
    chooseDropdownOption('Model', /claude-opus-4-8/i);
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Connected\. Replied in 12 ms/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Finish setup/i }));

    expect(props.onModeChange).toHaveBeenCalledWith('api');
    expect(props.onApiModelChange).toHaveBeenCalledWith('claude-opus-4-8');
    expect(props.onConfigPersist).toHaveBeenCalled();
    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect((props.onConfigPersist as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'api',
      apiProtocol: 'anthropic',
      apiKey: 'test-api-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-4-8',
      apiProviderBaseUrl: null,
    });

    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      result: 'completed',
      runtime_type: 'byok',
      has_about_you: false,
    });
  });

  it('lets Skip exit onboarding and reports a skipped completion', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /Skip/i }));

    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(props.onConfigPersist).not.toHaveBeenCalled();
    expect(findTrackedEvent('ui_click', (payload) => payload.element === 'skip')).toMatchObject({
      page_name: 'onboarding',
      area: 'runtime',
      element: 'skip',
      action: 'skip',
    });
    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      page_name: 'onboarding',
      area: 'onboarding',
      result: 'skipped',
      completion_type: 'skipped',
      // Nothing was picked before Skip, so the runtime is unset.
      runtime_type: 'none',
      has_about_you: false,
    });
  });

  it('does not start any AMR sign-in flow from the runtime step', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({}));
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderOnboarding();

    // No AMR sign-in affordance exists.
    expect(screen.queryByRole('button', { name: /Sign in to continue/i })).toBeNull();
    expect(screen.queryByText('Signing in…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Finish setup/i }));
    await act(async () => {});

    expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/integrations/vela/login'),
      ),
    ).toBe(false);
  });
});