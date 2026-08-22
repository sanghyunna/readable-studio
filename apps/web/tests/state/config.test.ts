import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
} from '../../src/state/config';
import { THEME_OPTIONS } from '../../src/state/themes';
import type { AppConfig } from '../../src/types';

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

describe('Readable Studio browser storage identity', () => {
  afterEach(() => {
    store.clear();
  });

  it('does not read the retired config key', () => {
    const retiredConfigKey = `${['open', 'design'].join('-')}:config`;
    store.set(retiredConfigKey, JSON.stringify({ theme: 'dark' }));

    expect(loadConfig().theme).toBe(DEFAULT_CONFIG.theme);
  });

  it('writes only the Readable Studio config key', () => {
    saveConfig({ ...DEFAULT_CONFIG, theme: 'dark' });

    const retiredConfigKey = `${['open', 'design'].join('-')}:config`;
    expect(store.has(retiredConfigKey)).toBe(false);
    expect(JSON.parse(store.get('readable-studio:config') ?? '{}').theme).toBe('dark');
  });
});

describe('syncConfigToDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('syncs per-agent CLI env prefs to the daemon app config', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/app-config');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      onboardingCompleted: DEFAULT_CONFIG.onboardingCompleted,
      agentId: DEFAULT_CONFIG.agentId,
      agentModels: DEFAULT_CONFIG.agentModels,
      skillId: DEFAULT_CONFIG.skillId,
      designSystemId: DEFAULT_CONFIG.designSystemId,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
      },
    });
  });

  it('syncs proxy API key env values to daemon app config while localStorage strips them', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
        codex: { OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: 'https://proxy.example/openai' },
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      agentCliEnv: {
        claude: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic' },
        codex: { OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: 'https://proxy.example/openai' },
      },
    });
  });

  it('syncs daemon-owned privacy decision fields', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncConfigToDaemon({
      ...DEFAULT_CONFIG,
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true, content: true, artifactManifest: false },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true, content: true, artifactManifest: false },
    });
  });
});

describe('mergeDaemonConfig', () => {
  it('clears stale local CLI env prefs when the daemon has none', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentId: 'codex',
      },
    );

    expect(merged.agentId).toBe('codex');
    expect(merged.agentCliEnv).toEqual({});
  });

  it('uses daemon CLI env prefs instead of merging with stale local entries', () => {
    const merged = mergeDaemonConfig(
      {
        ...DEFAULT_CONFIG,
        agentCliEnv: {
          claude: { CLAUDE_CONFIG_DIR: '~/.claude-old' },
        },
      },
      {
        agentCliEnv: {
          codex: { CODEX_HOME: '~/.codex-new', CODEX_BIN: '~/bin/codex-new' },
        },
      },
    );

    expect(merged.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-new', CODEX_BIN: '~/bin/codex-new' },
    });
  });

  it('copies privacyDecisionAt from daemon config', () => {
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true },
    });

    expect(merged.installationId).toBe('install-1');
    expect(merged.privacyDecisionAt).toBe(1778244000000);
    expect(merged.telemetry).toEqual({ metrics: true });
  });

  it('migrates old daemon privacy config to a resolved decision', () => {
    const merged = mergeDaemonConfig(DEFAULT_CONFIG, {
      installationId: 'install-1',
      telemetry: { metrics: true },
    });

    expect(merged.installationId).toBe('install-1');
    expect(typeof merged.privacyDecisionAt).toBe('number');
  });
});

afterEach(() => {
  store.clear();
});

describe('loadConfig', () => {
  it('migrates legacy OpenAI-compatible API configs to an explicit apiProtocol', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.mode).toBe('api');
    expect(config.baseUrl).toBe('https://api.deepseek.com');
    expect(config.model).toBe('deepseek-chat');
    expect(config.apiProtocol).toBe('openai');
    expect(config.configMigrationVersion).toBe(1);
  });

  it('backfills the fixed-origin base URL for AIHubMix when persisted empty', () => {
    // AIHubMix hides the Base URL field, so older configs persisted an empty
    // baseUrl. An empty base URL blocks the live model-list fetch, so loadConfig
    // must resolve it to the canonical origin.
    const persisted: Partial<AppConfig> = {
      mode: 'api',
      apiProtocol: 'aihubmix',
      apiKey: 'sk-test',
      baseUrl: '',
      model: 'claude-opus-4-8',
      configMigrationVersion: 1,
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(persisted));

    const config = loadConfig();

    expect(config.apiProtocol).toBe('aihubmix');
    expect(config.baseUrl).toBe('https://aihubmix.com/v1');
  });

  it('leaves a non-gateway protocol base URL untouched', () => {
    const persisted: Partial<AppConfig> = {
      mode: 'api',
      apiProtocol: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      configMigrationVersion: 1,
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(persisted));

    expect(loadConfig().baseUrl).toBe('https://api.example.com/v1');
  });

  it('migrates legacy Anthropic API configs to an explicit apiProtocol', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.apiProtocol).toBe('anthropic');
  });

  it('infers protocol for legacy daemon-mode API fields without changing mode', () => {
    const daemonConfig: Partial<AppConfig> = {
      mode: 'daemon',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      agentId: 'codex',
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(daemonConfig));

    const config = loadConfig();

    expect(config.mode).toBe('daemon');
    expect(config.apiProtocol).toBe('openai');
    expect(config.configMigrationVersion).toBe(1);
  });

  it('migrates legacy Ollama Cloud configs to an explicit ollama apiProtocol', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'ollama-key',
      baseUrl: 'https://ollama.com',
      model: 'gpt-oss:120b',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.mode).toBe('api');
    expect(config.baseUrl).toBe('https://ollama.com');
    expect(config.model).toBe('gpt-oss:120b');
    expect(config.apiProtocol).toBe('ollama');
    expect(config.apiProviderBaseUrl).toBe('https://ollama.com');
    expect(config.configMigrationVersion).toBe(1);
  });

  it('migrates legacy ollama.com configs with a custom base URL path', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'ollama-key',
      baseUrl: 'https://ollama.com/api',
      model: 'deepseek-v4-pro',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.apiProtocol).toBe('ollama');
    // /api suffix must be stripped so the daemon doesn't build /api/api/chat.
    expect(config.baseUrl).toBe('https://ollama.com');
  });

  it('migrates legacy ollama.com configs with a trailing /api/ suffix', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'ollama-key',
      baseUrl: 'https://ollama.com/api/',
      model: 'glm-5',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.apiProtocol).toBe('ollama');
    expect(config.baseUrl).toBe('https://ollama.com');
  });

  it('does not overwrite an already explicit apiProtocol', () => {
    const explicitConfig: Partial<AppConfig> = {
      mode: 'api',
      apiProtocol: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(explicitConfig));

    const config = loadConfig();

    expect(config.apiProtocol).toBe('anthropic');
  });

  it('preserves saved settings when migration sees a malformed base URL', () => {
    const legacyConfig: Partial<AppConfig> = {
      mode: 'api',
      apiKey: 'sk-test',
      baseUrl: 'https://[broken-ipv6',
      model: 'custom-model',
      agentId: null,
      skillId: null,
      designSystemId: null,
    };
    store.set('readable-studio:config', JSON.stringify(legacyConfig));

    const config = loadConfig();

    expect(config.mode).toBe('api');
    expect(config.apiKey).toBe('sk-test');
    expect(config.baseUrl).toBe('https://[broken-ipv6');
    expect(config.model).toBe('custom-model');
    expect(config.apiProtocol).toBe('anthropic');
  });

  it('preserves a valid saved accent color', () => {
    const savedConfig: Partial<AppConfig> = {
      theme: 'dark',
      accentColor: '#4F46E5',
    };
    store.set('readable-studio:config', JSON.stringify(savedConfig));

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    expect(config.accentColorMode).toBe('custom');
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('loads valid named themes and falls back for invalid themes', () => {
    const named = THEME_OPTIONS.find((option) => option.id === 'dracula')!;
    store.set('readable-studio:config', JSON.stringify({ theme: named.id }));

    expect(loadConfig().theme).toBe(named.id);

    store.set('readable-studio:config', JSON.stringify({ theme: 'neon' }));

    expect(loadConfig().theme).toBe('system');
  });

  it('falls back to the default accent color for malformed saved colors', () => {
    const savedConfig: Partial<AppConfig> = {
      accentColor: 'blue',
    };
    store.set('readable-studio:config', JSON.stringify(savedConfig));

    const config = loadConfig();
    expect(config.accentColorMode).toBe('theme');
    expect(config.accentColor).toBe(DEFAULT_CONFIG.accentColor);
  });

  it('keeps legacy default and missing accent colors in theme accent mode', () => {
    store.set(
      'readable-studio:config',
      JSON.stringify({ accentColor: DEFAULT_CONFIG.accentColor }),
    );

    expect(loadConfig().accentColorMode).toBe('theme');

    store.set('readable-studio:config', JSON.stringify({}));

    expect(loadConfig().accentColorMode).toBe('theme');
  });

  it('returns defaults for malformed localStorage JSON', () => {
    store.set('readable-studio:config', '{broken-json');

    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('sets an explicit apiProtocol for new default configs', () => {
    expect(DEFAULT_CONFIG.apiProtocol).toBe('anthropic');
    expect(DEFAULT_CONFIG.configMigrationVersion).toBe(1);
    expect(DEFAULT_CONFIG.accentColor).toBe('#c96442');
  });
});

describe('saveConfig', () => {
  it('keeps daemon-owned privacy fields out of localStorage', () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      installationId: 'install-1',
      privacyDecisionAt: 1778244000000,
      telemetry: { metrics: true },
    });

    const saved = JSON.parse(store.get('readable-studio:config') ?? '{}');
    expect(saved.installationId).toBeUndefined();
    expect(saved.privacyDecisionAt).toBeUndefined();
    expect(saved.telemetry).toBeUndefined();
  });

  it('keeps proxy API key env values out of localStorage while preserving non-secret env', () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      agentCliEnv: {
        claude: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
          CLAUDE_CONFIG_DIR: '~/.claude-2',
        },
        codex: {
          CODEX_API_KEY: 'sk-codex',
          OPENAI_API_KEY: 'sk-openai',
          OPENAI_BASE_URL: 'https://proxy.example/openai',
          CODEX_HOME: '~/.codex-alt',
        },
      },
    });

    const saved = JSON.parse(store.get('readable-studio:config') ?? '{}');
    expect(saved.agentCliEnv.claude).toEqual({
      ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      CLAUDE_CONFIG_DIR: '~/.claude-2',
    });
    expect(saved.agentCliEnv.codex).toEqual({
      OPENAI_BASE_URL: 'https://proxy.example/openai',
      CODEX_HOME: '~/.codex-alt',
    });
  });
});
