import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabricksRuntimeResolution } from '../databricks/service.js';
import { effectiveDatabricksLimits } from '../databricks/capabilities.js';
import { createDatabricksRelay, type DatabricksRelay } from '../databricks/relay.js';
import { DatabricksRuntimeError } from '../databricks/failure.js';
import { attachPiRpcSession, type PiRpcSession } from '../pi-rpc.js';
import { getDatabricksRuntimeService, type DatabricksRuntimeService } from './defs/databricks.js';
import { databricksChildEnv } from './env.js';
import { resolvePiEntrypoint } from './pi-package.js';

export interface DatabricksPiRuntimeOptions {
  /** Namespace-scoped daemon data root, never the project cwd or Pi's user home. */
  dataRoot: string;
  cwd: string;
  /** Owner-bound conversation/session identity. Hashed before use as a path. */
  sessionKey: string;
  model: string;
  reasoning?: string | null;
  service?: DatabricksRuntimeService;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface DatabricksPiInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  sessionDir: string;
}

export interface DatabricksPiRuntime {
  invocation: DatabricksPiInvocation;
  /** Revoke relay capability and remove run config after child quiescence; retain sessions. */
  close(): Promise<void>;
}

/** Provider configuration contains only the local capability and opaque selector. */
export function renderDatabricksPiProvider(
  runtime: Pick<DatabricksRuntimeResolution, 'api' | 'capabilities' | 'reasoningOptions'>,
  relay: Pick<DatabricksRelay, 'baseUrl' | 'capabilityKey' | 'modelAlias'>,
  reasoning?: string | null,
) {
  const anthropic = runtime.api === 'anthropic-messages';
  const supported = runtime.reasoningOptions;
  const thinking = reasoning || (supported.includes('high') ? 'high' : supported[0] ?? 'off');
  if (!supported.includes(thinking) && !(thinking === 'off' && !supported.length)) throw new DatabricksRuntimeError('configuration');
  // Explicit nulls disable Pi's built-in level fallbacks. Only advertised levels
  // get identity mappings, including native Anthropic xhigh and OpenAI effort.
  const thinkingLevelMap: Record<string, string | null> = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  for (const level of supported) thinkingLevelMap[level] = level;
  return {
    models: {
      providers: {
        databricks: {
          api: runtime.api, baseUrl: relay.baseUrl, apiKey: relay.capabilityKey, authHeader: true,
          models: [{
            id: relay.modelAlias, name: relay.modelAlias,
            reasoning: true,
            input: runtime.capabilities.images === 'supported' ? ['text', 'image'] : ['text'],
            // Pi's optional custom-model fields still resolve to 128K context and 16K output
            // in provider-composer.js. Keep unknown registered limits null for the daemon/UI,
            // but render the high, disclosed fallback instead of accepting those silent defaults.
            ...effectiveDatabricksLimits(runtime.capabilities),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap,
            ...(anthropic ? {
              compat: { forceAdaptiveThinking: true },
            } : {
              compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, maxTokensField: 'max_completion_tokens', supportsStore: false },
            }),
          }],
        },
      },
    },
    settings: {
      defaultProvider: 'databricks', defaultModel: relay.modelAlias, defaultThinkingLevel: thinking,
      enabledModels: [`databricks/${relay.modelAlias}`],
      retry: { enabled: false },
    },
  };
}

async function ownedDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  const canonical = await realpath(directory);
  const equal = process.platform === 'win32'
    ? canonical.toLowerCase() === path.resolve(directory).toLowerCase()
    : canonical === path.resolve(directory);
  if (stat.isSymbolicLink() || !equal) throw new Error('Databricks runtime directory must not traverse a link');
  return canonical;
}

/** Prepare a managed invocation. The caller owns spawn and must close this handle on every exit path. */
export async function createDatabricksPiRuntime(options: DatabricksPiRuntimeOptions): Promise<DatabricksPiRuntime> {
  if (!options.model || options.model === 'default') throw new Error('An explicit registered Databricks model is required');
  if (!path.isAbsolute(options.dataRoot) || !path.isAbsolute(options.cwd) || !options.sessionKey) throw new Error('Invalid Databricks runtime owner');
  const service = options.service ?? getDatabricksRuntimeService();
  // Authoritative launch-time check: a cached picker selection cannot resurrect a disabled model.
  const runtime = await service.resolveRuntime(options.model);
  let engine: ReturnType<typeof resolvePiEntrypoint>;
  try { engine = resolvePiEntrypoint(options.packageRoot); }
  catch { throw new DatabricksRuntimeError('runtime-unavailable'); }
  const root = await ownedDirectory(path.join(options.dataRoot, 'databricks', 'runtime'));
  const sessionId = createHash('sha256').update(options.sessionKey).digest('hex');
  const sessionDir = await ownedDirectory(path.join(options.dataRoot, 'databricks', 'sessions', sessionId));
  const runDir = await mkdtemp(path.join(root, 'run-'));
  let relay: DatabricksRelay | undefined;
  try {
    const agentDir = await ownedDirectory(path.join(runDir, 'agent'));
    const home = await ownedDirectory(path.join(runDir, 'home'));
    relay = await createDatabricksRelay({
      runtime,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
    const config = renderDatabricksPiProvider(runtime, relay, options.reasoning);
    await Promise.all([
      writeFile(path.join(agentDir, 'models.json'), JSON.stringify(config.models), { mode: 0o600, flag: 'wx' }),
      writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(config.settings), { mode: 0o600, flag: 'wx' }),
    ]);
    const invocation: DatabricksPiInvocation = {
      command: process.execPath,
      args: [engine.entrypoint, '--mode', 'rpc', '--provider', 'databricks', '--model', relay.modelAlias,
        '--thinking', config.settings.defaultThinkingLevel, '--session-dir', sessionDir,
        '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline'],
      cwd: options.cwd,
      env: {
        ...databricksChildEnv(options.env ?? process.env),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir,
      },
      agentDir, sessionDir,
    };
    let closing: Promise<void> | undefined;
    const ownedRelay = relay;
    return { invocation, close: () => closing ??= (async () => {
      try { await ownedRelay.close(); }
      finally { await rm(runDir, { recursive: true, force: true }); }
    })() };
  } catch (error) {
    try { await relay?.close(); }
    finally { await rm(runDir, { recursive: true, force: true }); }
    throw error;
  }
}

export type DatabricksPiSessionOptions = DatabricksPiRuntimeOptions & {
  prompt: string;
  send: Parameters<typeof attachPiRpcSession>[0]['send'];
  imagePaths?: string[];
  uploadRoot?: string;
  resumeSession?: Parameters<typeof attachPiRpcSession>[0]['resumeSession'];
};

/** Runnable surface for non-server owners; uses the same RPC transport as direct Pi. */
export async function startDatabricksPiSession(options: DatabricksPiSessionOptions): Promise<{
  child: ChildProcess;
  session: PiRpcSession;
  runtime: DatabricksPiRuntime;
  completed: Promise<void>;
}> {
  const runtime = await createDatabricksPiRuntime(options);
  try {
    const invocation = runtime.invocation;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    const session = attachPiRpcSession({
      child, prompt: options.prompt, send: options.send, cwd: invocation.cwd, sessionDir: invocation.sessionDir,
      model: options.model,
      ...(options.imagePaths !== undefined ? { imagePaths: options.imagePaths } : {}),
      ...(options.uploadRoot !== undefined ? { uploadRoot: options.uploadRoot } : {}),
      ...(options.resumeSession !== undefined ? { resumeSession: options.resumeSession } : {}),
    });
    const completed = session.waitForQuiescence().finally(() => runtime.close());
    // The caller observes completed; prevent unhandled rejection before it subscribes.
    void completed.catch(() => undefined);
    return { child, session, runtime, completed };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
