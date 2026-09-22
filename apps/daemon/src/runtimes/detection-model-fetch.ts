import { execAgentFile } from './invocation.js';
import type { RuntimeAgentDef, RuntimeModelOption, RuntimeModelSource } from './types.js';

export type ModelDiscoveryFailure = {
  kind: 'auth-required' | 'adapter-incompatible' | 'discovery-failed' | 'unverified';
  message: string;
};

export type FetchedRuntimeModels = {
  readonly models: RuntimeModelOption[];
  readonly source: RuntimeModelSource;
  readonly failure?: ModelDiscoveryFailure;
};

// Classify output, but never expose raw CLI output: it can contain credentials.
export function discoveryFailure(error: unknown): ModelDiscoveryFailure {
  const err = error as { message?: unknown; stdout?: unknown; stderr?: unknown } | null;
  const text = [err?.message, err?.stdout, err?.stderr].filter((v) => typeof v === 'string').join('\n');
  if (/unknown (?:arguments?|options?)|unrecognized (?:arguments?|options?)|unexpected argument|invalid value .*(?:output-format|stream-json)/i.test(text)) {
    return { kind: 'adapter-incompatible', message: 'The adapter requested command arguments or an output format the installed CLI does not support. This is a Readable Studio compatibility gap, not a CLI setup problem.' };
  }
  if (/authentication required|not authenticated|not logged in|unauthenticated|unauthori[sz]ed|please (?:sign|log)[ -]?in|sign[ -]?in required|(?:missing|invalid|expired) (?:api[ _-]?key|credentials?|token)|credentials? (?:are )?(?:missing|required|invalid)/i.test(text)) {
    return { kind: 'auth-required', message: 'Sign-in required. Sign in with the CLI in a terminal, then rescan.' };
  }
  return { kind: 'discovery-failed', message: 'Live model discovery failed. Check the CLI configuration and connection, then rescan.' };
}

export function failedModels(failure: ModelDiscoveryFailure): FetchedRuntimeModels {
  return { models: [], source: 'fallback', failure };
}

export async function fetchModels(
  def: RuntimeAgentDef,
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<FetchedRuntimeModels> {
  try {
    let parsed: RuntimeModelOption[] | null;
    if (def.fetchModels) {
      parsed = await def.fetchModels(resolvedBin, env);
    } else if (def.listModels) {
      const { stdout, stderr } = await execAgentFile(resolvedBin, def.listModels.args, {
        env,
        timeout: def.listModels.timeoutMs ?? 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const failure = discoveryFailure({ stdout, stderr });
      if (failure.kind !== 'discovery-failed') return failedModels(failure);
      parsed = def.listModels.parse(String(stdout));
    } else {
      return failedModels({ kind: 'unverified', message: 'This adapter has no verified live model discovery. Static model hints are not selectable.' });
    }
    // Optional discovery (for example Claude's local routes) may be absent.
    // An empty CLI model listing is negative evidence, not optional discovery.
    if ((!parsed || parsed.length === 0) && !def.listModels && !def.modelSelectionRequired &&
        def.fallbackModels.some((model) => model.id !== 'default')) {
      return { models: def.fallbackModels, source: 'fallback' };
    }
    // Default is a synthetic routing sentinel, not evidence of a configured model.
    if (!parsed?.some((model) => model.id !== 'default')) {
      return failedModels({ kind: 'unverified', message: 'The CLI reported no models for this account. Check the CLI account and its model configuration, then rescan.' });
    }
    return { models: parsed.filter((model) => model.id !== 'default'), source: 'live' };
  } catch (error) {
    return failedModels(discoveryFailure(error));
  }
}
