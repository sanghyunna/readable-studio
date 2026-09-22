// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
import type { AppConfig } from '../../src/types';

const config: AppConfig = {
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

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  analyticsTrackMock.mockReset();
});

describe('SettingsDialog Korean chrome', () => {
  it('localizes the Settings navigation landmark', () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}))) as typeof fetch;

    render(
      <I18nProvider initial="ko">
        <SettingsDialog
          initial={config}
          agents={[]}
          daemonLive
          appVersionInfo={null}
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    const sidebar = screen.getByRole('complementary', {
      name: ko['settings.sectionsAria'],
    });
    expect(sidebar.getAttribute('aria-label')).toBe(ko['settings.sectionsAria']);
    expect(sidebar.getAttribute('aria-label')).not.toContain(en['settings.sectionsAria']);
    expect(screen.queryByRole('complementary', { name: en['settings.sectionsAria'] })).toBeNull();
    expect(ko['settings.sectionsAria']).not.toBe(en['settings.sectionsAria']);
  });
});
