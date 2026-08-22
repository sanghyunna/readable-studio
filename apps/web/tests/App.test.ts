import { describe, expect, it, vi } from 'vitest';

import {
  buildPersistedConfig,
  isAutosaveDraftOnlyChange,
  resolveSettingsCloseConfig,
} from '../src/state/settings-persistence';
import type { AppConfig } from '../src/types';

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: 'sk-test',
  apiProtocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

describe('buildPersistedConfig', () => {
  it('preserves onboarding completion when a stale autosave snapshot says false', () => {
    expect(
      buildPersistedConfig(
        { ...baseConfig, onboardingCompleted: false },
        { ...baseConfig, onboardingCompleted: true },
      ),
    ).toMatchObject({ onboardingCompleted: true });
  });

  it('preserves a current privacy decision when settings autosaves a stale pre-consent snapshot', () => {
    expect(
      buildPersistedConfig(
        {
          ...baseConfig,
          apiProtocol: 'google',
          privacyDecisionAt: null,
          telemetry: { metrics: true, content: true, artifactManifest: false },
        },
        {
          ...baseConfig,
          installationId: 'inst-current',
          privacyDecisionAt: 12345,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      ),
    ).toMatchObject({
      apiProtocol: 'google',
      installationId: 'inst-current',
      privacyDecisionAt: 12345,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    });
  });
});

describe('isAutosaveDraftOnlyChange', () => {
  it('flags a real change (non-draft field) as persist-worthy', () => {
    const flipped: AppConfig = { ...baseConfig, model: 'claude-opus-4-7' };
    expect(isAutosaveDraftOnlyChange(flipped, baseConfig)).toBe(false);
  });

  it('returns true for an identical snapshot (no-op autosave tick)', () => {
    expect(isAutosaveDraftOnlyChange(baseConfig, baseConfig)).toBe(true);
  });
});

describe('resolveSettingsCloseConfig', () => {
  it('marks onboarding complete without discarding the latest persisted draft', () => {
    expect(
      resolveSettingsCloseConfig(
        {
          ...baseConfig,
          onboardingCompleted: false,
          accentColor: '#aaaaaa',
        },
        {
          ...baseConfig,
          onboardingCompleted: false,
          accentColor: '#bbbbbb',
        },
      ),
    ).toMatchObject({
      onboardingCompleted: true,
      accentColor: '#bbbbbb',
    });
  });
});
