import { READABLE_STUDIO_PROJECT_LOCATION_ID } from '@readable-studio/contracts';
import type { AppConfigPrefs } from '@readable-studio/contracts';
import { isOpenAICompatible } from '../providers/openai-compatible';
import type {
  ApiProtocol,
  AppConfig,
  NotificationsConfig,
  PetConfig,
} from '../types';
import { resolveFixedOriginBaseUrl } from './apiProtocols';
import {
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from './appearance';
import { resolveThemeForStorage } from './themes';
import {
  DEFAULT_FAILURE_SOUND_ID,
  DEFAULT_SUCCESS_SOUND_ID,
} from '../utils/notifications';

const STORAGE_KEY = 'readable-studio:config';
const CONFIG_MIGRATION_VERSION = 1;

// Hatched out of the box, but tucked away — the user has to go through
// either the entry-view "adopt a pet" callout or Settings → Pets to
// summon them. Keeps the workspace quiet for first-run users.
// Both switches default off so first-run users are not greeted by a
// surprise sound or a permission prompt; they can opt in from Settings →
// Notifications when they want it.
export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  soundEnabled: false,
  successSoundId: DEFAULT_SUCCESS_SOUND_ID,
  failureSoundId: DEFAULT_FAILURE_SOUND_ID,
  desktopEnabled: false,
};

export const DEFAULT_PET: PetConfig = {
  adopted: false,
  enabled: false,
  petId: 'mochi',
  custom: {
    name: 'Buddy',
    glyph: '🦄',
    accent: '#c96442',
    greeting: 'Hi! I am here whenever you need me.',
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  // New configs should be explicit. loadConfig() still detects parsed legacy
  // saved configs that did not have this field and migrates those from their
  // saved baseUrl/model before applying the current migration version.
  apiProtocol: 'anthropic',
  apiVersion: '',
  apiProtocolConfigs: {},
  configMigrationVersion: CONFIG_MIGRATION_VERSION,
  apiProviderBaseUrl: 'https://api.anthropic.com',
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: false,
  theme: 'system',
  accentColorMode: 'theme',
  accentColor: DEFAULT_ACCENT_COLOR,
  agentModels: {},
  agentCliEnv: {},
  pet: DEFAULT_PET,
  notifications: DEFAULT_NOTIFICATIONS,
  projectLocations: [],
  defaultProjectLocationId: READABLE_STUDIO_PROJECT_LOCATION_ID,
  enabledAgentIds: ['codex', 'cursor-agent'],
  // Corporate fork policy: telemetry is off by default. Runtime sinks are
  // disabled separately so old daemon configs with opted-in prefs cannot
  // re-enable network egress.
  telemetry: { metrics: false, content: false },
};

/** Well-known providers with pre-filled base URLs. */
export interface KnownProvider {
  label: string;
  protocol: ApiProtocol;
  baseUrl: string;
  /** Default model to apply when the provider is selected. */
  model: string;
  /** Optional provider-specific model choices shown in Settings. */
  models?: string[];
  /** Some local/self-hosted endpoints do not require bearer credentials. */
  requiresApiKey?: boolean;
}

// Some providers appear more than once because they expose both
// Anthropic-compatible (/v1/messages) and OpenAI-compatible
// (/v1/chat/completions) gateways. Keep those entries separate so the Settings
// UI can scope quick-fill presets and model suggestions to the selected
// protocol.
//
// Model lists are hand-curated from provider docs/current public presets rather
// than fetched dynamically. To add a provider, include a user-facing label, the
// protocol that determines request routing, the base URL, a default model, and
// optional provider-specific model choices.
export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    label: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
  },
  {
    label: 'DeepSeek — Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    models: [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ],
  },
  {
    label: 'MiniMax — Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.7-highspeed',
    models: [
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2',
    ],
  },
  {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  {
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.7-sonnet',
    models: [
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'openai/gpt-4o',
      'openai/o3-mini',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-r1',
    ],
  },
  {
    label: 'Azure OpenAI',
    protocol: 'azure',
    baseUrl: '',
    model: '',
    models: [],
  },
  {
    label: 'Google Gemini',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    label: 'DeepSeek — OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ],
  },
  {
    label: 'MiniMax — OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M2.7-highspeed',
    models: [
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2',
    ],
  },
  {
    label: 'MiMo (Xiaomi) — OpenAI',
    protocol: 'openai',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro'],
  },
  {
    label: 'Ollama Cloud (managed)',
    protocol: 'ollama',
    baseUrl: 'https://ollama.com',
    model: 'gpt-oss:120b',
    models: [
      'cogito-2.1:671b',
      'deepseek-v3.1:671b',
      'deepseek-v3.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'devstral-2:123b',
      'devstral-small-2:24b',
      'gemini-3-flash-preview',
      'gemma3:4b',
      'gemma3:12b',
      'gemma3:27b',
      'gemma4:31b',
      'glm-4.6',
      'glm-4.7',
      'glm-5',
      'glm-5.1',
      'gpt-oss:20b',
      'gpt-oss:120b',
      'kimi-k2:1t',
      'kimi-k2-thinking',
      'kimi-k2.5',
      'kimi-k2.6',
      'minimax-m2',
      'minimax-m2.1',
      'minimax-m2.5',
      'minimax-m2.7',
      'ministral-3:3b',
      'ministral-3:8b',
      'ministral-3:14b',
      'mistral-large-3:675b',
      'nemotron-3-nano:30b',
      'nemotron-3-super',
      'qwen3-coder:480b',
      'qwen3-coder-next',
      'qwen3-next:80b',
      'qwen3-vl:235b',
      'qwen3-vl:235b-instruct',
      'qwen3.5:397b',
      'rnj-1:8b',
    ],
  },
  {
    label: 'Ollama Self-hosted (local)',
    protocol: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:4b',
    models: ['gemma3:4b', 'gemma3:12b', 'gemma3:27b', 'gpt-oss:20b'],
    requiresApiKey: false,
  },
  {
    label: 'MiMo (Xiaomi) — Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    model: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro'],
  },
  {
    label: 'SenseAudio',
    protocol: 'senseaudio',
    baseUrl: 'https://api.senseaudio.cn',
    model: 'senseaudio-s2',
    models: [
      'senseaudio-s2',
      'senseaudio-s2-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.1',
      'kimi-k2.6',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
    ],
  },
  {
    label: 'AIHubMix',
    protocol: 'aihubmix',
    baseUrl: 'https://aihubmix.com/v1',
    model: 'gpt-5.5',
    models: [
      'gpt-5.5',
      'gpt-4o',
      'gpt-4o-mini',
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'gemini-2.0-flash',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },
];

function normalizePet(input: Partial<PetConfig> | undefined): PetConfig {
  if (!input) return { ...DEFAULT_PET, custom: { ...DEFAULT_PET.custom } };
  // Merge stored values onto defaults so newly-added fields land safely
  // when an older config is rehydrated.
  return {
    ...DEFAULT_PET,
    ...input,
    custom: { ...DEFAULT_PET.custom, ...(input.custom ?? {}) },
  };
}

function normalizeNotifications(
  input: Partial<NotificationsConfig> | undefined,
): NotificationsConfig {
  return { ...DEFAULT_NOTIFICATIONS, ...(input ?? {}) };
}

function inferApiProtocol(model: string, baseUrl: string): ApiProtocol {
  try {
    const normalized = (baseUrl || '').toLowerCase();
    // Any config pointing at ollama.com should resolve to the new ollama
    // protocol so both chat and the connection test hit the native Ollama
    // proxy instead of the Anthropic or OpenAI paths.
    if (normalized.includes('ollama.com')) return 'ollama';
    // SenseAudio host gets routed to its own proxy so the daemon log line
    // and the BYOK tab UI stay consistent with the protocol the user
    // picked — even though the on-wire shape is OpenAI-compatible.
    if (normalized.includes('senseaudio.cn')) return 'senseaudio';
    // AIHubMix host routes to its own proxy so the daemon injects the
    // APP-Code attribution header even though the wire shape is
    // OpenAI-compatible.
    if (normalized.includes('aihubmix.com')) return 'aihubmix';
    return isOpenAICompatible(model, baseUrl) ? 'openai' : 'anthropic';
  } catch {
    // Preserve the rest of the user's settings even if an old saved base URL is
    // malformed enough for URL parsing to throw. Anthropic is the safest default
    // because it matches the original built-in provider.
    return 'anthropic';
  }
}

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_CONFIG,
        pet: normalizePet(DEFAULT_PET),
        notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
      };
    }
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const parsedAccentColor = normalizeAccentColor(parsed.accentColor);
    const parsedAccentMode =
      parsed.accentColorMode === 'custom' ||
      parsed.accentColorMode === 'theme'
        ? parsed.accentColorMode
        : parsedAccentColor && parsedAccentColor !== DEFAULT_ACCENT_COLOR
          ? 'custom'
          : 'theme';
    // Strip daemon-owned privacy fields if a stale localStorage payload
    // still carries them. Older builds wrote these to localStorage; we
    // now treat the daemon as authoritative so the user can rotate /
    // revoke without leaving residue in browser storage.
    for (const key of DAEMON_OWNED_KEYS) {
      delete (parsed as Record<string, unknown>)[key];
    }
    const parsedHasApiProtocol = Object.prototype.hasOwnProperty.call(
      parsed,
      'apiProtocol',
    );
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      apiProtocolConfigs: { ...(parsed.apiProtocolConfigs ?? {}) },
      agentModels: { ...(parsed.agentModels ?? {}) },
      agentCliEnv: { ...(parsed.agentCliEnv ?? {}) },
      theme: resolveThemeForStorage(parsed.theme),
      accentColorMode: parsedAccentMode,
      accentColor: parsedAccentColor ?? DEFAULT_CONFIG.accentColor,
      pet: normalizePet(parsed.pet),
      notifications: normalizeNotifications(parsed.notifications),
    };

    if (parsed.configMigrationVersion !== CONFIG_MIGRATION_VERSION) {
      // Migration v1: configs saved before apiProtocol existed need an explicit
      // protocol so old OpenAI-compatible endpoints keep routing correctly.
      // This is version-gated instead of only field-gated so a later imported
      // legacy config can be migrated when it is loaded.
      if (!parsedHasApiProtocol) {
        merged.apiProtocol = inferApiProtocol(merged.model, merged.baseUrl);
        // Ollama Cloud legacy configs may carry a base URL that includes
        // /api or /api/ — normalize to the host root so the daemon's own
        // /api/chat appending doesn't double up.
        if (merged.apiProtocol === 'ollama') {
          merged.baseUrl = merged.baseUrl
            .replace(/\/api\/?$/, '')
            .replace(/\/+$/, '');
        }
        // Also set apiProviderBaseUrl so setApiProtocol() can correctly identify
        // whether the user is on a known provider and switch defaults appropriately.
        // null means "custom/unknown provider" so the protocol switch won't override
        // their custom base URL.
        const knownProvider = KNOWN_PROVIDERS.find(
          (p) => p.baseUrl === merged.baseUrl,
        );
        merged.apiProviderBaseUrl = knownProvider?.baseUrl ?? null;
      }
      merged.configMigrationVersion = CONFIG_MIGRATION_VERSION;
    }

    // Fixed-origin gateways (e.g. AIHubMix) hide the Base URL field, so a config
    // persisted before the origin was auto-resolved can carry an empty baseUrl.
    // Backfill it here so every consumer (Settings form, top-bar switcher, chat)
    // sees the canonical origin — an empty value otherwise blocks the live
    // model-list fetch and leaves only the static suggestion list.
    if (merged.apiProtocol) {
      merged.baseUrl = resolveFixedOriginBaseUrl(merged.apiProtocol, merged.baseUrl);
    }

    return merged;
  } catch {
    return {
      ...DEFAULT_CONFIG,
      pet: normalizePet(DEFAULT_PET),
      notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
    };
  }
}

// Privacy-sensitive fields the user can revoke. We deliberately keep
// these out of localStorage so the daemon remains the single source of
// truth: clearing app-config.json (or rotating via "Delete my data")
// fully resets the install identity, with no residual cohort key
// silently sitting in browser storage where the user can't see it.
const DAEMON_OWNED_KEYS = new Set<keyof AppConfig>([
  'installationId',
  'telemetry',
  'privacyDecisionAt',
]);

const AGENT_CLI_SECRET_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY']);

function sanitizeAgentCliEnv(agentCliEnv: AppConfig['agentCliEnv']): AppConfig['agentCliEnv'] {
  if (!agentCliEnv) return agentCliEnv;
  const sanitized: NonNullable<AppConfig['agentCliEnv']> = {};
  for (const [agentId, env] of Object.entries(agentCliEnv)) {
    const safeEnv = Object.fromEntries(
      Object.entries(env ?? {}).filter(([key]) => !AGENT_CLI_SECRET_ENV_KEYS.has(key)),
    );
    sanitized[agentId] = safeEnv;
  }
  return sanitized;
}

export function saveConfig(config: AppConfig): void {
  const sanitized: AppConfig = { ...config, agentCliEnv: sanitizeAgentCliEnv(config.agentCliEnv) };
  for (const key of DAEMON_OWNED_KEYS) {
    delete (sanitized as unknown as Record<string, unknown>)[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

export function mergeDaemonConfig(
  localConfig: AppConfig,
  daemonConfig: AppConfigPrefs | null,
): AppConfig {
  const next = { ...localConfig };
  if (!daemonConfig) return next;

  if (daemonConfig.onboardingCompleted != null) {
    next.onboardingCompleted = daemonConfig.onboardingCompleted;
  }
  if (daemonConfig.agentId !== undefined) {
    next.agentId = daemonConfig.agentId;
  }
  if (daemonConfig.skillId !== undefined) {
    next.skillId = daemonConfig.skillId;
  }
  if (daemonConfig.designSystemId !== undefined) {
    next.designSystemId = daemonConfig.designSystemId;
  }
  if (daemonConfig.agentModels) {
    next.agentModels = {
      ...(next.agentModels ?? {}),
      ...daemonConfig.agentModels,
    };
  }
  next.agentCliEnv = daemonConfig.agentCliEnv ?? {};
  if (daemonConfig.disabledSkills !== undefined) {
    next.disabledSkills = daemonConfig.disabledSkills;
  }
  if (daemonConfig.disabledDesignSystems !== undefined) {
    next.disabledDesignSystems = daemonConfig.disabledDesignSystems;
  }
  if (daemonConfig.installationId !== undefined) {
    next.installationId = daemonConfig.installationId;
  }
  if (daemonConfig.telemetry !== undefined) {
    next.telemetry = { ...daemonConfig.telemetry };
  }
  if (daemonConfig.privacyDecisionAt !== undefined) {
    next.privacyDecisionAt = daemonConfig.privacyDecisionAt;
  } else if (
    daemonConfig.installationId !== undefined ||
    daemonConfig.telemetry !== undefined
  ) {
    // One-shot migration for configs created before privacyDecisionAt
    // existed. If the daemon already has an id or telemetry prefs, the user
    // has resolved the first-run prompt and should not see it again.
    next.privacyDecisionAt = Date.now();
  }
  if (daemonConfig.customInstructions !== undefined) {
    next.customInstructions = daemonConfig.customInstructions ?? undefined;
  }
  if (daemonConfig.projectLocations !== undefined) {
    next.projectLocations = daemonConfig.projectLocations;
  }
  if (daemonConfig.defaultProjectLocationId !== undefined) {
    next.defaultProjectLocationId = daemonConfig.defaultProjectLocationId ?? READABLE_STUDIO_PROJECT_LOCATION_ID;
  }
  if (daemonConfig.enabledAgentIds !== undefined) {
    next.enabledAgentIds = daemonConfig.enabledAgentIds;
  }
  return next;
}

export async function fetchDaemonConfig(): Promise<AppConfigPrefs | null> {
  try {
    const res = await fetch('/api/app-config');
    if (!res.ok) return null;
    const data = await res.json();
    return data?.config ?? null;
  } catch {
    return null;
  }
}

export async function syncConfigToDaemon(
  config: AppConfig,
  options?: { throwOnError?: boolean },
): Promise<void> {
  const prefs: AppConfigPrefs = {
    onboardingCompleted: config.onboardingCompleted,
    agentId: config.agentId,
    agentModels: config.agentModels,
    agentCliEnv: config.agentCliEnv,
    skillId: config.skillId,
    designSystemId: config.designSystemId,
    disabledSkills: config.disabledSkills,
    disabledDesignSystems: config.disabledDesignSystems,
    installationId: config.installationId,
    telemetry: config.telemetry,
    privacyDecisionAt: config.privacyDecisionAt,
    customInstructions: config.customInstructions ?? null,
    projectLocations: config.projectLocations ?? [],
    defaultProjectLocationId: config.defaultProjectLocationId ?? READABLE_STUDIO_PROJECT_LOCATION_ID,
    enabledAgentIds: config.enabledAgentIds,
  };
  try {
    const response = await fetch('/api/app-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    if (!response.ok) throw new Error(`Failed to sync app config (${response.status})`);
  } catch (error) {
    if (options?.throwOnError) throw error;
    // Daemon offline; localStorage keeps the user's copy for the next save.
  }
}
