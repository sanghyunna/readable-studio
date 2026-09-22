// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { analyticsTrackMock } = vi.hoisted(() => ({
  analyticsTrackMock: vi.fn(),
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analyticsTrackMock,
    setConsent: () => undefined,
    setIdentity: () => undefined,
    setConfigureGlobals: () => undefined,
    anonymousId: 'test-anonymous',
    sessionId: 'test-session',
    newRequestId: () => 'test-request',
  }),
}));

import type {
  EditableSystemPrompt,
  SystemPromptValidationError,
} from '@readable-studio/contracts';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import type { SettingsSection } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
import { DEFAULT_CONFIG, DEFAULT_FEATURE_FLAGS, loadConfig } from '../../src/state/config';
import type { AgentInfo, AppConfig } from '../../src/types';

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const agents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.80.0',
    models: [{ id: 'default', label: 'Default' }],
  },
];

const DECK_DEFAULT = 'Deck default with {{DECK_SKELETON_HTML}} slot.';
const DISCOVERY_DEFAULT = 'Discovery default with {{DIRECTION_LIBRARY}} slot.';

function deckPrompt(overrides: Partial<EditableSystemPrompt> = {}): EditableSystemPrompt {
  return {
    id: 'deck-framework',
    label: 'Deck framework',
    description: 'Drives deck generation.',
    content: DECK_DEFAULT,
    defaultContent: DECK_DEFAULT,
    overridden: false,
    requiredPlaceholders: ['{{DECK_SKELETON_HTML}}'],
    ...overrides,
  };
}

function discoveryPrompt(
  overrides: Partial<EditableSystemPrompt> = {},
): EditableSystemPrompt {
  return {
    id: 'discovery-workflow',
    label: 'Discovery workflow',
    description: 'Drives discovery.',
    content: DISCOVERY_DEFAULT,
    defaultContent: DISCOVERY_DEFAULT,
    overridden: false,
    requiredPlaceholders: ['{{DIRECTION_LIBRARY}}'],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderSettings(
  section: SettingsSection,
  initial: Partial<AppConfig> = {},
  locale: 'en' | 'ko' = 'en',
) {
  const onPersist = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <I18nProvider initial={locale}>
      <SettingsDialog
        initial={{ ...baseConfig, ...initial }}
        agents={agents}
        daemonLive
        appVersionInfo={null}
        initialSection={section}
        onPersist={onPersist}
        onClose={onClose}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );
  return { onPersist, onClose, ...view };
}

function promptCard(id: string): HTMLElement {
  const card = document.querySelector(`[data-prompt-id="${id}"]`);
  if (!(card instanceof HTMLElement)) throw new Error(`No prompt card for ${id}`);
  return card;
}

function flagSwitch(flag: string): HTMLElement {
  const row = document.querySelector(`[data-flag="${flag}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`No flag row for ${flag}`);
  return within(row).getByRole('switch');
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  analyticsTrackMock.mockReset();
});

describe('Settings → system prompts', () => {
  it('renders API prompt labels and descriptions from stable ids in Korean', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ prompts: [deckPrompt(), discoveryPrompt()] }),
    ) as unknown as typeof fetch;

    renderSettings('systemPrompts', {}, 'ko');

    await screen.findByText(ko['systemPrompts.deckFramework.label']);
    const deck = promptCard('deck-framework');
    expect(within(deck).getByText(ko['systemPrompts.deckFramework.description'])).toBeTruthy();
    expect(within(deck).queryByText('Deck framework')).toBeNull();
    expect(within(deck).queryByText('Drives deck generation.')).toBeNull();
    expect(
      within(deck).getByRole('textbox', {
        name: `${ko['systemPrompts.deckFramework.label']} — ${ko['systemPrompts.editorLabel']}`,
      }),
    ).toBeTruthy();
    expect(ko['systemPrompts.deckFramework.label']).not.toBe(
      en['systemPrompts.deckFramework.label'],
    );
  });

  it('lists prompts and marks which ones carry an override', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        prompts: [
          deckPrompt({ content: 'Custom {{DECK_SKELETON_HTML}}', overridden: true }),
          discoveryPrompt(),
        ],
      }),
    ) as unknown as typeof fetch;

    renderSettings('systemPrompts');

    await screen.findByText(en['systemPrompts.deckFramework.label']);
    expect(
      within(promptCard('deck-framework')).getByText(en['systemPrompts.overridden']),
    ).toBeTruthy();
    expect(
      within(promptCard('discovery-workflow')).getByText(en['systemPrompts.usingDefault']),
    ).toBeTruthy();
  });

  it('saves an edited prompt through PUT and adopts the returned prompt', async () => {
    const saved = deckPrompt({
      content: 'Edited {{DECK_SKELETON_HTML}}',
      overridden: true,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return jsonResponse({ prompt: saved });
      return jsonResponse({ prompts: [deckPrompt()] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSettings('systemPrompts');
    await screen.findByText(en['systemPrompts.deckFramework.label']);

    const card = promptCard('deck-framework');
    const editor = within(card).getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'Edited {{DECK_SKELETON_HTML}}' } });

    fireEvent.click(within(card).getByRole('button', { name: en['systemPrompts.save'] }));

    await screen.findByText(en['systemPrompts.saved']);

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall?.[0]).toBe('/api/system-prompts/deck-framework');
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      content: 'Edited {{DECK_SKELETON_HTML}}',
    });
    expect(
      within(promptCard('deck-framework')).getByText(en['systemPrompts.overridden']),
    ).toBeTruthy();
  });

  it('resets an overridden prompt through DELETE and restores the shipped default', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return jsonResponse({ prompt: deckPrompt() });
      return jsonResponse({
        prompts: [deckPrompt({ content: 'Custom {{DECK_SKELETON_HTML}}', overridden: true })],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSettings('systemPrompts');
    await screen.findByText(en['systemPrompts.deckFramework.label']);

    const card = promptCard('deck-framework');
    fireEvent.click(within(card).getByRole('button', { name: en['systemPrompts.reset'] }));

    await screen.findByText(en['systemPrompts.resetDone']);

    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deleteCall?.[0]).toBe('/api/system-prompts/deck-framework');

    const refreshed = promptCard('deck-framework');
    expect(within(refreshed).getByRole('textbox')).toHaveProperty('value', DECK_DEFAULT);
    expect(within(refreshed).getByText(en['systemPrompts.usingDefault'])).toBeTruthy();
  });

  it('warns before save and blocks the save button when a required placeholder is deleted', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ prompts: [discoveryPrompt()] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSettings('systemPrompts');
    await screen.findByText(en['systemPrompts.discoveryWorkflow.label']);

    const card = promptCard('discovery-workflow');
    // The slot is called out as present before the user touches anything.
    expect(
      within(card).getByText(
        en['systemPrompts.placeholderPresent'].replace('{name}', '{{DIRECTION_LIBRARY}}'),
      ),
    ).toBeTruthy();

    fireEvent.change(within(card).getByRole('textbox'), {
      target: { value: 'Discovery without its slot.' },
    });

    expect(
      within(card).getByText(
        en['systemPrompts.placeholderMissing'].replace('{name}', '{{DIRECTION_LIBRARY}}'),
      ),
    ).toBeTruthy();
    expect(within(card).getByText(en['systemPrompts.blockedBeforeSave'])).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: en['systemPrompts.save'] }),
    ).toHaveProperty('disabled', true);
    // No PUT was ever attempted.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('surfaces a 400 placeholder validation error in plain language naming the slot', async () => {
    const validationError: SystemPromptValidationError = {
      error: {
        code: 'INVALID_SYSTEM_PROMPT',
        message: 'raw daemon detail that must not be shown verbatim',
        missingPlaceholders: ['{{DIRECTION_LIBRARY}}'],
        duplicatePlaceholders: [],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return jsonResponse(validationError, 400);
      return jsonResponse({ prompts: [discoveryPrompt()] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSettings('systemPrompts');
    await screen.findByText(en['systemPrompts.discoveryWorkflow.label']);

    const card = promptCard('discovery-workflow');
    // Keep the slot so the client-side guard allows the request through and the
    // server-side 400 is what gets surfaced.
    fireEvent.change(within(card).getByRole('textbox'), {
      target: { value: 'Edited {{DIRECTION_LIBRARY}} body.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: en['systemPrompts.save'] }));

    const expected = en['systemPrompts.validationMissing'].replace(
      '{names}',
      '{{DIRECTION_LIBRARY}}',
    );
    await screen.findByText(expected);
    expect(screen.queryByText(validationError.error.message)).toBeNull();
  });
});

describe('Settings → workspace feature flags', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
  });

  it('renders switches, never checkboxes', async () => {
    renderSettings('featureFlags');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(flagSwitch('previewScreenshot').getAttribute('role')).toBe('switch');
    expect(flagSwitch('previewViewportSelector').getAttribute('role')).toBe('switch');
  });

  it('defaults both flags to OFF when the config carries no featureFlags', () => {
    renderSettings('featureFlags');
    expect(flagSwitch('previewScreenshot').getAttribute('aria-checked')).toBe('false');
    expect(flagSwitch('previewViewportSelector').getAttribute('aria-checked')).toBe('false');
  });

  it('turns a flag on without disturbing the other', async () => {
    const { onPersist } = renderSettings('featureFlags');
    fireEvent.click(flagSwitch('previewScreenshot'));

    await waitFor(() => {
      expect(flagSwitch('previewScreenshot').getAttribute('aria-checked')).toBe('true');
    });
    expect(flagSwitch('previewViewportSelector').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(flagSwitch('previewViewportSelector'));
    await waitFor(() => {
      expect(flagSwitch('previewViewportSelector').getAttribute('aria-checked')).toBe('true');
    });
    expect(flagSwitch('previewScreenshot').getAttribute('aria-checked')).toBe('true');
    void onPersist;
  });

  it('reflects a stored ON flag', () => {
    renderSettings('featureFlags', {
      featureFlags: { previewScreenshot: true, previewViewportSelector: false },
    });
    expect(flagSwitch('previewScreenshot').getAttribute('aria-checked')).toBe('true');
    expect(flagSwitch('previewViewportSelector').getAttribute('aria-checked')).toBe('false');
  });
});

describe('feature flag config defaults', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ships both flags OFF in DEFAULT_CONFIG', () => {
    expect(DEFAULT_FEATURE_FLAGS).toEqual({
      previewScreenshot: false,
      previewViewportSelector: false,
    });
    expect(DEFAULT_CONFIG.featureFlags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('treats a fresh install as OFF', () => {
    expect(loadConfig().featureFlags).toEqual({
      previewScreenshot: false,
      previewViewportSelector: false,
    });
  });

  it('treats an absent stored featureFlags block as OFF', () => {
    store.set('readable-studio:config', JSON.stringify({ theme: 'dark' }));
    expect(loadConfig().featureFlags).toEqual({
      previewScreenshot: false,
      previewViewportSelector: false,
    });
  });

  it('preserves a stored ON flag and defaults the missing sibling to OFF', () => {
    store.set(
      'readable-studio:config',
      JSON.stringify({ featureFlags: { previewScreenshot: true } }),
    );
    expect(loadConfig().featureFlags).toEqual({
      previewScreenshot: true,
      previewViewportSelector: false,
    });
  });

  it('does not let a non-boolean stored value read as ON', () => {
    store.set(
      'readable-studio:config',
      JSON.stringify({ featureFlags: { previewScreenshot: 'yes', previewViewportSelector: 1 } }),
    );
    expect(loadConfig().featureFlags).toEqual({
      previewScreenshot: false,
      previewViewportSelector: false,
    });
  });

  it('round-trips both flags through saveConfig', () => {
    store.set(
      'readable-studio:config',
      JSON.stringify({
        featureFlags: { previewScreenshot: true, previewViewportSelector: true },
      }),
    );
    expect(loadConfig().featureFlags).toEqual({
      previewScreenshot: true,
      previewViewportSelector: true,
    });
  });
});

describe('fileViewer range-selection label', () => {
  it('uses the range-selection wording in both locales', () => {
    expect(ko['fileViewer.mark']).toBe('범위 지정');
    expect(ko['fileViewer.markTool']).toBe('범위 지정 도구');
    expect(en['fileViewer.mark']).toBe('Select range');
    expect(en['fileViewer.markTool']).toBe('Select range tool');
  });

  it('keeps the tool label consistent with the base label', () => {
    expect(ko['fileViewer.markTool'].startsWith(ko['fileViewer.mark'])).toBe(true);
    expect(en['fileViewer.markTool'].startsWith(en['fileViewer.mark'])).toBe(true);
  });
});
