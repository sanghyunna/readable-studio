import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  API_ERROR_CODES,
  HOSTED_CSRF_HEADER,
  HOSTED_PROVIDER_IDS,
} from '@readable-studio/contracts';
import type {
  HostedProviderClearResponse,
  HostedProviderId,
  HostedProviderSetRequest,
  HostedProviderSetResponse,
  HostedProviderStatusResponse,
  HostedProviderTestRequest,
  HostedProviderTestResponse,
  HostedSessionResponse,
} from '@readable-studio/contracts';
import { resolveDaemonUrl } from './daemon-url.js';

const MAX_SECRET_BYTES = 16 * 1024;
const PROVIDERS = new Set<HostedProviderId>(HOSTED_PROVIDER_IDS);
const ERROR_CODES = new Set<string>(API_ERROR_CODES);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const PROVIDER_CLI_USAGE = `Usage:
  readable provider status [--identity-token-file <path|->] [--json]
  readable provider set --provider anthropic|vercel-ai-gateway --key-file <path|->
                  [--identity-token-file <path|->] [--json]
  readable provider test --provider anthropic|vercel-ai-gateway
                   [--identity-token-file <path|->] [--json]
  readable provider clear [--identity-token-file <path|->] [--json]

Identity is read from --identity-token-file or READABLE_HOSTED_IDENTITY_TOKEN_FILE.
Provider keys are read only from --key-file; use - for stdin.
All commands also accept --daemon-url <url>.
`;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderCliDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  readFile?: (filePath: string) => Promise<Buffer>;
  readStdin?: () => Promise<Buffer>;
  resolveDaemonUrl?: (flagUrl?: string) => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface ProviderCliResult {
  exitCode: number;
}

interface Options {
  command: 'status' | 'set' | 'test' | 'clear';
  provider?: HostedProviderId;
  keyFile?: string;
  identityTokenFile?: string;
  daemonUrl?: string;
  json: boolean;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function parseArgs(args: string[]): Options | { help: true } {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    return { help: true };
  }
  const command = args[0];
  if (command !== 'status' && command !== 'set' && command !== 'test' && command !== 'clear') {
    throw new CliError(`unknown provider command: ${command ?? ''}`, 'INVALID_ARGUMENT');
  }
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw new CliError('--json may be specified only once', 'INVALID_ARGUMENT');
      json = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag !== '--provider' && flag !== '--key-file' && flag !== '--identity-token-file' && flag !== '--daemon-url') {
      throw new CliError(`unknown option: ${flag ?? ''}`, 'INVALID_ARGUMENT');
    }
    if (values.has(flag)) {
      throw new CliError(`${flag} may be specified only once`, 'INVALID_ARGUMENT');
    }
    const value = args[++index];
    if (value === undefined || (value.startsWith('-') && value !== '-')) {
      throw new CliError(`${flag} requires a value`, 'INVALID_ARGUMENT');
    }
    values.set(flag, value);
  }

  const providerValue = values.get('--provider');
  if (providerValue !== undefined && !PROVIDERS.has(providerValue as HostedProviderId)) {
    throw new CliError('--provider must be anthropic or vercel-ai-gateway', 'INVALID_ARGUMENT');
  }
  const provider = providerValue as HostedProviderId | undefined;
  const keyFile = values.get('--key-file');
  if ((command === 'set' || command === 'test') && provider === undefined) {
    throw new CliError(`${command} requires --provider`, 'INVALID_ARGUMENT');
  }
  if (command === 'set' && keyFile === undefined) {
    throw new CliError('set requires --key-file <path|->', 'INVALID_ARGUMENT');
  }
  if (command !== 'set' && keyFile !== undefined) {
    throw new CliError('--key-file is valid only with provider set', 'INVALID_ARGUMENT');
  }
  if ((command === 'status' || command === 'clear') && provider !== undefined) {
    throw new CliError(`--provider is not valid with provider ${command}`, 'INVALID_ARGUMENT');
  }
  const identityTokenFile = values.get('--identity-token-file');
  const daemonUrl = values.get('--daemon-url');
  return {
    command,
    ...(provider === undefined ? {} : { provider }),
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(identityTokenFile === undefined ? {} : { identityTokenFile }),
    ...(daemonUrl === undefined ? {} : { daemonUrl }),
    json,
  };
}

function stripOneTerminalNewline(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function decodeSecret(bytes: Buffer, label: string): string {
  if (bytes.byteLength > MAX_SECRET_BYTES + 2) {
    throw new CliError(`${label} exceeds 16 KiB`, 'INVALID_ARGUMENT');
  }
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`${label} must be UTF-8`, 'INVALID_ARGUMENT');
  }
  value = stripOneTerminalNewline(value);
  if (value.length === 0) throw new CliError(`${label} must not be empty`, 'INVALID_ARGUMENT');
  if (value.includes('\0')) throw new CliError(`${label} must not contain NUL`, 'INVALID_ARGUMENT');
  if (/[\r\n]/u.test(value) || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new CliError(`${label} must be one line of at most 16 KiB`, 'INVALID_ARGUMENT');
  }
  return value;
}

async function defaultReadStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function canonicalOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${label} must be an absolute HTTP(S) origin`, 'INVALID_ARGUMENT');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`${label} must be an HTTP(S) origin`, 'INVALID_ARGUMENT');
  }
  if (url.username !== '' || url.password !== '') {
    throw new CliError(`${label} must not contain credentials`, 'INVALID_ARGUMENT');
  }
  if (url.origin !== value) {
    throw new CliError(`${label} must not contain a path, query, or fragment`, 'INVALID_ARGUMENT');
  }
  return url.origin;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProvider(value: unknown): value is HostedProviderId {
  return typeof value === 'string' && PROVIDERS.has(value as HostedProviderId);
}

function isSession(value: unknown): value is HostedSessionResponse {
  if (!isObject(value) || typeof value.publicOrigin !== 'string' || typeof value.csrfToken !== 'string'
    || typeof value.csrfExpiresAt !== 'number' || !Array.isArray(value.providers)) return false;
  return value.providers.every((provider) => isObject(provider) && isProvider(provider.id)
    && typeof provider.model === 'string');
}

function isStatus(value: unknown): value is HostedProviderStatusResponse {
  return isObject(value) && (value.provider === null || isProvider(value.provider))
    && typeof value.configured === 'boolean';
}

function isSetResponse(value: unknown): value is HostedProviderSetResponse {
  return isObject(value) && value.result === 'set' && isProvider(value.provider)
    && value.configured === true;
}

function isTestResponse(value: unknown): value is HostedProviderTestResponse {
  return isObject(value) && value.result === 'passed' && isProvider(value.provider)
    && typeof value.model === 'string';
}

function isClearResponse(value: unknown): value is HostedProviderClearResponse {
  return isObject(value) && value.result === 'cleared' && value.provider === null
    && value.configured === false;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliError('hosted daemon returned malformed JSON', 'INVALID_RESPONSE', response.status);
  }
}

function daemonError(response: Response, payload: unknown): CliError {
  const candidate = isObject(payload) && isObject(payload.error) ? payload.error.code : undefined;
  const code = typeof candidate === 'string' && ERROR_CODES.has(candidate)
    ? candidate
    : 'HOSTED_REQUEST_FAILED';
  return new CliError(`provider request failed: HTTP ${response.status}`, code, response.status);
}

async function safeFetch(
  fetchImpl: Fetch,
  baseOrigin: string,
  input: string,
  init: RequestInit,
): Promise<Response> {
  let url = input;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'manual' });
    } catch {
      throw new CliError('unable to reach hosted daemon', 'HOSTED_REQUEST_FAILED');
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null) return response;
    const target = new URL(location, url);
    if (target.origin !== baseOrigin) {
      throw new CliError('hosted daemon attempted a cross-origin redirect', 'CROSS_ORIGIN_REDIRECT');
    }
    url = target.href;
  }
  throw new CliError('hosted daemon redirected too many times', 'TOO_MANY_REDIRECTS');
}

function mutationHeaders(identityToken: string, session: HostedSessionResponse): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${identityToken}`,
    'content-type': 'application/json',
    origin: session.publicOrigin,
    [HOSTED_CSRF_HEADER]: session.csrfToken,
  };
}

function writeResult(
  command: Options['command'],
  payload: HostedProviderStatusResponse | HostedProviderSetResponse
    | HostedProviderTestResponse | HostedProviderClearResponse,
  json: boolean,
  write: (text: string) => void,
): void {
  if (json) {
    const output = command === 'status'
      ? {
          provider: (payload as HostedProviderStatusResponse).provider,
          configured: (payload as HostedProviderStatusResponse).configured,
        }
      : command === 'set'
        ? {
            result: 'set' as const,
            provider: (payload as HostedProviderSetResponse).provider,
            configured: true as const,
          }
        : command === 'test'
          ? {
              result: 'passed' as const,
              provider: (payload as HostedProviderTestResponse).provider,
              model: (payload as HostedProviderTestResponse).model,
            }
          : { result: 'cleared' as const, provider: null, configured: false as const };
    write(`${JSON.stringify(output)}\n`);
    return;
  }
  if (command === 'status') {
    const status = payload as HostedProviderStatusResponse;
    write(status.configured ? `Provider ${status.provider} is configured.\n` : 'No provider is configured.\n');
  } else if (command === 'set') {
    write(`Provider ${(payload as HostedProviderSetResponse).provider} configured.\n`);
  } else if (command === 'test') {
    const result = payload as HostedProviderTestResponse;
    write(`Provider ${result.provider} test passed (${result.model}).\n`);
  } else {
    write('Provider credential cleared.\n');
  }
}

/** Runs the hosted provider CLI without ever accepting credentials in argv. */
export async function runProviderCli(
  args: string[],
  dependencies: ProviderCliDependencies = {},
): Promise<ProviderCliResult> {
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });
  let json = args.includes('--json');
  try {
    const options = parseArgs(args);
    if ('help' in options) {
      stdout(PROVIDER_CLI_USAGE);
      return { exitCode: 0 };
    }
    json = options.json;
    const env = dependencies.env ?? process.env;
    const identityFile = options.identityTokenFile ?? env.READABLE_HOSTED_IDENTITY_TOKEN_FILE;
    if (!identityFile) {
      throw new CliError(
        'identity requires --identity-token-file <path|-> or READABLE_HOSTED_IDENTITY_TOKEN_FILE',
        'INVALID_ARGUMENT',
      );
    }
    if (identityFile === '-' && options.keyFile === '-') {
      throw new CliError('stdin cannot supply both identity and provider credentials', 'INVALID_ARGUMENT');
    }
    const read = dependencies.readFile ?? (async (filePath: string) => await readFile(filePath));
    const readStdin = dependencies.readStdin ?? defaultReadStdin;
    const readCredential = async (filePath: string, label: string): Promise<string> => {
      let bytes: Buffer;
      try {
        bytes = filePath === '-' ? await readStdin() : await read(filePath);
      } catch {
        throw new CliError(`unable to read ${label}`, 'INVALID_ARGUMENT');
      }
      return decodeSecret(bytes, label);
    };
    const identityToken = await readCredential(identityFile, 'identity token');
    const key = options.keyFile === undefined
      ? undefined
      : await readCredential(options.keyFile, 'provider key');

    let rawDaemonUrl: string;
    try {
      rawDaemonUrl = dependencies.resolveDaemonUrl
        ? await dependencies.resolveDaemonUrl(options.daemonUrl)
        : await resolveDaemonUrl(options.daemonUrl === undefined ? {} : { flagUrl: options.daemonUrl });
    } catch {
      throw new CliError('unable to resolve hosted daemon URL', 'INVALID_ARGUMENT');
    }
    const baseOrigin = canonicalOrigin(rawDaemonUrl, 'daemon URL');
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const authorization = { accept: 'application/json', authorization: `Bearer ${identityToken}` };
    const loadSession = async (): Promise<HostedSessionResponse> => {
      const response = await safeFetch(
        fetchImpl,
        baseOrigin,
        `${baseOrigin}/api/hosted/session`,
        { method: 'GET', headers: authorization },
      );
      const payload = await responseJson(response);
      if (!response.ok) throw daemonError(response, payload);
      if (!isSession(payload)) throw new CliError('hosted daemon returned an invalid session', 'INVALID_RESPONSE');
      const publicOrigin = canonicalOrigin(payload.publicOrigin, 'session publicOrigin');
      if (payload.publicOrigin !== publicOrigin || publicOrigin !== baseOrigin) {
        throw new CliError('session public origin does not match daemon origin', 'HOSTED_ORIGIN_MISMATCH');
      }
      return payload;
    };

    let session = await loadSession();
    const method = options.command === 'status' ? 'GET'
      : options.command === 'set' ? 'PUT'
        : options.command === 'test' ? 'POST'
          : 'DELETE';
    const pathname = options.command === 'test'
      ? '/api/hosted/provider/test'
      : '/api/hosted/provider';
    const requestBody: HostedProviderSetRequest | HostedProviderTestRequest | undefined =
      options.command === 'set'
        ? { provider: options.provider!, key: key! }
        : options.command === 'test'
          ? { provider: options.provider! }
          : undefined;
    const serializedBody = requestBody === undefined ? undefined : JSON.stringify(requestBody);
    const send = async (): Promise<Response> => await safeFetch(
      fetchImpl,
      baseOrigin,
      `${baseOrigin}${pathname}`,
      {
        method,
        headers: method === 'GET' ? authorization : mutationHeaders(identityToken, session),
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      },
    );
    let response = await send();
    if (response.status === 401 || response.status === 419) {
      session = await loadSession();
      response = await send();
    }
    const payload = await responseJson(response);
    if (!response.ok) throw daemonError(response, payload);
    const valid = options.command === 'status' ? isStatus(payload)
      : options.command === 'set' ? isSetResponse(payload)
        : options.command === 'test' ? isTestResponse(payload)
          : isClearResponse(payload);
    if (!valid) throw new CliError('hosted daemon returned an invalid provider response', 'INVALID_RESPONSE');
    writeResult(options.command, payload as HostedProviderStatusResponse | HostedProviderSetResponse
      | HostedProviderTestResponse | HostedProviderClearResponse, options.json, stdout);
    return { exitCode: 0 };
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError('provider command failed', 'PROVIDER_CLI_FAILED');
    if (json) {
      stderr(`${JSON.stringify({
        ok: false,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        error: { code: failure.code, message: failure.message },
      })}\n`);
    } else {
      stderr(`Error: ${failure.message}\n`);
    }
    return { exitCode: 1 };
  }
}
