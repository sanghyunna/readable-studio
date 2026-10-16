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
import type { AgentInfo, AppConfig } from '../../src/types';

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

describe('SettingsDialog agent subtitle localization', () => {
  it('renders Korean subtitles for installed and unavailable agents', () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}))) as typeof fetch;

    render(
      <I18nProvider initial="ko">
        <SettingsDialog
          initial={{ ...config, mode: 'daemon', agentId: 'codex' }}
          agents={[
            {
              id: 'codex',
              name: 'Codex CLI',
              bin: 'codex',
              available: true,
              version: '0.80.0',
            } as AgentInfo,
            {
              id: 'cursor-agent',
              name: 'Cursor Agent',
              bin: 'cursor-agent',
              available: false,
            } as AgentInfo,
          ]}
          daemonLive
          appVersionInfo={null}
          initialSection="execution"
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(ko['settings.agentDescription.codex'])).toBeTruthy();
    expect(screen.queryByText(en['settings.agentDescription.codex'])).toBeNull();
    expect(screen.getByText(ko['settings.agentDescription.cursor-agent'])).toBeTruthy();
    expect(screen.queryByText(en['settings.agentDescription.cursor-agent'])).toBeNull();
  });

  it('keeps English subtitles unchanged in English locale', () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}))) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <SettingsDialog
          initial={{ ...config, mode: 'daemon', agentId: 'codex' }}
          agents={[
            {
              id: 'codex',
              name: 'Codex CLI',
              bin: 'codex',
              available: true,
              version: '0.80.0',
            } as AgentInfo,
          ]}
          daemonLive
          appVersionInfo={null}
          initialSection="execution"
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(en['settings.agentDescription.codex'])).toBeTruthy();
    expect(screen.queryByText(ko['settings.agentDescription.codex'])).toBeNull();
  });

  it('preserves brand names that are identical in Korean and English', () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}))) as typeof fetch;

    render(
      <I18nProvider initial="ko">
        <SettingsDialog
          initial={{ ...config, mode: 'daemon', agentId: 'kimi' }}
          agents={[
            {
              id: 'kimi',
              name: 'Kimi CLI',
              bin: 'kimi',
              available: true,
              version: '1.0.0',
            } as AgentInfo,
          ]}
          daemonLive
          appVersionInfo={null}
          initialSection="execution"
          onPersist={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(ko['settings.agentDescription.kimi'])).toBeTruthy();
    expect(ko['settings.agentDescription.kimi']).toBe(en['settings.agentDescription.kimi']);
  });
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
