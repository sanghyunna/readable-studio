import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type HostedProviderCredential,
  validateHostedProviderCredential,
} from '../hosted-runtime-registry.js';

export const HOSTED_PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
export const HOSTED_PI_PACKAGE_VERSION = '0.83.0';
export const HOSTED_PI_RPC_ENTRYPOINT = path.join('dist', 'rpc-entry.js');

export type HostedPiPackage = {
  packageRoot: string;
  entrypoint: string;
};

export type HostedPiInvocationOptions = {
  packageRoot?: string;
  cwd: string;
  sessionDir: string;
  credential?: HostedProviderCredential;
  model?: string | null;
  thinking?: string | null;
  broker?: {
    socketPath: string;
    token: string;
    extensionPath: string;
  };
  designSystemTool?: {
    readUrl: string;
    token: string;
  };
};

export type HostedPiInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  entrypoint: string;
  agentDir: string;
  sessionDir: string;
};

export type HostedPiRuntimeRequest = {
  /** Server-authenticated identity copied from the hosted request context. */
  userKey: string;
  runId: string;
  projectId: string;
  projectRoot: string;
  cwd: string;
  generation: number;
  designSystemId?: string | null;
  /** Server-owned credential captured by the hosted runtime lane. */
  credential?: HostedProviderCredential;
  model?: string | null;
  thinking?: string | null;
};

export type HostedPiRuntimeHandle = {
  invocation: HostedPiInvocation;
  close?: () => Promise<void>;
};

export type HostedPiDesignSystemGrantBinding = {
  readonly userKey: string;
  readonly runId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly designSystemId: string;
  /** The existing turn-scoped Pi broker token, used only as an HTTP carrier binding. */
  readonly carrierToken: string;
};

export type HostedPiDesignSystemGrant = {
  readonly token: string;
  revoke(): unknown | Promise<unknown>;
};

export type HostedPiDesignSystemTool = {
  readonly readUrl: string;
  readonly mintGrant: (
    binding: HostedPiDesignSystemGrantBinding,
  ) => HostedPiDesignSystemGrant | Promise<HostedPiDesignSystemGrant>;
};

export type HostedPiRuntimeAdapter = (
  request: HostedPiRuntimeRequest,
) => Promise<HostedPiRuntimeHandle>;

function defaultPackageRoot(): string {
  const packageEntry = fileURLToPath(import.meta.resolve(`${HOSTED_PI_PACKAGE_NAME}/rpc-entry`));
  return path.resolve(path.dirname(packageEntry), '..');
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
}

function realDirectory(input: string, label: string): string {
  if (!path.isAbsolute(input)) throw new Error(`${label} must be absolute`);
  try {
    if (!statSync(input).isDirectory()) throw new Error(`${label} must be a directory`);
    return realpathSync(input);
  } catch (error) {
    throw new Error(`hosted Pi ${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createOwnedDirectory(input: string, label: string): string {
  if (!path.isAbsolute(input)) throw new Error(`${label} must be absolute`);
  try {
    if (existsSync(input) && lstatSync(input).isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink or junction`);
    }
    mkdirSync(input, { recursive: true });
    const resolved = realpathSync(input);
    if (resolved !== path.resolve(input)) {
      throw new Error(`${label} must not resolve through a symlink or junction`);
    }
    return resolved;
  } catch (error) {
    throw new Error(`hosted Pi ${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readPackageManifest(packageRoot: string): { name?: unknown; version?: unknown } {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
  } catch (error) {
    throw new Error(`hosted Pi package manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveHostedPiEntrypoint(packageRoot = defaultPackageRoot()): HostedPiPackage {
  const root = realDirectory(packageRoot, 'package root');
  const manifest = readPackageManifest(root);
  if (manifest.name !== HOSTED_PI_PACKAGE_NAME || manifest.version !== HOSTED_PI_PACKAGE_VERSION) {
    throw new Error(
      `hosted Pi package must be ${HOSTED_PI_PACKAGE_NAME}@${HOSTED_PI_PACKAGE_VERSION}`,
    );
  }

  const entrypoint = path.join(root, HOSTED_PI_RPC_ENTRYPOINT);
  let resolvedEntrypoint: string;
  try {
    if (!statSync(entrypoint).isFile()) throw new Error('entrypoint is not a file');
    resolvedEntrypoint = realpathSync(entrypoint);
  } catch (error) {
    throw new Error(`hosted Pi package-local RPC entrypoint is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!pathInside(root, resolvedEntrypoint)) {
    throw new Error('hosted Pi package-local RPC entrypoint escapes the pinned package root');
  }
  return { packageRoot: root, entrypoint: resolvedEntrypoint };
}

function appendValue(args: string[], flag: string, value: string | null | undefined): void {
  if (typeof value === 'string' && value.length > 0) args.push(flag, value);
}

function resolveOwnedExtension(input: string, label: string): string {
  if (!path.isAbsolute(input) || !existsSync(input)) {
    throw new Error(`hosted Pi ${label} is unavailable`);
  }
  let resolved: string;
  try {
    if (!statSync(input).isFile()) throw new Error('not a file');
    resolved = realpathSync(input);
  } catch (error) {
    throw new Error(`hosted Pi ${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const runtimeRoot = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  if (!pathInside(runtimeRoot, resolved)) {
    throw new Error(`hosted Pi ${label} must be repository-owned`);
  }
  return resolved;
}

function exactDesignSystemReadUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error('hosted Pi design-system read URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('hosted Pi design-system read URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/api/tools/design-systems/read'
    || url.toString() !== input
  ) {
    throw new Error('hosted Pi design-system read URL is invalid');
  }
  return input;
}

function exactToolToken(input: string): string {
  if (typeof input !== 'string' || !/^odds_[A-Za-z0-9_-]{43}$/u.test(input)) {
    throw new Error('hosted Pi design-system tool token is invalid');
  }
  return input;
}

/**
 * Build the only supported hosted Pi child invocation.
 *
 * This intentionally does not inherit the daemon environment: provider
 * credentials, package-manager variables, global agent overrides, and daemon
 * tool tokens are all absent until a later hosted composition explicitly
 * supplies a broker-bound capability.
 */
export function createHostedPiInvocation(options: HostedPiInvocationOptions): HostedPiInvocation {
  const packageInfo = resolveHostedPiEntrypoint(options.packageRoot);
  const cwd = realDirectory(options.cwd, 'project cwd');
  const sessionDir = createOwnedDirectory(options.sessionDir, 'session directory');
  const agentDir = createOwnedDirectory(path.join(sessionDir, 'agent-config'), 'agent config directory');
  const credential = options.credential == null
    ? null
    : validateHostedProviderCredential(options.credential);

  const args = [
    packageInfo.entrypoint,
    '--mode', 'rpc',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--offline',
    '--session-dir', sessionDir,
  ];
  const brokerEnv: NodeJS.ProcessEnv = credential == null
    ? {}
    : credential.provider === 'anthropic'
    ? { ANTHROPIC_API_KEY: credential.key }
    : { AI_GATEWAY_API_KEY: credential.key };
  const ownedExtensions: string[] = [];
  if (options.broker) {
    const extensionPath = resolveOwnedExtension(options.broker.extensionPath, 'broker extension');
    if (!path.isAbsolute(options.broker.socketPath) || options.broker.token.length === 0) {
      throw new Error('hosted Pi broker connection is invalid');
    }
    ownedExtensions.push(extensionPath);
    brokerEnv.READABLE_HOSTED_PI_BROKER_SOCKET = options.broker.socketPath;
    brokerEnv.READABLE_HOSTED_PI_BROKER_TOKEN = options.broker.token;
  }
  if (options.designSystemTool) {
    if (!options.broker) throw new Error('hosted Pi design-system tool requires the broker carrier');
    brokerEnv.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL = exactDesignSystemReadUrl(
      options.designSystemTool.readUrl,
    );
    brokerEnv.READABLE_TOOL_TOKEN = exactToolToken(options.designSystemTool.token);
  }
  for (const extension of ownedExtensions) args.push('--extension', extension);
  if (options.broker) args.push('--tools', 'readable_hosted_broker');
  appendValue(args, '--model', options.model);
  appendValue(args, '--thinking', options.thinking);

  return {
    command: process.execPath,
    args,
    cwd,
    env: {
      PATH: '',
      PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      ...brokerEnv,
    },
    packageRoot: packageInfo.packageRoot,
    entrypoint: packageInfo.entrypoint,
    agentDir,
    sessionDir,
  };
}

export function hostedPiBrokerExtensionPath(): string {
  const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(runtimeRoot, 'hosted-pi-broker-extension.js');
  return existsSync(compiled) ? compiled : path.join(runtimeRoot, 'hosted-pi-broker-extension.ts');
}
