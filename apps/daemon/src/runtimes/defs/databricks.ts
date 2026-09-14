import type { DatabricksEndpointApi } from '@readable-studio/contracts';
import type { DatabricksService } from '../../databricks/service.js';
import { rememberLiveModels } from '../models.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

export type DatabricksRuntimeService = Pick<DatabricksService, 'status' | 'listModels' | 'resolveRuntime'>;
let boundService: DatabricksRuntimeService | undefined;

/** Bind the namespace's scanner service at daemon composition time. No discovery at import time. */
export function configureDatabricksRuntime(service: DatabricksRuntimeService): void {
  boundService = service;
  rememberLiveModels('databricks', []);
}

export function getDatabricksRuntimeService(): DatabricksRuntimeService {
  if (!boundService) throw new Error('Databricks runtime service is not configured');
  return boundService;
}

export function databricksReasoningLevels(api: DatabricksEndpointApi, configured: string[] = []): string[] {
  if (configured.length) return configured;
  return api === 'anthropic-messages' ? ['high', 'xhigh']
    : api === 'openai-completions' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] : [];
}

export async function registeredDatabricksModels(service: DatabricksRuntimeService): Promise<RuntimeModelOption[]> {
  const catalogue = await service.listModels();
  return catalogue.models.map((endpoint) => ({
    id: endpoint.appModelId,
    label: endpoint.label,
    source: 'databricks',
    connectionId: endpoint.profileId,
    endpointId: endpoint.id,
    availability: endpoint.availability,
    reasoningOptions: endpoint.reasoningOptions ?? databricksReasoningLevels(endpoint.api).map((id) => ({ id, label: id })),
    capabilities: endpoint.capabilities,
  }));
}

export function createDatabricksAgentDef(
  service: () => DatabricksRuntimeService = getDatabricksRuntimeService,
): RuntimeAgentDef {
  return {
    id: 'databricks', name: 'Databricks', bin: 'databricks', versionArgs: ['--version'],
    fallbackModels: [], supportsCustomModel: false,
    modelSelectionRequired: true, modelManagement: 'databricks',
    reasoningOptions: [], promptViaStdin: true, streamFormat: 'pi-rpc', supportsImagePaths: true,
    installUrl: 'https://docs.databricks.com/dev-tools/cli/install.html',
    docsUrl: 'https://docs.databricks.com/dev-tools/cli/authentication.html',
    fetchModels: async () => registeredDatabricksModels(service()),
    detect: async () => {
      const owner = service();
      const [status, models] = await Promise.all([owner.status(), registeredDatabricksModels(owner)]);
      rememberLiveModels('databricks', models);
      // The execution harness ships in the app; CLI/auth are setup state only.
      return {
        available: true,
        models, modelsSource: 'live', version: status.version,
        authStatus: status.auth === 'authenticated' ? 'ok' : status.setupRequired || status.auth === 'auth-required' ? 'missing' : 'unknown',
      };
    },
    // A bare CLI invocation cannot carry a relay lifetime or private configuration.
    // The launch owner must use createDatabricksPiRuntime, which revalidates registration.
    buildArgs: () => { throw new Error('Databricks requires a managed runtime invocation'); },
  };
}

export const databricksAgentDef = createDatabricksAgentDef();
