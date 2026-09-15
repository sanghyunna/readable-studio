import { detectAcpModels, DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const kimiAgentDef = {
    id: 'kimi',
    name: 'Kimi CLI',
    bin: 'kimi',
    versionArgs: ['--version'],
    // ACP session/new validates the same protocol used for execution and gates on auth.
    modelDiscovery: 'authenticated-session',
    fetchModels: async (resolvedBin, env) =>
      detectAcpModels({
        bin: resolvedBin,
        args: ['acp'],
        env,
        timeoutMs: 15_000,
        defaultModelOption: DEFAULT_MODEL_OPTION,
      }),
    // Model selectors are CLI-configured aliases, not a Moonshot API catalogue.
    // Missing auth or failed ACP discovery must not invent selectable models.
    fallbackModels: [DEFAULT_MODEL_OPTION],
    buildArgs: () => ['acp'],
    streamFormat: 'acp-json-rpc',
    mcpDiscovery: 'mature-acp',
    externalMcpInjection: 'acp-merge',
} satisfies RuntimeAgentDef;
