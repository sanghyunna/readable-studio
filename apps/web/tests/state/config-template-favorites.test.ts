import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
  type AppConfigWithTemplateFavorites,
} from '../../src/state/config';

const store = new Map<string, string>();
const originalFetch = globalThis.fetch;

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

describe('templateFavorites in web config state', () => {
  afterEach(() => {
    store.clear();
    globalThis.fetch = originalFetch;
  });

  it('adopts the daemon list and leaves older daemons without the key alone', () => {
    const withKey = mergeDaemonConfig(DEFAULT_CONFIG, { templateFavorites: ['b', 'a'] });
    expect(withKey.templateFavorites).toEqual(['b', 'a']);
    const withoutKey = mergeDaemonConfig(DEFAULT_CONFIG, { agentId: 'claude' });
    expect(withoutKey.templateFavorites).toBeUndefined();
  });

  it('sends the list to the daemon on sync', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const config: AppConfigWithTemplateFavorites = { ...DEFAULT_CONFIG, templateFavorites: ['a'] };
    await syncConfigToDaemon(config);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ templateFavorites: ['a'] });
  });

  it('keeps the daemon-owned list out of localStorage in both directions', () => {
    saveConfig({ ...DEFAULT_CONFIG, templateFavorites: ['a'] } as AppConfigWithTemplateFavorites);
    const [, saved] = [...store.entries()][0] ?? [];
    expect(JSON.parse(saved ?? '{}')).not.toHaveProperty('templateFavorites');
    const [key] = [...store.keys()];
    store.set(key!, JSON.stringify({ ...DEFAULT_CONFIG, templateFavorites: ['stale'] }));
    expect((loadConfig() as AppConfigWithTemplateFavorites).templateFavorites).toBeUndefined();
  });
});
