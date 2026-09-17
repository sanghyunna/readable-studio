// @vitest-environment jsdom

// Settings > Appearance carries the same `performanceProfile` as the Hub
// toggle, as a `Switch` row. It reads the persisted value and writes back
// through the dialog's autosave path, so the two controls can never disagree.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: vi.fn(),
    setConsent: () => undefined,
    setIdentity: () => undefined,
    setConfigureGlobals: () => undefined,
    anonymousId: 'test-anonymous',
    sessionId: 'test-session',
    newRequestId: () => 'test-request',
  }),
}));

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import type { AppConfig } from '../../src/types';

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

function renderAppearance(profile: 'full' | 'low', locale: 'en' | 'ko' = 'en') {
  const onPersist = vi.fn();
  render(
    <I18nProvider initial={locale}>
      <SettingsDialog
        initial={{ ...baseConfig, performanceProfile: profile }}
        agents={[]}
        daemonLive
        appVersionInfo={null}
        initialSection="appearance"
        onPersist={onPersist}
        onClose={vi.fn()}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );
  return { onPersist };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings > Appearance low-spec switch', () => {
  it('renders a Switch row with the shared label and explanation, mirroring the persisted value', () => {
    renderAppearance('low', 'ko');
    const row = screen.getByTestId('settings-low-spec-switch');
    expect(row.getAttribute('role')).toBe('switch');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.textContent).toContain(ko['settings.lowSpecMode']);
    expect(ko['settings.lowSpecMode']).toBe('저사양 모드');
    expect(screen.getByText(ko['settings.lowSpecModeHint'])).not.toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('persists the flipped profile through the dialog autosave path', async () => {
    const { onPersist } = renderAppearance('full');
    const row = screen.getByTestId('settings-low-spec-switch');
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row.textContent).toContain(en['settings.lowSpecMode']);
    fireEvent.click(row);
    expect(row.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({ performanceProfile: 'low' }),
      );
    });
  });
});
