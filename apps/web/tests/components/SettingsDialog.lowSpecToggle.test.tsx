// @vitest-environment jsdom

// The single `저사양 모드` (low-spec) control lives in the Settings modal's
// top-right header chrome, immediately LEFT of the close button (owner
// requirement). It is the same pressed-state ToggleButton design as before —
// never a checkbox — and it writes `performanceProfile` through the dialog's
// existing draft + autosave path. The old Appearance-section Switch row is
// gone so there is exactly one obvious control.

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

import { SettingsDialog, type SettingsSection } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
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

function renderDialog(
  profile: 'full' | 'low',
  options: { locale?: 'en' | 'ko'; section?: SettingsSection } = {},
) {
  const onPersist = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nProvider initial={options.locale ?? 'en'}>
      <SettingsDialog
        initial={{ ...baseConfig, performanceProfile: profile }}
        agents={[]}
        daemonLive
        appVersionInfo={null}
        initialSection={options.section ?? 'appearance'}
        onPersist={onPersist}
        onClose={onClose}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );
  return { onPersist, onClose };
}

function headerToggle(): HTMLButtonElement {
  const node = screen.getByTestId('settings-low-spec-toggle');
  if (!(node instanceof HTMLButtonElement)) throw new Error('low-spec toggle is not a button');
  return node;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings header low-spec toggle', () => {
  it('sits in the header chrome immediately left of the close button, labeled 저사양 모드', () => {
    renderDialog('low', { locale: 'ko' });
    const toggle = headerToggle();
    expect(ko['settings.lowSpecMode']).toBe('저사양 모드');
    expect(toggle.textContent).toContain('저사양 모드');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.querySelector('svg')).not.toBeNull();

    // DOM order inside the chrome strip: toggle comes directly before the
    // close button, and close stays the rightmost element.
    const chrome = toggle.closest('.settings-chrome');
    expect(chrome).not.toBeNull();
    const close = chrome!.querySelector('.settings-close');
    expect(close).not.toBeNull();
    expect(toggle.nextElementSibling).toBe(close);
    expect(close!.nextElementSibling).toBeNull();
  });

  it('is the only low-spec control in the dialog — the Appearance row is gone', () => {
    renderDialog('full', { section: 'appearance' });
    expect(screen.queryByTestId('settings-low-spec-switch')).toBeNull();
    const allLowSpecControls = document.querySelectorAll(
      '[data-testid="settings-low-spec-toggle"], [data-testid="settings-low-spec-switch"]',
    );
    expect(allLowSpecControls).toHaveLength(1);
    // No checkbox UI anywhere.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('renders on every section, not just Appearance', () => {
    renderDialog('full', { section: 'execution' });
    expect(headerToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('persists the flipped profile through the dialog autosave path', async () => {
    const { onPersist } = renderDialog('full');
    const toggle = headerToggle();
    expect(toggle.textContent).toContain(en['settings.lowSpecMode']);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({ performanceProfile: 'low' }),
      );
    });
  });

  it('toggles from the keyboard as a native button (Enter/Space click semantics)', () => {
    renderDialog('low');
    const toggle = headerToggle();
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    // jsdom does not synthesize click from keydown; a native <button> does in
    // every browser. Asserting the element type + a click keeps the contract.
    expect(toggle.type).toBe('button');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});
