import { execAgentFile } from './invocation.js';
import type { DiscoveryPolicy } from './detection-cache.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from './launch.js';
import { spawnEnvForAgent } from './env.js';
import { probeAgentAuthStatus } from './auth.js';
import { agentCapabilities } from './capabilities.js';
import { installMetaForAgent } from './metadata.js';
import {
  buildAuthDiagnostic,
  buildExecutableDiagnostic,
  buildNotInvocableDiagnostic,
  type NotInvocableCause,
} from './diagnostics.js';
import { discoveryFailure, failedModels, fetchModels, type ModelDiscoveryFailure } from './detection-model-fetch.js';
import type {
  AgentDiagnostic,
  DetectedAgent,
  RuntimeAgentDef,
  RuntimeCapabilityMap,
} from './types.js';

type VersionProbeOutcome =
  | { readonly kind: 'not-invocable'; readonly cause: NotInvocableCause }
  | { readonly kind: 'spawned'; readonly version: string | null };

async function probeVersionAtPath(
  def: RuntimeAgentDef,
  resolved: string,
  env: NodeJS.ProcessEnv,
): Promise<VersionProbeOutcome> {
  try {
    const { stdout } = await execAgentFile(resolved, def.versionArgs, {
      env,
      timeout: def.versionProbeTimeoutMs ?? 3000,
    });
    const version = String(stdout).trim().split('\n')[0] ?? null;
    return { kind: 'spawned', version };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string') {
      if (code === 'EACCES') {
        return { kind: 'not-invocable', cause: 'not-executable' };
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'not-invocable', cause: 'missing-target' };
      }
    } else if (typeof code === 'number' && (code === 126 || code === 127)) {
      return {
        kind: 'not-invocable',
        cause: code === 126 ? 'not-executable' : 'missing-target',
      };
    }
    return { kind: 'spawned', version: null };
  }
}

function unavailableAgent(
  def: RuntimeAgentDef,
  diagnostics: AgentDiagnostic[] = [],
): DetectedAgent {
  return {
    ...stripFns(def),
    models: [],
    modelsSource: 'fallback',
    available: false,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...installMetaForAgent(def.id),
  };
}

async function probeCapabilities(
  def: RuntimeAgentDef,
  launchPath: string,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeCapabilityMap | null> {
  if (!def.helpArgs || !def.capabilityFlags) return null;
  try {
    const { stdout } = await execAgentFile(launchPath, def.helpArgs, {
      env,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const caps: RuntimeCapabilityMap = {};
    for (const [flag, key] of Object.entries(def.capabilityFlags)) {
      caps[key] = String(stdout).includes(flag);
    }
    return caps;
  } catch {
    return {};
  }
}

/** Run preparation needs CLI flags, not authentication or model discovery. */
export async function ensureAgentCapabilities(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
): Promise<void> {
  if (!def.capabilityFlags || agentCapabilities.has(def.id)) return;
  const launch = resolveAgentLaunch(def, configuredEnv);
  if (!launch.selectedPath || !launch.launchPath) return;
  const env = applyAgentLaunchEnv(spawnEnvForAgent(
    def.id, { ...process.env, ...(def.env || {}) }, configuredEnv,
    undefined, { resolvedBin: launch.selectedPath },
  ), launch);
  const caps = await probeCapabilities(def, launch.launchPath, env);
  if (caps) agentCapabilities.set(def.id, caps);
}

export function stripFns(
  def: RuntimeAgentDef,
): Omit<DetectedAgent, 'models' | 'modelsSource' | 'available' | 'path' | 'version'> {
  const {
    buildArgs,
    listModels,
    fetchModels,
    fallbackModels,
    helpArgs,
    capabilityFlags,
    fallbackBins,
    versionProbeTimeoutMs,
    maxPromptArgBytes,
    env,
    authProbe,
    detect,
    modelDiscovery,
    compatibilityProbe,
    ...rest
  } = def;
  return rest;
}

export function shouldRunAgentNetworkDiscovery(
  policy: DiscoveryPolicy = 'online',
): boolean {
  return policy === 'online';
}

async function probe(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string>,
  policy: DiscoveryPolicy,
): Promise<DetectedAgent> {
  if (def.detect) {
    const managed = await def.detect();
    return { ...stripFns(def), ...managed, models: managed.available ? managed.models : [] };
  }
  const launch = resolveAgentLaunch(def, configuredEnv);
  if (!launch.selectedPath || !launch.launchPath) {
    return unavailableAgent(def, [buildExecutableDiagnostic(def, configuredEnv)]);
  }
  const probeEnv = applyAgentLaunchEnv(
    spawnEnvForAgent(
      def.id,
      {
        ...process.env,
        ...(def.env || {}),
      },
      configuredEnv,
      undefined,
      { resolvedBin: launch.selectedPath },
    ),
    launch,
  );
  const outcome = await probeVersionAtPath(def, launch.launchPath, probeEnv);
  if (outcome.kind === 'not-invocable') {
    return { ...unavailableAgent(def, [
      buildNotInvocableDiagnostic(def, launch, outcome.cause),
    ]), path: launch.selectedPath };
  }
  let compatibilityFailure: ModelDiscoveryFailure | undefined;
  const online = shouldRunAgentNetworkDiscovery(policy);
  if (online && def.compatibilityProbe) {
    try {
      await def.compatibilityProbe(launch.launchPath, probeEnv);
    } catch (error) {
      compatibilityFailure = discoveryFailure(error);
    }
  }
  const [caps, modelResult, auth] = online && !compatibilityFailure
    ? await Promise.all([
        probeCapabilities(def, launch.launchPath, probeEnv),
        fetchModels(def, launch.launchPath, probeEnv),
        probeAgentAuthStatus(def, launch.launchPath, probeEnv),
      ])
    : [null, failedModels(compatibilityFailure ?? {
        kind: 'unverified', message: 'Discovery is offline. Model usability has not been verified; rescan online.',
      }), null] as const;
  if (caps) agentCapabilities.set(def.id, caps);
  // Cursor supplies a live account catalogue and a separate status command,
  // rather than opening an ACP/app-server session. Both probes must succeed;
  // authentication alone must never override failed or empty model discovery.
  const failure = compatibilityFailure ?? modelResult.failure ?? (
    modelResult.source !== 'fallback' &&
    def.modelDiscovery !== 'authenticated-session' && auth?.status !== 'ok'
      ? { kind: 'unverified' as const, message: 'CLI is installed, but this adapter has not verified an authenticated execution session. Catalogue entries and static hints are not selectable.' }
      : undefined
  );
  const effectiveAuth = failure?.kind === 'auth-required'
    ? { status: 'missing' as const, message: failure.message }
    : auth;
  const authDiagnostic = effectiveAuth ? buildAuthDiagnostic(def, effectiveAuth) : null;
  const available = !failure && (!effectiveAuth || effectiveAuth.status === 'ok');
  // A conclusive sign-in failure remains actionable; unknown auth must not
  // hide a proven discovery/compatibility failure behind a warning.
  const diagnostics: AgentDiagnostic[] = authDiagnostic && (!failure || effectiveAuth?.status === 'missing') ? [authDiagnostic] : failure ? [{
    // Reuse the existing wire diagnostics: command rejection is not executable
    // through this adapter; unknown readiness must never imply authenticated.
    reason: failure.kind === 'adapter-incompatible' ? 'not-executable' : 'auth-unknown',
    severity: 'error',
    message: failure.message,
    fixActions: [{ kind: 'openDocs' }, { kind: 'rescan' }],
  }] : [];
  return {
    ...stripFns(def),
    models: available ? modelResult.models : [],
    modelsSource: modelResult.source,
    available,
    // path + available distinguish absent, installed-unusable, and usable
    // without a new wire contract or a second UI source of truth.
    path: launch.selectedPath,
    version: outcome.version,
    ...(effectiveAuth ? { authStatus: effectiveAuth.status, authMessage: effectiveAuth.message } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...installMetaForAgent(def.id),
  };
}

export async function safeProbe(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
  policy: DiscoveryPolicy = 'online',
): Promise<DetectedAgent> {
  try {
    return await probe(def, configuredEnv, policy);
  } catch {
    return unavailableAgent(def, [{
      reason: 'auth-unknown', severity: 'error',
      message: 'Agent detection failed before usability could be verified. Check the executable configuration, then rescan.',
      fixActions: [{ kind: 'rescan' }],
    }]);
  }
}
