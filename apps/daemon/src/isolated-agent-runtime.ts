import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SIDECAR_ENV } from '@readable-studio/sidecar-proto';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_RUN = 256;
const MAX_BROKER_OUTPUT_BYTES = 4 * 1024 * 1024;

const BROKER_CLIENT_SOURCE = String.raw`import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const pipe = process.env.READABLE_ISOLATED_TOOL_BROKER_PIPE;
const token = process.env.READABLE_ISOLATED_TOOL_BROKER_TOKEN;
if (!pipe || !token) throw new Error('isolated tool broker is unavailable');
const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
let input;
if (inputIndex >= 0) {
  const inputPath = args[inputIndex + 1];
  if (!inputPath || path.isAbsolute(inputPath)) throw new Error('broker input must be a project-relative path');
  const relative = path.relative(process.cwd(), path.resolve(inputPath));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('broker input must stay inside the project');
  }
  input = await readFile(path.resolve(inputPath), 'utf8');
}
const body = Buffer.from(JSON.stringify({ args, input, token }), 'utf8');
const header = Buffer.allocUnsafe(4);
header.writeUInt32LE(body.length);
const response = await new Promise((resolve, reject) => {
  const deadline = Date.now() + 5_000;
  const connect = () => {
    const socket = net.createConnection(pipe);
    let buffer = Buffer.alloc(0);
    socket.once('connect', () => socket.write(Buffer.concat([header, body])));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(0);
      if (size > 4 * 1024 * 1024) return socket.destroy(new Error('broker response is too large'));
      if (buffer.length >= size + 4) {
        socket.end();
        try { resolve(JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))); }
        catch (error) { reject(error); }
      }
    });
    socket.once('error', (error) => {
      if ((error.code === 'ENOENT' || error.code === 'EBUSY') && Date.now() < deadline) setTimeout(connect, 20);
      else reject(error);
    });
  };
  connect();
});
if (!response || typeof response !== 'object') throw new Error('invalid broker response');
if (typeof response.stdout === 'string') process.stdout.write(response.stdout);
if (typeof response.stderr === 'string') process.stderr.write(response.stderr);
process.exitCode = Number.isInteger(response.code) ? response.code : 125;
`;

export type IsolatedRunPaths = {
  clientPath: string;
  home: string;
  nodeBin: string;
  root: string;
  temp: string;
};

export type IsolatedToolBroker = {
  close: () => Promise<void>;
  clientEnv: NodeJS.ProcessEnv;
  paths: IsolatedRunPaths;
  readExecutePaths: string[];
  ipc: {
    pipeName: string;
    handleRequest(request: string): Promise<string>;
  };
};

type BrokerOptions = {
  agentEnv: NodeJS.ProcessEnv;
  agentId: string;
  cwd: string;
  daemonUrl: string;
  hostEnv: NodeJS.ProcessEnv;
  hostNodeBin: string;
  hostOdBin: string;
  projectId: string;
  projectDir: string;
  runId: string;
  toolToken: string;
};

type ConfigLink = { source: string; target: string };

function agentConfigLinks(agentId: string, env: NodeJS.ProcessEnv, home: string): ConfigLink[] {
  const hostHome = os.homedir();
  const defaults: Record<string, string[]> = {
    'cursor-agent': ['.cursor'],
    antigravity: ['.agy'],
    copilot: ['.copilot'],
    devin: ['.devin'],
    gemini: ['.gemini'],
    'grok-build': ['.grok'],
    hermes: ['.hermes'],
    kilo: ['.kilo'],
    kimi: ['.kimi'],
    kiro: ['.kiro'],
    pi: ['.pi'],
    qoder: ['.qoder'],
    qwen: ['.qwen'],
    'trae-cli': ['.trae'],
    vibe: ['.vibe'],
  };
  if (agentId === 'codex') {
    return [];
  }
  if (agentId === 'claude') {
    return [{ source: env.CLAUDE_CONFIG_DIR?.trim() || path.join(hostHome, '.claude'), target: path.join(home, '.claude') }];
  }
  if (agentId === 'amr') {
    return [{ source: env.OPENCODE_TEST_HOME?.trim() || path.join(hostHome, '.opencode'), target: path.join(home, '.opencode') }];
  }
  if (agentId === 'opencode') {
    return [
      { source: path.join(hostHome, '.config', 'opencode'), target: path.join(home, '.config', 'opencode') },
      { source: path.join(hostHome, '.local', 'share', 'opencode'), target: path.join(home, '.local', 'share', 'opencode') },
    ];
  }
  return (defaults[agentId] ?? []).map((relative) => ({
    source: path.join(hostHome, relative),
    target: path.join(home, relative),
  }));
}

async function linkAgentConfig(agentId: string, env: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const granted: string[] = [];
  if (agentId === 'codex') {
    const source = env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    const target = path.join(home, '.codex');
    await mkdir(target, { recursive: true });
    for (const name of ['auth.json', 'config.toml']) {
      if (existsSync(path.join(source, name))) await copyFile(path.join(source, name), path.join(target, name));
    }
  }
  for (const link of agentConfigLinks(agentId, env, home)) {
    const metadata = await stat(link.source).catch(() => null);
    if (!metadata) continue;
    await mkdir(path.dirname(link.target), { recursive: true });
    if (metadata.isDirectory()) await symlink(path.resolve(link.source), link.target, 'junction');
    else await copyFile(link.source, link.target);
    granted.push(path.resolve(link.source));
  }
  const claudeState = path.join(os.homedir(), '.claude.json');
  if (agentId === 'claude' && existsSync(claudeState)) {
    await copyFile(claudeState, path.join(home, '.claude.json'));
  }
  return granted;
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw new Error('isolated agent run id is invalid');
  }
  return runId;
}

export function isolatedBrokerHostPathsAreProtected(options: {
  cwd: string;
  hostNodeBin: string;
  hostOdBin: string;
}): boolean {
  return ![options.hostNodeBin, options.hostOdBin].some((candidate) => {
    const relative = path.relative(path.resolve(options.cwd), path.resolve(candidate));
    return relative === ''
      || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
}

export function isolatedRunPaths(runId: string): IsolatedRunPaths {
  const root = path.join(os.tmpdir(), 'readable-studio-isolated-agents', safeRunId(runId));
  const systemRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.SystemRoot]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => path.resolve(value).toLowerCase());
  const executable = path.resolve(process.execPath);
  const needsPrivateNode = systemRoots.some(
    (systemRoot) => executable.toLowerCase() === systemRoot || executable.toLowerCase().startsWith(`${systemRoot}${path.sep}`),
  );
  return {
    clientPath: path.join(root, 'readable-tool-broker-client.mjs'),
    home: path.join(root, 'home'),
    nodeBin: needsPrivateNode ? path.join(root, 'bin', path.basename(process.execPath)) : process.execPath,
    root,
    temp: path.join(root, 'tmp'),
  };
}

function sameSecret(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

type BrokerResult = { code: number; stderr: string; stdout: string };

function denied(message: string): BrokerResult {
  return { code: 126, stderr: `${message}\n`, stdout: '' };
}

function parseValueFlags(args: string[], allowed: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.includes(flag) || !value || values.has(flag) || value.includes('\0')) return null;
    values.set(flag, value);
  }
  return values;
}

function safeRelativePath(value: string): boolean {
  if (path.isAbsolute(value) || value.includes('\0')) return false;
  const normalized = value.replace(/\\/g, '/');
  return normalized.length > 0 && !normalized.split('/').some((segment) => segment === '..');
}

async function collectBrokerChild(child: ChildProcess): Promise<BrokerResult> {
  let stdout = '';
  let stderr = '';
  let oversized = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  const append = (target: 'stdout' | 'stderr', chunk: string): void => {
    if (oversized) return;
    if (target === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BROKER_OUTPUT_BYTES) {
      oversized = true;
      child.kill('SIGTERM');
    }
  };
  child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: string) => append('stderr', chunk));
  child.stdin?.end();
  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (value: number): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', (error) => {
      stderr += `${error.message}\n`;
      finish(125);
    });
    child.once('close', (value) => finish(value ?? 125));
  });
  return oversized
    ? { code: 125, stderr: 'isolated tool broker output exceeded 4 MiB\n', stdout: '' }
    : { code, stderr, stdout };
}

export async function startIsolatedToolBroker(options: BrokerOptions): Promise<IsolatedToolBroker> {
  if (!isolatedBrokerHostPathsAreProtected(options)) {
    throw new Error('isolated broker host executables must stay outside the agent-writable project');
  }
  const paths = isolatedRunPaths(options.runId);
  const brokerNonce = randomBytes(18).toString('hex');
  const pipeName = `\\\\.\\pipe\\LOCAL\\ReadableStudio.${process.pid}.${brokerNonce}`;
  await rm(paths.root, { force: true, recursive: true });
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.temp, { recursive: true }),
  ]);
  if (paths.nodeBin !== process.execPath) {
    await mkdir(path.dirname(paths.nodeBin), { recursive: true });
    await copyFile(process.execPath, paths.nodeBin);
  }
  await writeFile(paths.clientPath, BROKER_CLIENT_SOURCE, 'utf8');
  const readExecutePaths = await linkAgentConfig(options.agentId, options.agentEnv, paths.home);

  const brokerToken = randomBytes(32).toString('base64url');
  const children = new Set<ChildProcess>();
  let requestCount = 0;
  let closed = false;
  const runCli = async (args: string[]): Promise<BrokerResult> => {
    if (closed) return denied('isolated tool broker is closed');
    const child = spawn(options.hostNodeBin, [options.hostOdBin, ...args], {
      cwd: options.cwd,
      env: {
        ...options.hostEnv,
        READABLE_BIN: options.hostOdBin,
        READABLE_DAEMON_URL: options.daemonUrl,
        READABLE_NODE_BIN: options.hostNodeBin,
        READABLE_PROJECT_DIR: options.projectDir,
        READABLE_PROJECT_ID: options.projectId,
        READABLE_TOOL_TOKEN: options.toolToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.add(child);
    try {
      return await collectBrokerChild(child);
    } finally {
      children.delete(child);
    }
  };

  const handleRequest = async (text: string): Promise<string> => {
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES || ++requestCount > MAX_REQUESTS_PER_RUN) {
      return JSON.stringify({ code: 125, stderr: 'isolated tool broker request limit exceeded\n', stdout: '' });
    }
    let request: { args?: unknown; input?: unknown; token?: unknown };
    try {
      request = JSON.parse(text) as typeof request;
    } catch {
      return JSON.stringify(denied('invalid isolated tool broker request'));
    }
    const args = Array.isArray(request.args) && request.args.every((value) => typeof value === 'string')
      ? request.args as string[]
      : [];
    if (!sameSecret(brokerToken, request.token)) return JSON.stringify(denied('isolated tool broker authentication failed'));

    let result: BrokerResult;
    if (args[0] === 'tools' && args[1] === 'design-systems' && args[2] === 'read') {
      const flags = parseValueFlags(args.slice(3), ['--design-system', '--path']);
      const manifestPath = flags?.get('--path');
      result = !flags || !manifestPath || !safeRelativePath(manifestPath)
        ? denied('only design-systems:read with a manifest-relative path is allowed')
        : await runCli([
            'tools', 'design-systems', 'read', '--path', manifestPath,
            ...(flags.has('--design-system') ? ['--design-system', flags.get('--design-system')!] : []),
          ]);
    } else if (args[0] === 'tools' && args[1] === 'media' && args[2] === 'generate') {
      const flags = parseValueFlags(args.slice(3), ['--input']);
      const inputPath = flags?.get('--input');
      let input: unknown;
      try { input = typeof request.input === 'string' ? JSON.parse(request.input) : null; } catch { input = null; }
      if (!flags || !inputPath || !safeRelativePath(inputPath) || !input || typeof input !== 'object' || Array.isArray(input)) {
        result = denied('only media:generate with inline project input is allowed');
      } else {
        const endpoint = new URL('/api/tools/media/generate', options.daemonUrl);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.toolToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await response.text();
        result = response.ok
          ? { code: 0, stderr: '', stdout: `${body}\n` }
          : { code: 1, stderr: `${body}\n`, stdout: '' };
      }
    } else {
      result = denied('isolated broker allows only design-systems:read and media:generate');
    }
    return JSON.stringify(result);
  };

  return {
    paths,
    readExecutePaths,
    ipc: { pipeName, handleRequest },
    clientEnv: {
      READABLE_ISOLATED_TOOL_BROKER_PIPE: pipeName,
      READABLE_ISOLATED_TOOL_BROKER_TOKEN: brokerToken,
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const child of children) child.kill('SIGTERM');
      await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
        if (child.exitCode != null) resolve();
        else child.once('close', () => resolve());
      })));
      await rm(paths.root, { force: true, recursive: true });
    },
  };
}

const STRIPPED_ISOLATED_ENV_KEYS = new Set([
  'READABLE_BIN',
  'READABLE_API_TOKEN',
  'READABLE_DAEMON_URL',
  'READABLE_DATA_DIR',
  SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN,
  'READABLE_MEDIA_CONFIG_DIR',
  SIDECAR_ENV.DAEMON_PORT,
  'READABLE_RESOURCE_ROOT',
  SIDECAR_ENV.IPC_PATH,
  'READABLE_TOOL_TOKEN',
]);

export function isolatedAgentEnv(
  baseEnv: NodeJS.ProcessEnv,
  broker: IsolatedToolBroker | null,
  agentId?: string,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (STRIPPED_ISOLATED_ENV_KEYS.has(key.toUpperCase())) delete env[key];
  }
  const paths = broker?.paths;
  if (paths) {
    Object.assign(env, broker.clientEnv, {
      HOME: paths.home,
      USERPROFILE: paths.home,
      XDG_CACHE_HOME: path.join(paths.home, '.cache'),
      XDG_CONFIG_HOME: path.join(paths.home, '.config'),
      XDG_DATA_HOME: path.join(paths.home, '.local', 'share'),
      XDG_STATE_HOME: path.join(paths.home, '.local', 'state'),
      TEMP: paths.temp,
      TMP: paths.temp,
      TMPDIR: paths.temp,
      READABLE_BIN: paths.clientPath,
      READABLE_NODE_BIN: paths.nodeBin,
    });
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main']
      .filter(Boolean)
      .join(' ');
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [path.dirname(paths.nodeBin), env[pathKey]].filter(Boolean).join(path.delimiter);
    if (agentId === 'codex') env.CODEX_HOME = path.join(paths.home, '.codex');
    if (agentId === 'claude') env.CLAUDE_CONFIG_DIR = path.join(paths.home, '.claude');
    if (agentId === 'amr') env.OPENCODE_TEST_HOME = path.join(paths.home, '.opencode');
  }
  return env;
}
