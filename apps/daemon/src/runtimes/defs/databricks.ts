import type { DatabricksEndpointApi } from '@readable-studio/contracts';
import type { DatabricksService } from '../../databricks/service.js';
import { rememberLiveModels } from '../models.js';
import type { AgentDiagnostic, RuntimeAgentDef, RuntimeModelOption } from '../types.js';

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
    docsUrl: 'https://docs.databricks.com/dev-tools/cli/authentication.html',
    fetchModels: async () => registeredDatabricksModels(service()),
    detect: async () => {
      const owner = service();
      const [status, models] = await Promise.all([owner.status(), registeredDatabricksModels(owner)]);
      rememberLiveModels('databricks', models);
      // Binary availability and Readable's model registration are separate facts.
      const diagnostics: AgentDiagnostic[] = [];
      if (status.cli !== 'ready') diagnostics.push({
        reason: 'not-executable', severity: 'error',
        message: 'The bundled Databricks CLI is missing or unusable. Repair the Readable Studio package, then rescan.',
        fixActions: [{ kind: 'rescan' }],
      });
      if (models.length === 0) diagnostics.push({
        reason: 'auth-unknown', severity: 'warning',
        message: 'No Databricks models are configured in Readable Studio. Configure a workspace and register models in Databricks settings.',
        fixActions: [{ kind: 'openDocs' }, { kind: 'rescan' }],
      });
      return {
        available: status.cli === 'ready' || models.length > 0,
        models, modelsSource: 'live', version: status.version, diagnostics,
        authStatus: status.auth === 'authenticated' ? 'ok' : status.setupRequired || status.auth === 'auth-required' ? 'missing' : 'unknown',
      };
    },
    // A bare CLI invocation cannot carry a relay lifetime or private configuration.
    // The launch owner must use createDatabricksPiRuntime, which revalidates registration.
    buildArgs: () => { throw new Error('Databricks requires a managed runtime invocation'); },
  };
}

export const databricksAgentDef = createDatabricksAgentDef();
