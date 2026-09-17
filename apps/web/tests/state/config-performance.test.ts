// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  PERFORMANCE_PROFILE_ATTRIBUTE,
  applyPerformanceProfileToDocument,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
} from '../../src/state/config';

const STORAGE_KEY = 'readable-studio:config';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-performance-profile');
});

describe('performance profile storage', () => {
  it('defaults to full when no local preference exists', () => {
    // Given an empty local mirror.
    // When config is loaded.
    const config = loadConfig();
    // Then both the web default and loaded profile are full.
    expect(DEFAULT_CONFIG).toMatchObject({ performanceProfile: 'full' });
    expect(config).toMatchObject({ performanceProfile: 'full' });
  });

  it.each(['full', 'low'] as const)('preserves %s when it is stored explicitly', (performanceProfile) => {
    // Given an explicit local preference.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ performanceProfile }));
    // When config is loaded.
    const config = loadConfig();
    // Then the exact preference survives.
    expect(config).toMatchObject({ performanceProfile });
  });

  it.each(['{}', '{broken', 'null', '[]', '42', '{"performanceProfile":null}', '{"performanceProfile":true}', '{"performanceProfile":"LOW"}'])(
    'defaults to full when storage is missing or malformed: %s', (raw) => {
      // Given a legacy or malformed local mirror.
      localStorage.setItem(STORAGE_KEY, raw);
      // When config is loaded.
      const config = loadConfig();
      // Then no malformed preference enables low mode.
      expect(config).toMatchObject({ performanceProfile: 'full' });
    },
  );

  it('defaults to full when storage access is denied', () => {
    // Given a browser that blocks storage.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });
    // When config is loaded.
    const config = loadConfig();
    // Then the fallback remains usable.
    expect(config).toMatchObject({ performanceProfile: 'full' });
  });

  it.each(['full', 'low'] as const)('mirrors %s when config is saved', (performanceProfile) => {
    // Given a daemon-owned preference in the loaded config.
    const config = { ...DEFAULT_CONFIG, performanceProfile };
    // When config is persisted locally.
    saveConfig(config);
    // Then pre-hydration can read the preference from the existing blob.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ performanceProfile });
  });
});

describe('performance profile daemon reconciliation', () => {
  it.each(['full', 'low'] as const)('includes %s when preferences are PUT to the daemon', async (performanceProfile) => {
    // Given a successful daemon endpoint.
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) requests.push(init);
      return new Response('{}');
    }));
    // When the profile is synced.
    await syncConfigToDaemon({ ...DEFAULT_CONFIG, performanceProfile });
    // Then the machine-consumed PUT payload includes the profile.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('PUT');
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ performanceProfile });
  });

  it.each([
    ['full', 'low'],
    ['low', 'full'],
  ] as const)('uses daemon %s when the local mirror is stale %s', async (performanceProfile, staleProfile) => {
    // Given a CLI-updated daemon and an older browser preference.
    const local = {
      ...DEFAULT_CONFIG,
      performanceProfile: staleProfile,
      theme: 'dark' as const,
      accentColorMode: 'custom' as const,
      accentColor: '#123456',
      featureFlags: { previewScreenshot: true, previewViewportSelector: false },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      config: { performanceProfile, enabledAgentIds: ['codex'] },
    }))));
    // When the existing hydration flow fetches and merges daemon preferences.
    const merged = mergeDaemonConfig(local, await fetchDaemonConfig());
    // Then daemon ownership wins without changing browser-owned appearance or flags.
    expect(merged).toMatchObject({
      performanceProfile,
      theme: local.theme,
      accentColorMode: local.accentColorMode,
      accentColor: local.accentColor,
      featureFlags: local.featureFlags,
    });
  });

  it('resets stale low mode when a legacy daemon config has no profile', () => {
    // Given a stale low mirror and a default daemon config.
    const local = { ...DEFAULT_CONFIG, performanceProfile: 'low' as const };
    // When the authoritative daemon config is merged.
    const merged = mergeDaemonConfig(local, {});
    // Then the absent daemon preference means full.
    expect(merged).toMatchObject({ performanceProfile: 'full' });
  });

  it('retains the mirror when the daemon is offline', () => {
    // Given a low mirror and an unavailable daemon.
    const local = { ...DEFAULT_CONFIG, performanceProfile: 'low' as const };
    // When the failed GET result is merged.
    const merged = mergeDaemonConfig(local, null);
    // Then offline startup still respects the mirror.
    expect(merged).toMatchObject({ performanceProfile: 'low' });
  });
});

describe('performance profile document stamp', () => {
  it.each(['full', 'low'] as const)('applies %s idempotently when called repeatedly', (profile) => {
    // Given a document already stamped low.
    document.documentElement.setAttribute('data-performance-profile', 'low');
    // When the same profile is applied repeatedly.
    for (let index = 0; index < 2; index += 1) applyPerformanceProfileToDocument(profile);
    // Then the root reflects the selected profile, with full represented by absence.
    expect(PERFORMANCE_PROFILE_ATTRIBUTE).toBe('data-performance-profile');
    expect(document.documentElement.getAttribute(PERFORMANCE_PROFILE_ATTRIBUTE)).toBe(profile === 'low' ? 'low' : null);
  });
});
