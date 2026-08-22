import {
  KNOWN_PROVIDERS,
  type KnownProvider,
} from './config';
import { resolveFixedOriginBaseUrl } from './apiProtocols';
import type { ApiProtocol, ApiProtocolConfig, AppConfig } from '../types';

function defaultApiProtocolConfig(protocol: ApiProtocol): ApiProtocolConfig {
  const provider = KNOWN_PROVIDERS.find((p) => p.protocol === protocol);
  return {
    apiKey: '',
    baseUrl: provider?.baseUrl ?? '',
    model: provider?.model ?? '',
    apiVersion: '',
    apiProviderBaseUrl: provider ? provider.baseUrl : null,
  };
}

function providerFamilyLabel(provider: KnownProvider): string {
  return provider.label.replace(/\s+—\s+(Anthropic|OpenAI)$/u, '');
}

function siblingProviderForProtocol(
  providerBaseUrl: string | null | undefined,
  protocol: ApiProtocol,
): KnownProvider | null {
  if (!providerBaseUrl) return null;
  const currentProvider = KNOWN_PROVIDERS.find(
    (p) => p.baseUrl === providerBaseUrl,
  );
  if (!currentProvider) return null;

  const currentFamily = providerFamilyLabel(currentProvider);
  return (
    KNOWN_PROVIDERS.find(
      (p) => p.protocol === protocol && providerFamilyLabel(p) === currentFamily,
    ) ?? null
  );
}

function currentApiProtocolConfig(config: AppConfig): ApiProtocolConfig {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    apiVersion: config.apiVersion ?? '',
    apiProviderBaseUrl: config.apiProviderBaseUrl ?? null,
  };
}

function nextApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
): ApiProtocolConfig {
  const savedConfig = config.apiProtocolConfigs?.[protocol];
  if (savedConfig) return savedConfig;

  const currentConfig = currentApiProtocolConfig(config);
  const siblingProvider = siblingProviderForProtocol(
    currentConfig.apiProviderBaseUrl,
    protocol,
  );
  if (siblingProvider) {
    return {
      ...defaultApiProtocolConfig(protocol),
      baseUrl: siblingProvider.baseUrl,
      model: siblingProvider.model,
      apiProviderBaseUrl: siblingProvider.baseUrl,
    };
  }

  if (currentConfig.apiProviderBaseUrl === null) {
    return {
      ...currentConfig,
      apiKey: '',
      apiVersion: protocol === 'azure' ? currentConfig.apiVersion : '',
      apiProviderBaseUrl: null,
    };
  }

  return {
    ...defaultApiProtocolConfig(protocol),
  };
}

function applyApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
  apiConfig: ApiProtocolConfig,
): AppConfig {
  return {
    ...config,
    apiProtocol: protocol,
    apiKey: apiConfig.apiKey,
    baseUrl: resolveFixedOriginBaseUrl(protocol, apiConfig.baseUrl),
    model: apiConfig.model,
    apiProviderBaseUrl: apiConfig.apiProviderBaseUrl ?? null,
    apiVersion: protocol === 'azure' ? (apiConfig.apiVersion ?? '') : '',
  };
}

export function updateCurrentApiProtocolConfig(
  config: AppConfig,
  patch: Partial<ApiProtocolConfig>,
): AppConfig {
  const protocol = config.apiProtocol ?? 'anthropic';
  const nextApiConfig: ApiProtocolConfig = {
    ...currentApiProtocolConfig(config),
    ...patch,
  };
  return applyApiProtocolConfig(
    {
      ...config,
      apiProtocolConfigs: {
        ...(config.apiProtocolConfigs ?? {}),
        [protocol]: nextApiConfig,
      },
    },
    protocol,
    nextApiConfig,
  );
}

export function switchApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
): AppConfig {
  const currentProtocol = config.apiProtocol ?? 'anthropic';
  const apiProtocolConfigs = {
    ...(config.apiProtocolConfigs ?? {}),
    [currentProtocol]: currentApiProtocolConfig(config),
  };
  const nextApiConfig = nextApiProtocolConfig(
    {
      ...config,
      apiProtocolConfigs,
    },
    protocol,
  );
  return applyApiProtocolConfig(
    {
      ...config,
      mode: 'api',
      apiProtocolConfigs,
    },
    protocol,
    nextApiConfig,
  );
}
