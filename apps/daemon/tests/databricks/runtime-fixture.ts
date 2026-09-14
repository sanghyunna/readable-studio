import { readFileSync } from 'node:fs';
import type { DatabricksModelsResponse, DatabricksStatusResponse } from '@readable-studio/contracts';
import type { DatabricksRuntimeResolution } from '../../src/databricks/service.js';
import type { DatabricksRuntimeService } from '../../src/runtimes/defs/databricks.js';

export function protocolFixture(api: DatabricksRuntimeResolution['api']) {
  const filename = api === 'anthropic-messages' ? 'claude-messages.json' : 'luna-chat-completions.json';
  return JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')) as {
    request: { body: { model: string; messages: unknown[]; stream: boolean } & Record<string, unknown> };
    response: { status: number; body: Record<string, unknown> };
  };
}

export function runtimeFixture(api: DatabricksRuntimeResolution['api'] = 'anthropic-messages'): DatabricksRuntimeResolution {
  return {
    appModelId: 'dbm_opaque_model', endpointId: 'dbe_opaque_endpoint', profileId: 'dbc_opaque_profile',
    api, baseUrl: `https://workspace.example${api === 'anthropic-messages' ? '/ai-gateway/anthropic' : '/ai-gateway/openai/v1'}`,
    model: protocolFixture(api).request.body.model, apiKey: 'dapi_PRIVATE_BEARER_NEVER_IN_CHILD',
    compat: api === 'anthropic-messages' ? { forceAdaptiveThinking: true } : {},
    capabilities: { tools: 'supported', images: 'supported', contextWindow: 128000, maxTokens: 4096 },
    reasoningOptions: api === 'anthropic-messages' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh'],
  };
}

export function runtimeServiceFixture(runtime = runtimeFixture()): {
  service: DatabricksRuntimeService;
  catalogue: DatabricksModelsResponse;
  status: DatabricksStatusResponse;
} {
  const catalogue: DatabricksModelsResponse = { revision: 1, issues: [], models: [{
    id: runtime.endpointId, profileId: runtime.profileId, appModelId: runtime.appModelId,
    label: 'Registered endpoint', kind: 'uc-model-service', availability: 'compatible', api: runtime.api,
    enabled: true, capabilities: runtime.capabilities, evidence: 'verified',
    ...(runtime.reasoningOptions.length ? { reasoningOptions: runtime.reasoningOptions.map((id) => ({ id, label: id })) } : {}),
  }] };
  const status: DatabricksStatusResponse = { cli: 'ready', version: '0.282.0', auth: 'authenticated', profiles: [], enabledCount: 1, issues: [] };
  const service: DatabricksRuntimeService = {
    status: async () => status,
    listModels: async () => catalogue,
    resolveRuntime: async (model) => {
      if (!catalogue.models.some((entry) => entry.appModelId === model)) throw new Error('DATABRICKS_SCAN_EXPIRED');
      return runtime;
    },
  };
  return { service, catalogue, status };
}

export function fixtureStream(api: DatabricksRuntimeResolution['api']): string {
  if (api === 'anthropic-messages') return readFileSync(new URL('./fixtures/claude-messages-stream.txt', import.meta.url), 'utf8');
  const fixture = protocolFixture(api).response.body;
  const choices = fixture.choices as Array<{ index: number; message: unknown; finish_reason: string }>;
  return `data: ${JSON.stringify({ ...fixture, object: 'chat.completion.chunk', choices: choices.map((choice) => ({
    index: choice.index, delta: choice.message, finish_reason: choice.finish_reason,
  })) })}\n\ndata: [DONE]\n\n`;
}
