import { readFile } from 'node:fs/promises';
import {
  API_ERROR_CODES, DatabricksNamesError,
  type AppConfigResponse, type UpdateAppConfigRequest, type DatabricksClientRequest,
  type DatabricksDisableRequest, type DatabricksEnableRequest, type DatabricksLookupRequest,
  type DatabricksModelResponse, type DatabricksModelsResponse, type DatabricksProbeRequest,
  type DatabricksScanEvent, type DatabricksScanRequest, type DatabricksScanResponse,
  type DatabricksVerifyRequest,
  type DatabricksManagedLoginStart, type DatabricksManagedLoginStatus,
  splitDatabricksModelName, matchesDatabricksModelSearch,
} from '@readable-studio/contracts';
import { resolveDaemonUrl } from './daemon-url.js';
import { databricksNamedRequest } from './databricks-named-http.js';
import { DatabricksServiceError } from './databricks/client.js';
import { databricksFailure, databricksInputId, DatabricksInputError, databricksPublic, databricksSetupRequest } from './databricks-routes.js';
import { managedLoginInput } from './databricks-login-routes.js';

export const DATABRICKS_CLI_USAGE = `Usage:
  readable databricks status|profiles [--json]
  readable databricks probe [--profile <id>] [--json]
  readable databricks login [--host <https-workspace-url>] [--profile <name>] [--json]
  readable databricks login --prompt-file <JSON-path|-> [--json]   (JSON: {"host"?: string, "profile"?: string})
  readable databricks login status <login-id> [--json]
  readable databricks login cancel <login-id> [--json]
  readable databricks setup --mode cli-profile [--profile <id>] [--json]
  readable databricks setup --mode workspace-token --host <https-workspace-url> --token-stdin [--json]
  readable databricks scan --profile <id> [--scopes <id,id>] [--follow] [--json]
  readable databricks scan status <scan-id> [--cursor <id>] [--limit <1-1000>] [--json]
  readable databricks scan cancel <scan-id> [--json]
  readable databricks lookup <resource-id> --profile <id> --kind serving-endpoint|uc-model-service [--json]
  readable databricks models [--profile <id>] [--search <text>] [--json]
  readable databricks add [names] --profile <id> [--names <text>|--prompt-file <path|->] --allow-inference [--check-only] [--check-reasoning] [--kind auto|serving-endpoint|uc-model-service] [--api auto|openai-completions|anthropic-messages] [--json]
  readable databricks enable <endpoint-id> --scan <id> --revision <n> [--json]
  readable databricks disable|remove <endpoint-id> --revision <n> [--json]
  readable databricks select <endpoint-id> [--json]
  readable databricks verify <endpoint-id> --scan <id> --revision <n> --allow-inference [--json]
  readable databricks disconnect <connection-id> [--json]
  readable databricks client --executable <opaque-id>|--clear [--json]
All commands accept --daemon-url <loopback-origin>. Setup reads a token only from stdin, never argv.
Workspace tokens remain in daemon memory for this session; re-enter them after daemon restart.
Login returns a job immediately; login status reports browser SSO progress, and login cancel stops it.
Scan waits for completion; --follow emits typed NDJSON events ending with a done snapshot.
Exit codes:
  0    success; login started; login status is waiting or succeeded; login cancel cancelled the sign-in
  1    failed or needs attention (login needs --host, sign-in failed, timed out or was cancelled,
       login cancel found the sign-in already ended, authentication required, verification failed)
  2    usage error (unknown command or flag, invalid --host, --profile or --prompt-file)
  3    scan partially completed
  64   the local Readable daemon is not running
  130  interrupted (Ctrl+C) or scan cancelled
`;
const LOGIN_USAGE = DATABRICKS_CLI_USAGE.split('\n').filter((line) => line.startsWith('  readable databricks login')).join('\n');

/** Login input errors name the field so the CLI can say exactly what to fix. */
class DatabricksLoginInputError extends DatabricksInputError {
  constructor(readonly field: 'host' | 'profile' | 'prompt-file') {
    super(field === 'host' ? 'The --host must be an https:// Databricks workspace URL, for example https://adb-123.azuredatabricks.net.'
      : field === 'profile' ? 'The --profile must be 1-128 letters, digits, spaces, dots, dashes or underscores.'
        : 'The --prompt-file must contain JSON like {"host": "https://<workspace-url>", "profile": "<name>"}.');
  }
}
function loginInput(host: unknown, profile: unknown) {
  if (host !== undefined) { try { managedLoginInput({ host }); } catch { throw new DatabricksLoginInputError('host'); } }
  if (profile !== undefined) { try { managedLoginInput({ profile }); } catch { throw new DatabricksLoginInputError('profile'); } }
  return managedLoginInput({ ...(host === undefined ? {} : { host }), ...(profile === undefined ? {} : { profile }) });
}
function loginText(command: string, result: DatabricksManagedLoginStart | DatabricksManagedLoginStatus): string {
  if (command === 'login') {
    const start = result as DatabricksManagedLoginStart;
    if (start.state === 'needs-input') return `No Databricks profile${start.profile ? ` named "${start.profile}"` : ''} was found. Pass --host https://<workspace-url> to sign in.`;
    return `Browser sign-in started for ${start.host ?? start.profile ?? 'Databricks'}.${start.loginId ? `\nCheck progress: readable databricks login status ${start.loginId}\nCancel: readable databricks login cancel ${start.loginId}` : ''}`;
  }
  const status = result as DatabricksManagedLoginStatus;
  // The daemon sends issue codes, never localized text; the CLI renders English from codes.
  const reason = status.issues?.length ? ` (${status.issues.map((issue) => issue.code).join(', ')})` : '';
  const text = status.state === 'waiting-browser' ? `Waiting for browser sign-in.${status.authUrl ? `\nIf the browser did not open, visit: ${status.authUrl}` : ''}`
    : status.state === 'succeeded' ? `Databricks sign-in succeeded.${status.profileId ? ` Profile: ${status.profileId}` : ''}`
      : status.state === 'cancelled' ? 'Databricks sign-in was cancelled.'
        : status.state === 'timeout' ? `Databricks sign-in timed out${reason}. Run readable databricks login again.`
          : `Databricks sign-in failed${reason}. Run readable databricks login again.`;
  if (command === 'login cancel' && status.state !== 'cancelled') return `The sign-in had already ended. ${text}`;
  return text;
}
function loginExitCode(command: string, result: DatabricksManagedLoginStart | DatabricksManagedLoginStatus): number {
  if (command === 'login') return result.state === 'started' ? 0 : 1;
  if (command === 'login cancel') return result.state === 'cancelled' ? 0 : 1;
  return result.state === 'waiting-browser' || result.state === 'succeeded' ? 0 : 1;
}

export interface DatabricksCliDependencies {
  fetch?: typeof fetch;
  resolveDaemonUrl?: (flagUrl?: string) => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
  readStdin?: () => Promise<string>;
}

async function readTokenStdin(): Promise<string> {
  if (process.stdin.isTTY) return usage();
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 8194) return usage();
  }
  return value.replace(/\r?\n$/, '');
}

const usage = (): never => { throw new DatabricksInputError('Invalid Databricks request'); };
function parse(args: string[]) {
  let command = args[0] ?? '';
  let offset = 1;
  if (['scan', 'login'].includes(command) && (args[1] === 'status' || args[1] === 'cancel')) { command += ` ${args[1]}`; offset++; }
  const allowed: Record<string, string[]> = {
    status: [], profiles: [], probe: ['profile'], scan: ['profile', 'scopes', 'follow'],
    add: ['profile', 'names', 'prompt-file', 'allow-inference', 'check-only', 'check-reasoning', 'kind', 'api'],
    login: ['host', 'profile', 'prompt-file'], 'login status': [], 'login cancel': [],
    'scan status': ['cursor', 'limit'], 'scan cancel': [], lookup: ['profile', 'kind'], models: ['profile', 'search'],
    enable: ['scan', 'revision'], disable: ['revision'], remove: ['revision'], select: [], verify: ['scan', 'revision', 'allow-inference'],
    disconnect: [], client: ['executable', 'clear'], setup: ['mode', 'host', 'profile', 'token-stdin'],
  };
  if (!Object.hasOwn(allowed, command)) return usage();
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = offset; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positional.push(command === 'add' ? arg : databricksInputId(arg)); continue; }
    const key = arg.slice(2);
    if (!['json', 'daemon-url', ...allowed[command]!].includes(key) || flags.has(key)) return usage();
    if (['json', 'follow', 'allow-inference', 'clear', 'token-stdin', 'check-only', 'check-reasoning'].includes(key)) { flags.set(key, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith('-') && !(key === 'prompt-file' && value === '-')) return usage();
    flags.set(key, value);
  }
  const needsId = ['login status', 'login cancel', 'scan status', 'scan cancel', 'lookup', 'enable', 'disable', 'remove', 'select', 'verify', 'disconnect'].includes(command);
  if (command === 'add' ? positional.length > 1 : positional.length !== (needsId ? 1 : 0)) return usage();
  const text = (key: string): string | undefined => { const value = flags.get(key); return typeof value === 'string' ? value : undefined; };
  const id = (key: string): string => databricksInputId(text(key));
  const revision = (): number => {
    const value = text('revision');
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return usage();
    return Number(value);
  };
  // Validate all input before resolving the daemon or performing any mutation.
  if (['scan', 'lookup', 'add'].includes(command)) id('profile');
  if (command === 'add' && (!flags.has('allow-inference') || Number(flags.has('names')) + Number(flags.has('prompt-file')) + positional.length !== 1)) return usage();
  if (text('profile') && command !== 'login') id('profile');
  if (text('scopes')) text('scopes')!.split(',').forEach(databricksInputId);
  if (text('cursor')) id('cursor');
  if (text('limit') && (!/^\d+$/.test(text('limit')!) || Number(text('limit')) < 1 || Number(text('limit')) > 1000)) return usage();
  if (['enable', 'disable', 'verify'].includes(command)) revision();
  if (['enable', 'verify'].includes(command)) id('scan');
  if (command === 'lookup' && !['serving-endpoint', 'uc-model-service'].includes(text('kind') ?? '')) return usage();
  if (command === 'verify' && !flags.has('allow-inference')) return usage();
  if (command === 'login') {
    if (flags.has('prompt-file') && (flags.has('host') || flags.has('profile'))) return usage();
    loginInput(text('host'), text('profile'));
  }
  if (command === 'setup') {
    if (text('mode') === 'cli-profile') {
      if (flags.has('host') || flags.has('token-stdin')) return usage();
    } else if (text('mode') !== 'workspace-token' || !text('host') || !flags.has('token-stdin') || flags.has('profile')) return usage();
  }
  if (command === 'client') {
    if (flags.has('executable') === flags.has('clear')) return usage();
    if (flags.has('executable')) id('executable');
  }
  return { command, flags, text, id, revision, target: positional[0] };
}

type PublicResult = ReturnType<(typeof databricksPublic)[Exclude<keyof typeof databricksPublic, 'event'>]> | DatabricksManagedLoginStart | DatabricksManagedLoginStatus;
export function databricksExitCode(result: PublicResult): number {
  if ('status' in result) return databricksExitCode(result.status);
  if ('state' in result) {
    if (result.state === 'cancelled') return 130;
    if (result.state === 'failed' || result.state === 'timed-out' || result.state === 'timeout' || result.state === 'needs-input') return 1;
    if (result.state === 'partial' && 'issues' in result) return result.issues.some((issue) => issue.action === 'sign-in') ? 1 : 3;
  }
  if ('cli' in result) {
    if (result.setupRequired !== undefined) return result.setupRequired ? 1 : 0;
    if (result.cli !== 'ready' || !['authenticated', 'unchecked'].includes(result.auth)) return 1;
  }
  if ('profiles' in result && result.profiles.some((profile) => !['authenticated', 'unchecked'].includes(profile.auth))) return 1;
  if ('issues' in result && result.issues.length > 0) return 1;
  if ('result' in result && result.result !== 'passed') return 1;
  return 0;
}

/** HTTP is the only production transport; injected fetch can exercise the same routes with a stub service. */
export async function runDatabricksCli(args: string[], dependencies: DatabricksCliDependencies = {}): Promise<{ exitCode: number }> {
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });
  if ((args.length === 1 && args[0] === 'help') || args.some((arg) => arg === '--help' || arg === '-h')) { stderr(DATABRICKS_CLI_USAGE); return { exitCode: 0 }; }
  const json = args.includes('--json');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (!dependencies.signal) process.once('SIGINT', interrupt);
  else if (dependencies.signal.aborted) interrupt();
  else dependencies.signal.addEventListener('abort', interrupt, { once: true });
  let activeScan: string | undefined;
  let daemonUnavailable = false;
  let follow = false;
  let request: (<T>(path: string, method: string, body?: unknown) => Promise<T>) | undefined;
  const print = (value: unknown) => stdout(`${JSON.stringify(value)}\n`);
  try {
    const options = parse(args);
    follow = options.flags.has('follow');
    let loginRequest = options.command === 'login' ? loginInput(options.text('host'), options.text('profile')) : undefined;
    if (options.command === 'login' && options.text('prompt-file')) {
      const path = options.text('prompt-file')!;
      let supplied: unknown;
      try { supplied = JSON.parse(path === '-' ? await (dependencies.readStdin ?? readTokenStdin)() : await readFile(path, 'utf8')); }
      catch { throw new DatabricksLoginInputError('prompt-file'); }
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some((key) => !['host', 'profile'].includes(key))) throw new DatabricksLoginInputError('prompt-file');
      const body = supplied as { host?: unknown; profile?: unknown };
      loginRequest = loginInput(body.host, body.profile);
    }
    const base = new URL(await (dependencies.resolveDaemonUrl ?? ((flagUrl?: string) => resolveDaemonUrl({ flagUrl: flagUrl ?? null })))(options.text('daemon-url')));
    if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return usage();
    const fetchImpl = dependencies.fetch ?? fetch;
    const send = async (path: string, method: string, body?: unknown, stream = false): Promise<Response> => {
      let response: Response;
      try {
        response = await fetchImpl(`${base.origin}${path}`, {
          method, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', Origin: base.origin },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Twenty named models run in two lanes; the caller must outlive all ten probe batches.
          signal: stream ? AbortSignal.any([controller.signal, AbortSignal.timeout(4 * 60 * 60_000)]) : AbortSignal.timeout(35 * 60_000),
        });
      } catch (error) { daemonUnavailable = true; throw error; }
      if (!response.ok) {
        const payload = await response.json() as { error?: { code?: unknown } };
        const code = payload.error?.code;
        if (code === 'BAD_REQUEST') return usage();
        if (typeof code === 'string') {
          const known = API_ERROR_CODES.find((candidate) => candidate.startsWith('DATABRICKS_') && candidate === code);
          if (known?.startsWith('DATABRICKS_')) throw new DatabricksServiceError(known as DatabricksServiceError['code']);
        }
        throw new Error('Databricks request failed');
      }
      return response;
    };
    request = async <T>(path: string, method: string, body?: unknown): Promise<T> => (await send(path, method, body)).json() as Promise<T>;
    const call = async <T>(path: string, method: string, sanitize: (value: T) => T, body?: unknown) => sanitize(await request!<T>(`/api/databricks${path}`, method, body));
    const profile: DatabricksProbeRequest = options.text('profile') && options.command !== 'login' ? { profileId: options.id('profile') } : {};
    let result: PublicResult;
    if (controller.signal.aborted) throw new Error('Cancelled');
    switch (options.command) {
      case 'status': result = await call('/status', 'GET', databricksPublic.status); break;
      case 'login': result = await call<DatabricksManagedLoginStart>('/login', 'POST', value => ({
        state: value.state, ...(value.loginId ? { loginId: value.loginId } : {}),
        ...(value.host ? { host: value.host } : {}), ...(value.profile ? { profile: value.profile } : {}),
      }), loginRequest); break;
      case 'login status': case 'login cancel': result = await call<DatabricksManagedLoginStatus>(
        `/login/${options.target}${options.command === 'login cancel' ? '/cancel' : ''}`,
        options.command === 'login cancel' ? 'POST' : 'GET', value => ({
          state: value.state, ...(value.authUrl ? { authUrl: value.authUrl } : {}), ...(value.profileId ? { profileId: value.profileId } : {}),
          ...(value.issues?.length ? { issues: value.issues } : {}),
        }), options.command === 'login cancel' ? {} : undefined); break;
      case 'setup': {
        const body = databricksSetupRequest(options.text('mode') === 'cli-profile'
          ? { mode: 'cli-profile', ...profile }
          : { mode: 'workspace-token', host: options.text('host'), token: await (dependencies.readStdin ?? readTokenStdin)() });
        result = await call('/setup', 'POST', databricksPublic.setup, body); break;
      }
      case 'profiles': case 'probe': result = await call('/probe', 'POST', databricksPublic.profiles, profile); break;
      case 'client': {
        const body: DatabricksClientRequest = { executableId: options.flags.has('clear') ? null : options.id('executable') };
        result = await call('/client', 'PUT', databricksPublic.status, body); break;
      }
      case 'add': case 'scan': {
        const named = options.command === 'add';
        const body: DatabricksScanRequest = named ? databricksNamedRequest({ profileId: options.id('profile'),
          names: options.text('prompt-file') ? options.text('prompt-file') === '-' ? await (dependencies.readStdin ?? readTokenStdin)() : await readFile(options.text('prompt-file')!, 'utf8') : options.text('names') ?? options.target,
          allowInference: true, checkReasoning: options.flags.has('check-reasoning'), kindHint: options.text('kind') ?? 'auto', apiHint: options.text('api') ?? 'auto' }) : { profileId: options.id('profile'), ...(options.text('scopes') ? { scopeIds: options.text('scopes')!.split(',') } : {}) };
        result = await call(named ? '/scans/named' : '/scans', 'POST', databricksPublic.scan, body);
        activeScan = result.scanId;
        stderr(`Databricks scan ${result.state}\n`);
        if (!['queued', 'running'].includes(result.state)) {
          if (follow) print({ type: 'done', revision: result.revision, scan: result } satisfies DatabricksScanEvent);
          break;
        }
        const response = await send(`/api/databricks/scans/${activeScan}/events`, 'GET', undefined, true);
        if (!response.body) throw new Error('Missing scan stream');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let terminal: DatabricksScanResponse | undefined;
        try {
          while (!terminal) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Scan stream ended without a terminal snapshot');
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const event = databricksPublic.event(JSON.parse(data) as DatabricksScanEvent);
              if (follow) print(event);
              if (event.type === 'snapshot' || event.type === 'done' || event.type === 'progress') stderr(`Databricks scan ${'scan' in event ? event.scan.state : event.state}\n`);
              if (event.type === 'done') {
                if (['queued', 'running'].includes(event.scan.state)) throw new Error('Invalid terminal snapshot');
                terminal = event.scan; break;
              }
            }
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        result = terminal;
        break;
      }
      case 'scan status': {
        const query = new URLSearchParams();
        for (const key of ['cursor', 'limit']) if (options.text(key)) query.set(key, options.text(key)!);
        result = await call(`/scans/${options.target}?${query}`, 'GET', databricksPublic.scan); break;
      }
      case 'scan cancel': result = await call(`/scans/${options.target}`, 'DELETE', databricksPublic.scan); break;
      case 'lookup': {
        const body: DatabricksLookupRequest = { profileId: options.id('profile'), resourceId: options.target!, kind: options.text('kind') as DatabricksLookupRequest['kind'] };
        result = await call('/lookup', 'POST', databricksPublic.lookup, body); break;
      }
      case 'models': {
        const models: DatabricksModelsResponse = await call(`/models${profile.profileId ? `?profileId=${profile.profileId}` : ''}`, 'GET', databricksPublic.models);
        // Same display-only filter as the web list: model name, UC path and full name.
        const search = options.text('search');
        result = search ? { ...models, models: models.models.filter((model) => matchesDatabricksModelSearch(model, search)) } : models;
        break;
      }
      case 'enable': {
        const body: DatabricksEnableRequest = { scanId: options.id('scan'), expectedRevision: options.revision() };
        result = await call(`/models/${options.target}`, 'PUT', databricksPublic.model, body); break;
      }
      case 'disable': case 'remove': {
        const body: DatabricksDisableRequest = { expectedRevision: options.revision() };
        result = await call(`/models/${options.target}`, 'DELETE', databricksPublic.models, body); break;
      }
      case 'verify': {
        const body: DatabricksVerifyRequest = { scanId: options.id('scan'), expectedRevision: options.revision(), allowInference: true };
        result = await call(`/models/${options.target}/verify`, 'POST', databricksPublic.verification, body); break;
      }
      case 'disconnect': result = await call(`/connections/${options.target}`, 'DELETE', databricksPublic.status); break;
      case 'select': {
        const models: DatabricksModelsResponse = await call('/models', 'GET', databricksPublic.models);
        const endpoint = models.models.find((model) => model.id === options.target);
        if (!endpoint) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
        if (endpoint.availability !== 'compatible') throw new DatabricksServiceError('DATABRICKS_VERIFICATION_REQUIRED');
        const current = await request<AppConfigResponse>('/api/app-config', 'GET');
        const body: UpdateAppConfigRequest = {
          agentId: 'databricks', agentModels: { ...current.config.agentModels, databricks: { model: endpoint.appModelId } },
        };
        const saved = await request<AppConfigResponse>('/api/app-config', 'PUT', body);
        if (saved.config.agentId !== 'databricks' || saved.config.agentModels?.databricks?.model !== endpoint.appModelId) throw new Error('Selection was not saved');
        result = { endpoint, appModelId: endpoint.appModelId, revision: models.revision } satisfies DatabricksModelResponse;
        break;
      }
      default: return usage();
    }
    if ('cursor' in result) {
      const scan = result;
      while (scan.cursor) {
        const page = await call(`/scans/${scan.scanId}?cursor=${encodeURIComponent(scan.cursor)}`, 'GET', databricksPublic.scan);
        if (page.revision !== scan.revision) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION');
        scan.endpoints.push(...page.endpoints); scan.cursor = page.cursor;
      }
      if (options.command === 'add' && !options.flags.has('check-only') && scan.state !== 'cancelled') {
        for (const row of scan.inputResults ?? []) {
          if (!row.endpointId || !['verified', 'chat-only'].includes(row.state)) continue;
          const saved = await call(`/models/${row.endpointId}`, 'PUT', databricksPublic.model, { scanId: scan.scanId, expectedRevision: scan.revision });
          scan.endpoints = scan.endpoints.map(endpoint => endpoint.id === saved.endpoint.id ? saved.endpoint : endpoint);
        }
      }
    }
    if (options.command.startsWith('login')) {
      const login = result as DatabricksManagedLoginStart | DatabricksManagedLoginStatus;
      if (json) print(login); else (loginExitCode(options.command, login) === 0 ? stdout : stderr)(`${loginText(options.command, login)}\n`);
      return { exitCode: loginExitCode(options.command, login) };
    }
    if (!follow) {
      if (options.command === 'models' && !options.flags.has('json') && 'models' in result) {
        for (const endpoint of result.models) {
          // Same rule as the web `displayDatabricksModelName`: UC remainder is the
          // name, `catalog.schema` the path, a differing served model is secondary.
          const name = splitDatabricksModelName(endpoint.displayName ?? endpoint.label);
          const secondary = endpoint.servedModelName && endpoint.servedModelName !== name.model ? endpoint.servedModelName : null;
          stdout(`${name.model}${name.path ? `  [${name.path}]` : ''}${secondary ? `  (${secondary})` : ''}\n`);
        }
      } else print(result);
    }
    return { exitCode: databricksExitCode(result) };
  } catch (error) {
    if (controller.signal.aborted) {
      if (activeScan && request) {
        try {
          const scan = databricksPublic.scan(await request<DatabricksScanResponse>(`/api/databricks/scans/${activeScan}`, 'DELETE'));
          if (follow) print({ type: 'done', revision: scan.revision, scan } satisfies DatabricksScanEvent);
          else print(scan);
        } catch (cancelError) { print(databricksFailure(cancelError)); stderr('Databricks scan cancellation could not be confirmed\n'); }
      } else print(databricksFailure(error));
      return { exitCode: 130 };
    }
    if (daemonUnavailable) {
      // Match the root CLI's local-daemon recovery code, not an upstream gateway fault.
      const message = 'Cannot reach the local Readable daemon. Start Readable Studio or run readable daemon start --headless; use --daemon-url for a nondefault daemon.';
      print({ error: { code: 'daemon-not-running', message, retryable: true } });
      stderr(`${message}\n`);
      return { exitCode: 64 };
    }
    if (error instanceof DatabricksLoginInputError) {
      if (json) print({ error: { code: 'BAD_REQUEST', message: error.message, field: error.field, retryable: false } });
      stderr(`${error.message}\n\n${LOGIN_USAGE}\n`);
      return { exitCode: 2 };
    }
    print(databricksFailure(error));
    stderr(error instanceof DatabricksInputError ? DATABRICKS_CLI_USAGE : 'Databricks command failed\n');
    return { exitCode: error instanceof DatabricksInputError || error instanceof DatabricksNamesError ? 2 : 1 };
  } finally {
    process.removeListener('SIGINT', interrupt);
    dependencies.signal?.removeEventListener('abort', interrupt);
  }
}
