import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  type HostedProviderCredential,
  validateHostedProviderCredential,
} from '../hosted-runtime-registry.js';
import { attachPiRpcSession } from '../pi-rpc.js';
import { createHostedPiRuntimeAdapter } from './hosted-pi-adapter.js';
import type { HostedPiDesignSystemTool } from './hosted-pi-runtime.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_CATALOGUE_ENTRIES = 512;
const MAX_CATALOGUE_VALUE_BYTES = 512;
const MAX_SESSION_REFERENCE_BYTES = 2 * 1024;

export type HostedPiTurnCapabilities = {
  readonly generation: number;
  readonly userKey: string;
  readonly runId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly brokerRoot: string;
  readonly sessionRoot: string;
  readonly uploadRoot: string;
  readonly modelCatalogue: readonly string[];
  readonly thinkingCatalogue: readonly string[];
  readonly designSystemId?: string | null;
};

export type HostedPiTurnInput = {
  readonly capabilities: HostedPiTurnCapabilities;
  /** Current lane credential. It is copied once, immediately before launch. */
  readonly credential: HostedProviderCredential | null;
  readonly prompt: string;
  readonly model: string;
  readonly thinking?: string | null;
  readonly sessionReference?: string | null;
  readonly imagePaths?: readonly string[];
  readonly signal: AbortSignal;
  readonly send: (channel: string, payload: Record<string, unknown>) => void;
};

export type HostedPiTurnTerminalValue = {
  readonly status: 'succeeded' | 'failed' | 'canceled';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type HostedPiTurnResult = {
  readonly value: HostedPiTurnTerminalValue;
  /** Opaque, owner-root-relative reference; never an absolute filesystem path. */
  readonly sessionReference: string;
};

export type HostedPiTurnErrorCode =
  | 'HOSTED_PI_CANCELED'
  | 'HOSTED_PI_INPUT_INVALID'
  | 'HOSTED_PI_SESSION_FAILED'
  | 'HOSTED_PI_START_FAILED'
  | 'HOSTED_PI_CLEANUP_FAILED';

export class HostedPiTurnError extends Error {
  readonly code: HostedPiTurnErrorCode;

  constructor(code: HostedPiTurnErrorCode, message: string) {
    super(message);
    this.name = 'HostedPiTurnError';
    this.code = code;
  }
}

type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type HostedPiTurnDependencies = {
  /** Process boundary seam; production always uses node:child_process spawn. */
  readonly spawnChild?: SpawnChild;
  /** Test/deployment seam; production resolves the pinned installed package. */
  readonly packageRoot?: string;
  /** Server composition seam for the exact hosted design-system read capability. */
  readonly designSystemTool?: HostedPiDesignSystemTool;
};

type ResolvedCapabilities = Omit<
  HostedPiTurnCapabilities,
  'modelCatalogue' | 'thinkingCatalogue' | 'designSystemId'
> & {
  readonly modelCatalogue: ReadonlySet<string>;
  readonly thinkingCatalogue: ReadonlySet<string>;
  readonly designSystemId: string | null;
};

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

/**
 * Execute one generation-bound hosted Pi turn through the existing adapter,
 * broker, and Pi RPC state machine. No child, carrier, credential, or root is
 * observable through the returned value.
 */
export async function startHostedPiTurn(
  input: HostedPiTurnInput,
  dependencies: HostedPiTurnDependencies = {},
): Promise<HostedPiTurnResult> {
  const capabilities = resolveCapabilities(input.capabilities);
  const request = resolveTurnRequest(input, capabilities);
  if (input.signal.aborted) {
    throw new HostedPiTurnError('HOSTED_PI_CANCELED', 'hosted Pi turn was canceled');
  }
  const packageRoot = dependencies.packageRoot
    ? exactDirectory(dependencies.packageRoot, 'package root')
    : null;
  if (
    packageRoot != null
    && [
      capabilities.projectRoot,
      capabilities.brokerRoot,
      capabilities.sessionRoot,
      capabilities.uploadRoot,
    ].some((root) => inside(root, packageRoot) || inside(packageRoot, root))
  ) invalidInput('hosted Pi package root must be isolated from mutable roots');

  const runtime = createHostedPiRuntimeAdapter({
    runtimeRoot: capabilities.brokerRoot,
    sessionRoot: capabilities.sessionRoot,
    ...(packageRoot ? { packageRoot } : {}),
    ...(dependencies.designSystemTool ? { designSystemTool: dependencies.designSystemTool } : {}),
  });
  const spawnChild = dependencies.spawnChild ?? defaultSpawnChild;
  let handle: Awaited<ReturnType<typeof runtime>> | null = null;
  let child: ChildProcess | null = null;
  let childClosed = false;
  let sessionAttached = false;
  let cancelRequested = false;
  let removeAbortListener = (): void => {};
  let outcome: HostedPiTurnResult | null = null;
  let failure: HostedPiTurnError | null = null;

  try {
    handle = await runtime({
      userKey: capabilities.userKey,
      runId: capabilities.runId,
      projectId: capabilities.projectId,
      projectRoot: capabilities.projectRoot,
      cwd: capabilities.projectRoot,
      generation: capabilities.generation,
      designSystemId: capabilities.designSystemId,
      ...(request.credential ? { credential: request.credential } : {}),
      model: request.model,
      thinking: request.thinking,
    });
    if (input.signal.aborted) {
      throw new HostedPiTurnError('HOSTED_PI_CANCELED', 'hosted Pi turn was canceled');
    }

    const invocation = handle.invocation;
    if ([
      capabilities.projectRoot,
      capabilities.brokerRoot,
      capabilities.sessionRoot,
      capabilities.uploadRoot,
    ].some((root) => inside(root, invocation.packageRoot) || inside(invocation.packageRoot, root))) {
      throw new HostedPiTurnError(
        'HOSTED_PI_START_FAILED',
        'hosted Pi package root is not isolated from mutable roots',
      );
    }
    child = spawnChild(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', () => {
      // Hosted stderr is deliberately consumed but never serialized: provider
      // and carrier material must not become a user-visible error channel.
    });

    let exit: ChildExit | null = null;
    child.once('close', (code, signal) => {
      childClosed = true;
      exit = { code, signal };
    });
    const sensitive = sensitiveValues(
      capabilities,
      request.credential,
      invocation.packageRoot,
      invocation.env,
    );
    const session = attachPiRpcSession({
      child,
      prompt: request.prompt,
      cwd: capabilities.projectRoot,
      sessionDir: invocation.sessionDir,
      model: request.model,
      imagePaths: request.imagePaths,
      uploadRoot: capabilities.uploadRoot,
      ...(request.resumePath
        ? { resumeSession: { path: request.resumePath, root: capabilities.sessionRoot } }
        : {}),
      send: (channel, payload) => {
        input.send(channel, redactRecord(payload, sensitive));
      },
    });
    sessionAttached = true;
    const onAbort = (): void => {
      if (childClosed) return;
      cancelRequested = true;
      session.abort();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => input.signal.removeEventListener('abort', onAbort);
    if (input.signal.aborted) onAbort();

    await session.waitForQuiescence();
    const sessionPath = session.getLastSessionPath();
    if (sessionPath == null || exit == null) {
      throw new HostedPiTurnError(
        'HOSTED_PI_SESSION_FAILED',
        'hosted Pi did not return a verified terminal session',
      );
    }
    const terminalExit = exit as ChildExit;
    const status = cancelRequested
      ? 'canceled'
      : terminalExit.code === 0
        ? 'succeeded'
        : 'failed';
    outcome = Object.freeze({
      sessionReference: sessionReferenceForPath(capabilities.sessionRoot, sessionPath),
      value: Object.freeze({
        exitCode: terminalExit.code,
        signal: terminalExit.signal,
        status,
      }),
    });
  } catch (error) {
    failure = safeTurnError(error, input.signal.aborted || cancelRequested, sessionAttached);
    if (child != null && !childClosed) {
      await stopUnattachedChild(child, () => childClosed);
    }
  }

  removeAbortListener();
  try {
    await handle?.close?.();
  } catch {
    failure = new HostedPiTurnError(
      'HOSTED_PI_CLEANUP_FAILED',
      'hosted Pi capability cleanup failed',
    );
  }

  if (failure != null) throw failure;
  if (outcome == null) {
    throw new HostedPiTurnError('HOSTED_PI_SESSION_FAILED', 'hosted Pi turn did not settle');
  }
  return outcome;
}

function defaultSpawnChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

async function stopUnattachedChild(
  child: ChildProcess,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try { child.kill('SIGTERM'); } catch { /* child may already be gone */ }
  if (await waitForClose(closed, 1_000)) return;
  try { child.kill('SIGKILL'); } catch { /* child may already be gone */ }
  await waitForClose(closed, 500);
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function resolveCapabilities(input: HostedPiTurnCapabilities): ResolvedCapabilities {
  validUserKey(input.userKey);
  validOpaqueId(input.runId, 'run id');
  validOpaqueId(input.projectId, 'project id');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    invalidInput('hosted Pi generation is invalid');
  }
  const projectRoot = exactDirectory(input.projectRoot, 'project root');
  const brokerRoot = exactDirectory(input.brokerRoot, 'broker root');
  const sessionRoot = exactDirectory(input.sessionRoot, 'session root');
  const uploadRoot = exactDirectory(input.uploadRoot, 'upload root');
  for (const ownedRoot of [brokerRoot, sessionRoot, uploadRoot]) {
    if (inside(projectRoot, ownedRoot) || inside(ownedRoot, projectRoot)) {
      invalidInput('hosted Pi owned roots must be isolated');
    }
  }
  if (
    samePath(brokerRoot, sessionRoot)
    || samePath(brokerRoot, uploadRoot)
    || samePath(sessionRoot, uploadRoot)
  ) {
    invalidInput('hosted Pi owned roots must be distinct');
  }
  return Object.freeze({
    generation: input.generation,
    userKey: input.userKey,
    runId: input.runId,
    projectId: input.projectId,
    projectRoot,
    brokerRoot,
    sessionRoot,
    uploadRoot,
    designSystemId: input.designSystemId ?? null,
    modelCatalogue: catalogue(input.modelCatalogue, 'model'),
    thinkingCatalogue: catalogue(input.thinkingCatalogue, 'thinking'),
  });
}

function resolveTurnRequest(
  input: HostedPiTurnInput,
  capabilities: ResolvedCapabilities,
): {
  credential: HostedProviderCredential | null;
  prompt: string;
  model: string;
  thinking: string | null;
  resumePath: string | null;
  imagePaths: string[];
} {
  if (
    typeof input.prompt !== 'string'
    || input.prompt.length === 0
    || input.prompt.includes('\0')
    || Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES
  ) invalidInput('hosted Pi prompt is invalid');
  if (!capabilities.modelCatalogue.has(input.model)) {
    invalidInput('hosted Pi model is outside the fixed catalogue');
  }
  const thinking = input.thinking ?? null;
  if (thinking != null && !capabilities.thinkingCatalogue.has(thinking)) {
    invalidInput('hosted Pi thinking level is outside the fixed catalogue');
  }
  const credential = input.credential == null
    ? null
    : validateHostedProviderCredential(input.credential);
  return {
    credential,
    prompt: input.prompt,
    model: input.model,
    thinking,
    resumePath: input.sessionReference
      ? pathForSessionReference(capabilities.sessionRoot, input.sessionReference)
      : null,
    imagePaths: resolveImagePaths(capabilities.uploadRoot, input.imagePaths ?? []),
  };
}

function catalogue(input: readonly string[], label: string): ReadonlySet<string> {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CATALOGUE_ENTRIES) {
    invalidInput(`hosted Pi ${label} catalogue is invalid`);
  }
  const values = new Set<string>();
  for (const value of input) {
    if (
      typeof value !== 'string'
      || value.length === 0
      || CONTROL_CHARS.test(value)
      || Buffer.byteLength(value, 'utf8') > MAX_CATALOGUE_VALUE_BYTES
    ) invalidInput(`hosted Pi ${label} catalogue is invalid`);
    values.add(value);
  }
  return values;
}

function resolveImagePaths(uploadRoot: string, input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > 10) invalidInput('hosted Pi image list is invalid');
  return input.map((candidate) => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      invalidInput('hosted Pi image path is invalid');
    }
    let resolved: string;
    try {
      const info = fs.lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not an owned file');
      resolved = fs.realpathSync(candidate);
    } catch {
      invalidInput('hosted Pi image path is invalid');
    }
    if (!samePath(resolved, path.resolve(candidate)) || !inside(uploadRoot, resolved)) {
      invalidInput('hosted Pi image path is outside the upload root');
    }
    return resolved;
  });
}

function pathForSessionReference(root: string, reference: string): string {
  const segments = sessionReferenceSegments(reference);
  const candidate = path.join(root, ...segments);
  let resolved: string;
  try {
    const info = fs.lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a session file');
    resolved = fs.realpathSync(candidate);
  } catch {
    invalidInput('hosted Pi session reference is unavailable');
  }
  if (!samePath(resolved, path.resolve(candidate)) || !inside(root, resolved)) {
    invalidInput('hosted Pi session reference is outside its owner root');
  }
  return resolved;
}

function sessionReferenceForPath(root: string, candidate: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new HostedPiTurnError(
      'HOSTED_PI_SESSION_FAILED',
      'hosted Pi terminal session is unavailable',
    );
  }
  if (!samePath(resolved, path.resolve(candidate)) || !inside(root, resolved)) {
    throw new HostedPiTurnError(
      'HOSTED_PI_SESSION_FAILED',
      'hosted Pi terminal session is outside its owner root',
    );
  }
  const reference = path.relative(root, resolved).split(path.sep).join('/');
  sessionReferenceSegments(reference);
  return reference;
}

function sessionReferenceSegments(reference: string): string[] {
  if (
    typeof reference !== 'string'
    || reference.length === 0
    || Buffer.byteLength(reference, 'utf8') > MAX_SESSION_REFERENCE_BYTES
    || CONTROL_CHARS.test(reference)
    || reference.startsWith('/')
    || /^[A-Za-z]:/u.test(reference)
  ) invalidInput('hosted Pi session reference is invalid');
  const segments = reference.replaceAll('\\', '/').split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || path.extname(segments.at(-1) ?? '').toLowerCase() !== '.jsonl'
  ) invalidInput('hosted Pi session reference is invalid');
  return segments;
}

function exactDirectory(input: string, label: string): string {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    invalidInput(`hosted Pi ${label} is invalid`);
  }
  try {
    const info = fs.lstatSync(input);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not an owned directory');
    const resolved = fs.realpathSync(input);
    if (!samePath(resolved, path.resolve(input))) throw new Error('linked directory');
    return resolved;
  } catch {
    invalidInput(`hosted Pi ${label} is unavailable`);
  }
}

function validUserKey(value: string): void {
  if (typeof value !== 'string') invalidInput('hosted Pi user key is invalid');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 1 || bytes.length > 1_024 || bytes.toString('utf8') !== value) {
    invalidInput('hosted Pi user key is invalid');
  }
}

function validOpaqueId(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || CONTROL_CHARS.test(value)
  ) invalidInput(`hosted Pi ${label} is invalid`);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sensitiveValues(
  capabilities: ResolvedCapabilities,
  credential: HostedProviderCredential | null,
  packageRoot: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return [...new Set([
    credential?.key,
    capabilities.projectRoot,
    capabilities.brokerRoot,
    capabilities.sessionRoot,
    capabilities.uploadRoot,
    packageRoot,
    env.READABLE_HOSTED_PI_BROKER_SOCKET,
    env.READABLE_HOSTED_PI_BROKER_TOKEN,
    env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL,
    env.READABLE_TOOL_TOKEN,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function redactRecord(
  input: Record<string, unknown>,
  sensitive: readonly string[],
): Record<string, unknown> {
  return redactValue(input, sensitive, 0) as Record<string, unknown>;
}

function redactValue(value: unknown, sensitive: readonly string[], depth: number): unknown {
  if (typeof value === 'string') {
    let redacted = value;
    for (const secret of sensitive) {
      redacted = replaceInsensitive(redacted, secret);
      const alternate = secret.includes('\\')
        ? secret.replaceAll('\\', '/')
        : secret.replaceAll('/', '\\');
      if (alternate !== secret) redacted = replaceInsensitive(redacted, alternate);
    }
    return redacted;
  }
  if (depth >= 12) return '[redacted]';
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, sensitive, depth + 1));
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactValue(item, sensitive, depth + 1),
    ]));
  }
  return value;
}

function replaceInsensitive(input: string, sensitive: string): string {
  const escaped = sensitive.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return input.replace(new RegExp(escaped, 'giu'), '[redacted]');
}

function safeTurnError(
  error: unknown,
  canceled: boolean,
  sessionAttached: boolean,
): HostedPiTurnError {
  if (error instanceof HostedPiTurnError) return error;
  if (canceled) {
    return new HostedPiTurnError('HOSTED_PI_CANCELED', 'hosted Pi turn was canceled');
  }
  return sessionAttached
    ? new HostedPiTurnError('HOSTED_PI_SESSION_FAILED', 'hosted Pi turn failed safely')
    : new HostedPiTurnError('HOSTED_PI_START_FAILED', 'hosted Pi could not start safely');
}

function invalidInput(message: string): never {
  throw new HostedPiTurnError('HOSTED_PI_INPUT_INVALID', message);
}
