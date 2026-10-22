import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wellKnownUserToolchainBins } from '@readable-studio/platform';
import type { DatabricksCliState, DatabricksErrorCode, DatabricksIssue } from '@readable-studio/contracts';

interface DatabricksCliDiagnostic {
  category: 'timeout' | 'aborted' | 'spawn' | 'output-limit' | 'cli-exit';
  cause?: 'connection-closed' | 'tls' | 'http' | 'permission' | 'auth-config' | 'keyring' | 'network' | 'unsupported';
  elapsedMs?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  httpStatus?: number;
  nativeCode?: 'EACCES' | 'EPERM' | 'ENOENT' | 'ENOEXEC' | 'ENOMEM' | 'EMFILE' | 'ENFILE' | 'E2BIG' | 'ABORT_ERR' | 'ETIMEDOUT';
}

/** Deliberately contains no upstream message, cause, stdout, or stderr. */
export class DatabricksServiceError extends Error {
  constructor(public readonly code: DatabricksErrorCode, public readonly retryable = false, readonly diagnostic?: DatabricksCliDiagnostic) {
    super(code);
    this.name = 'DatabricksServiceError';
  }
}

export function issueFor(error: unknown): DatabricksIssue {
  const fault = error instanceof DatabricksServiceError ? error : new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  const action: DatabricksIssue['action'] = fault.code === 'DATABRICKS_CLI_MISSING' ? 'rescan'
    : fault.code === 'DATABRICKS_CLI_UNSUPPORTED' ? 'choose-executable'
    : fault.code === 'DATABRICKS_AUTH_REQUIRED' ? 'sign-in'
    : fault.code === 'DATABRICKS_PERMISSION_DENIED' ? 'check-permissions'
    : fault.code === 'DATABRICKS_VERIFICATION_REQUIRED' ? 'verify' : 'rescan';
  return { code: fault.code, retryable: fault.retryable, action };
}

/** Validate at both public and native-process boundaries; never retain the input in errors. */
export function databricksWorkspaceOrigin(host: unknown): string {
  if (typeof host !== 'string' || /[\s\\\x00-\x1f\x7f]/.test(host)) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
  let url: URL;
  try { url = new URL(host); } catch { throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED'); }
  if (url.protocol !== 'https:' || url.port || /^https:\/\/[^/]*:\d+/i.test(host) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
  }
  return url.origin;
}

/** Read config independently of CLI discovery, which may omit invalid profiles. */
export async function databricksLoginProfile(host: string, requested?: string, configFile = process.env.DATABRICKS_CONFIG_FILE ?? join(homedir(), '.databrickscfg')): Promise<string> {
  let config = '';
  try { config = await readFile(configFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE'); }
  const profiles = new Map<string, string>();
  let section = '';
  for (const line of config.split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { section = heading[1]!; profiles.set(section, ''); }
    const entry = /^\s*host\s*=\s*(\S+)\s*$/i.exec(line);
    if (entry && section) profiles.set(section, entry[1]!.replace(/\/$/, '').toLowerCase());
  }
  if (requested && (!profiles.has(requested) || profiles.get(requested) === host.toLowerCase())) return requested;
  const matching = [...profiles].find(([, value]) => value === host.toLowerCase());
  if (matching) return matching[0];
  const base = `readable-${new URL(host).hostname.replace(/[^\p{L}\p{N}_.-]/gu, '-').slice(0, 100)}`;
  let name = base;
  for (let index = 2; profiles.has(name); index++) name = `${base}-${index}`;
  return name;
}

export interface CliResult { stdout: string; stderr: string; exitCode: number; }
export type DatabricksSubprocessRunner = (executable: string, args: readonly string[], options: {
  signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void;
}) => Promise<CliResult>;

/** Native executable only: no cmd.exe, shell quoting, terminal, or stdin. */
export const runDatabricksProcess: DatabricksSubprocessRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const started = performance.now();
  const child = spawn(executable, [...args], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    signal: options.signal, timeout: options.timeoutMs,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  const failure = (category: DatabricksCliDiagnostic['category'], error?: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const nativeCode = (['EACCES', 'EPERM', 'ENOENT', 'ENOEXEC', 'ENOMEM', 'EMFILE', 'ENFILE', 'E2BIG', 'ABORT_ERR', 'ETIMEDOUT'] as const).find(value => value === code);
    return new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true, {
      category, elapsedMs: Math.round(performance.now() - started), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      ...(nativeCode ? { nativeCode } : {}),
    });
  };
  const collect = (which: 'stdout' | 'stderr', chunk: string) => {
    options.onOutput?.(chunk);
    if (which === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > 4 * 1024 * 1024) {
      child.kill();
      reject(failure('output-limit'));
    }
  };
  child.stdout.on('data', (chunk: string) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: string) => collect('stderr', chunk));
  child.once('error', (error) => reject(failure(options.signal.aborted ? 'aborted' : 'spawn', error)));
  child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
});

export type DatabricksCliSource = 'override' | 'path' | 'bundled';
export interface DatabricksExecutable { path: string; source: DatabricksCliSource; }
export interface DatabricksExecutableOptions {
  env?: NodeJS.ProcessEnv;
  userToolchainBins?: string[];
  sourceRoot?: string;
  runner?: DatabricksSubprocessRunner;
  timeoutMs?: number;
  preferBundled?: boolean;
}

export async function resolveDatabricksCli(override?: string | null, options: DatabricksExecutableOptions = {}): Promise<DatabricksExecutable | null> {
  if (override != null) {
    if (!isAbsolute(override) || (process.platform === 'win32' && !/\.exe$/i.test(override))) {
      throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED');
    }
    return { path: override, source: 'override' };
  }
  const env = options.env ?? process.env;
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates: DatabricksExecutable[] = [...path.split(delimiter).filter(Boolean), ...(options.userToolchainBins ?? wellKnownUserToolchainBins())]
    .map((dir) => ({ path: join(dir, process.platform === 'win32' ? 'databricks.exe' : 'databricks'), source: 'path' }));
  // READABLE_RESOURCE_ROOT is the packaged read-only resources/readable-studio tree.
  // Its sibling app tree is stable across prebundled and package-based daemon layouts.
  if (process.platform === 'win32' && process.arch === 'x64') {
    const appRoot = env.READABLE_RESOURCE_ROOT
      ? join(env.READABLE_RESOURCE_ROOT, '..', 'app')
      : join(options.sourceRoot ?? fileURLToPath(new URL('../../../../', import.meta.url)), '.tmp', 'databricks-cli-acquisition', 'app');
    candidates.push({ path: join(appRoot, 'vendor', 'databricks', 'databricks.exe'), source: 'bundled' });
  }
  const timeoutMs = options.timeoutMs ?? 3000;
  if (options.preferBundled) candidates.splice(0, candidates.length, ...candidates.filter(candidate => candidate.source === 'bundled'));
  for (const candidate of candidates) {
    try {
      await access(candidate.path, constants.X_OK);
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))) continue;
      throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE');
    }
    try {
      const result = await withDeadline((signal) => (options.runner ?? runDatabricksProcess)(candidate.path, ['--version'], { signal, timeoutMs }), timeoutMs);
      if (result.exitCode === 0 && supportedDatabricksVersion(result.stdout)) return candidate;
    } catch (error) {
      // A stale local launcher must not shadow the shipped executable.
      if (!(error instanceof DatabricksServiceError)
        && !(error instanceof Error && 'syscall' in error && error.syscall === 'spawn')) throw error;
    }
  }
  return null;
}

export async function resolveDatabricksExecutable(override?: string | null, options?: DatabricksExecutableOptions): Promise<string | null> {
  return (await resolveDatabricksCli(override, options))?.path ?? null;
}

/** The race also bounds injected implementations that fail to honor AbortSignal. */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true, { category: parent?.aborted ? 'aborted' : 'timeout' }));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }),
      controller.signal.aborted ? Promise.reject(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true)) : work(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export function classifyCliFailure(stderr: string): DatabricksServiceError {
  if (/keyring|credential manager|secret service|keychain/i.test(stderr)) return new DatabricksServiceError('DATABRICKS_KEYRING_UNAVAILABLE', true);
  if (/unknown command|unknown flag|not supported|unsupported/i.test(stderr)) return new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED');
  if (/timeout|network|connection|dial tcp|dns|unreachable|TLS/i.test(stderr)) return new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  if (/permission[ _]denied|access denied|\bforbidden\b/i.test(stderr)) return new DatabricksServiceError('DATABRICKS_PERMISSION_DENIED');
  if (/\b(?:token|authentication|credentials?)\b[^\n]*(?:expired|invalid)|\b(?:expired|invalid)\b[^\n]*(?:token|credentials?)|profile[^\n]*(?:not found|does not exist|missing)|not logged in|(?:login|log in|sign in|authentication) (?:is )?required|unauthenticated|unauthorized|cannot configure default credentials/i.test(stderr)) return new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
  return new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
}

function supportedDatabricksVersion(stdout: string): string | null {
  const version = /(?:Databricks\s+(?:CLI\s+)?v?)(\d+\.\d+\.\d+)/i.exec(stdout)?.[1] ?? null;
  return version && (Number(version.split('.')[0]) > 0 || Number(version.split('.')[1]) >= 205) ? version : null;
}

export interface DatabricksClientOptions {
  executablePath?: string | null;
  runner?: DatabricksSubprocessRunner;
  resolveExecutable?: (override?: string | null) => Promise<string | DatabricksExecutable | null>;
  timeoutMs?: number;
}

export class DatabricksClient {
  private executable: string | null = null;
  private cliSource: DatabricksCliSource | null = null;
  private state: { cli: DatabricksCliState; version: string | null } = { cli: 'missing', version: null };
  constructor(private readonly options: DatabricksClientOptions = {}) {}

  async probe(preferBundled = false): Promise<{ cli: DatabricksCliState; version: string | null; cliSource: DatabricksCliSource | null }> {
    this.executable = null;
    this.cliSource = null;
    try {
      const resolved = await (this.options.resolveExecutable ?? ((override) => resolveDatabricksCli(override, { ...this.options, preferBundled })))(preferBundled ? undefined : this.options.executablePath);
      this.executable = typeof resolved === 'string' ? resolved : resolved?.path ?? null;
      this.cliSource = typeof resolved === 'string' ? this.options.executablePath ? 'override' : 'path' : resolved?.source ?? null;
      if (!this.executable) { this.state = { cli: 'missing', version: null }; return this.status(); }
      const result = await this.run(['--version']);
      const version = /(?:Databricks\s+(?:CLI\s+)?v?)(\d+\.\d+\.\d+)/i.exec(result.stdout)?.[1] ?? null;
      if (result.exitCode !== 0) { this.state = { cli: 'uninvocable', version: null }; return this.status(); }
      const supported = version != null && (Number(version.split('.')[0]) > 0 || Number(version.split('.')[1]) >= 205);
      this.state = { cli: supported ? 'ready' : 'unsupported', version };
    } catch (error) {
      this.state = { cli: error instanceof DatabricksServiceError && error.code === 'DATABRICKS_CLI_UNSUPPORTED' ? 'unsupported' : 'uninvocable', version: null };
    }
    return this.status();
  }

  status(): { cli: DatabricksCliState; version: string | null; cliSource: DatabricksCliSource | null } { return { ...this.state, cliSource: this.cliSource }; }

  private async run(args: readonly string[], signal?: AbortSignal): Promise<CliResult> {
    if (!this.executable) throw new DatabricksServiceError('DATABRICKS_CLI_MISSING');
    const executable = this.executable;
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    return withDeadline((bounded) => (this.options.runner ?? runDatabricksProcess)(executable, args, { signal: bounded, timeoutMs }), timeoutMs, signal);
  }

  /** The CLI opens its own browser. Explicit profile avoids any stdin prompt. */
  async login(host: string, profileName: string, signal: AbortSignal, timeoutMs: number, onOutput?: (chunk: string) => void): Promise<void> {
    host = databricksWorkspaceOrigin(host);
    if (!this.executable || this.state.cli !== 'ready') throw new DatabricksServiceError('DATABRICKS_CLI_MISSING');
    const result = await withDeadline((bounded) => (this.options.runner ?? runDatabricksProcess)(this.executable!,
      ['auth', 'login', '--host', host, '--profile', profileName], { signal: bounded, timeoutMs, ...(onOutput ? { onOutput } : {}) }), timeoutMs, signal);
    if (result.exitCode !== 0) throw classifyCliFailure(result.stderr);
    // A zero exit is not proof of authentication. The login job polls auth token JSON.
  }

  async json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    if (this.state.cli !== 'ready') throw new DatabricksServiceError(this.state.cli === 'missing' ? 'DATABRICKS_CLI_MISSING' : 'DATABRICKS_CLI_UNSUPPORTED');
    let result: CliResult;
    const started = performance.now();
    try { result = await this.run(args, signal); }
    catch (error) {
      throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true, {
        ...(error instanceof DatabricksServiceError && error.diagnostic ? error.diagnostic : { category: signal?.aborted ? 'aborted' : 'spawn' }),
        elapsedMs: Math.round(performance.now() - started),
      });
    }
    if (result.exitCode !== 0) {
      const failure = classifyCliFailure(result.stderr);
      const http = /(?:\bHTTP(?:\/\d(?:\.\d)?)?|\bstatus(?: code)?)[\s:=]*([45]\d\d)\b/i.exec(result.stderr)?.[1];
      const cause: DatabricksCliDiagnostic['cause'] = /\bEOF\b|connection (?:closed|reset)|broken pipe/i.test(result.stderr) ? 'connection-closed'
        : /\bTLS\b|x509|certificate/i.test(result.stderr) ? 'tls'
          : http ? 'http'
            : failure.code === 'DATABRICKS_KEYRING_UNAVAILABLE' ? 'keyring'
              : failure.code === 'DATABRICKS_AUTH_REQUIRED' ? 'auth-config'
                : failure.code === 'DATABRICKS_PERMISSION_DENIED' ? 'permission'
                  : failure.code === 'DATABRICKS_CLI_UNSUPPORTED' ? 'unsupported'
                    : /network|connection|dial tcp|dns|unreachable/i.test(result.stderr) ? 'network' : undefined;
      throw new DatabricksServiceError(failure.code, failure.retryable, {
        category: 'cli-exit', ...(cause ? { cause } : {}), ...(http ? { httpStatus: Number(http) } : {}),
        exitCode: result.exitCode, elapsedMs: Math.round(performance.now() - started),
        stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
      });
    }
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED'); }
  }
}
