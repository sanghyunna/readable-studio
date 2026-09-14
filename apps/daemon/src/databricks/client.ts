import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { wellKnownUserToolchainBins } from '@readable-studio/platform';
import type { DatabricksCliState, DatabricksErrorCode, DatabricksIssue } from '@readable-studio/contracts';

/** Deliberately contains no upstream message, cause, stdout, or stderr. */
export class DatabricksServiceError extends Error {
  constructor(public readonly code: DatabricksErrorCode, public readonly retryable = false) {
    super(code);
    this.name = 'DatabricksServiceError';
  }
}

export function issueFor(error: unknown): DatabricksIssue {
  const fault = error instanceof DatabricksServiceError ? error : new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true);
  const action: DatabricksIssue['action'] = fault.code === 'DATABRICKS_CLI_MISSING' ? 'install-cli'
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
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
  }
  return url.origin;
}

export interface CliResult { stdout: string; stderr: string; exitCode: number; }
export type DatabricksSubprocessRunner = (executable: string, args: readonly string[], options: {
  signal: AbortSignal; timeoutMs: number;
}) => Promise<CliResult>;

/** Native executable only: no cmd.exe, shell quoting, terminal, or stdin. */
export const runDatabricksProcess: DatabricksSubprocessRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    signal: options.signal, timeout: options.timeoutMs,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  const collect = (which: 'stdout' | 'stderr', chunk: string) => {
    if (which === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > 4 * 1024 * 1024) {
      child.kill();
      reject(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true));
    }
  };
  child.stdout.on('data', (chunk: string) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: string) => collect('stderr', chunk));
  child.once('error', () => reject(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true)));
  child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
});

export type DatabricksCliSource = 'override' | 'path' | 'bundled';
export interface DatabricksExecutable { path: string; source: DatabricksCliSource; }
export interface DatabricksExecutableOptions {
  env?: NodeJS.ProcessEnv;
  userToolchainBins?: string[];
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
  if (process.platform === 'win32' && process.arch === 'x64' && env.READABLE_RESOURCE_ROOT) {
    candidates.push({ path: join(env.READABLE_RESOURCE_ROOT, '..', 'app', 'vendor', 'databricks', 'databricks.exe'), source: 'bundled' });
  }
  for (const candidate of candidates) {
    try {
      await access(candidate.path, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE');
      }
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
        rejectAbort = () => reject(new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true));
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
  return new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
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

  async probe(): Promise<{ cli: DatabricksCliState; version: string | null; cliSource: DatabricksCliSource | null }> {
    this.executable = null;
    this.cliSource = null;
    try {
      const resolved = await (this.options.resolveExecutable ?? resolveDatabricksCli)(this.options.executablePath);
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
  async login(host: string, profileName: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    host = databricksWorkspaceOrigin(host);
    if (!this.executable || this.state.cli !== 'ready') throw new DatabricksServiceError('DATABRICKS_CLI_MISSING');
    const result = await withDeadline((bounded) => (this.options.runner ?? runDatabricksProcess)(this.executable!,
      ['auth', 'login', '--host', host, '--profile', profileName], { signal: bounded, timeoutMs }), timeoutMs, signal);
    if (result.exitCode !== 0) throw classifyCliFailure(result.stderr);
    // A zero exit is not proof of authentication. The login job polls auth token JSON.
  }

  async json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    if (this.state.cli !== 'ready') throw new DatabricksServiceError(this.state.cli === 'missing' ? 'DATABRICKS_CLI_MISSING' : 'DATABRICKS_CLI_UNSUPPORTED');
    let result: CliResult;
    try { result = await this.run(args, signal); }
    catch { throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true); }
    if (result.exitCode !== 0) throw classifyCliFailure(result.stderr);
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new DatabricksServiceError('DATABRICKS_CLI_UNSUPPORTED'); }
  }
}
