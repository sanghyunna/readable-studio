import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const hostedPiPackageName = '@earendil-works/pi-coding-agent';
const hostedPiVersion = '0.83.0';
const hostedPiIntegrity = 'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==';
const photonVersion = '0.3.4';
const defaultOutput = path.join(repoRoot, '.tmp', 'hosted-pi-artifact');
const hostedPiSmokeTimeoutMs = 60_000;

type JsonObject = Record<string, unknown>;

async function brokerSocketRequest(socketPath: string, request: JsonObject): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('hosted Pi broker socket request timed out'));
    }, 5_000);
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(() => resolve(JSON.parse(buffer.slice(0, newline)) as JsonObject));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

function fail(message: string): never {
  throw new Error(`[hosted-pi-artifact] ${message}`);
}

function readJson(file: string): JsonObject {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  } catch (error) {
    fail(`cannot read JSON ${path.relative(repoRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function packageRoot(stage: string): string {
  const root = path.join(stage, 'node_modules', '@earendil-works', 'pi-coding-agent');
  if (!existsSync(root)) fail(`staged Pi package is missing: ${root}`);
  return realpathSync(root);
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const WORKSPACE_SELF_LINK = path.join('node_modules', '.pnpm', 'node_modules', '@readable-studio', 'daemon');

type RelocationContext = {
  sourceRoot: string;
  destinationRoot: string;
  active: Set<string>;
  hardlinks: Map<string, string>;
};

function mappedLinkTarget(sourceRoot: string, destinationRoot: string, source: string): string | null {
  const raw = readlinkSync(source);
  const resolved = path.resolve(path.dirname(source), raw);
  if (!pathInside(sourceRoot, resolved)) {
    if (path.relative(sourceRoot, source) === path.relative(sourceRoot, path.join(sourceRoot, WORKSPACE_SELF_LINK))) return null;
    fail(`staged dependency link escapes the deploy root: ${path.relative(sourceRoot, source)}`);
  }
  return path.join(destinationRoot, path.relative(sourceRoot, resolved));
}

function tryCreateRelativeLink(target: string, destination: string, directory: boolean): boolean {
  const relative = path.relative(path.dirname(destination), target);
  try {
    if (process.platform === 'win32') {
      symlinkSync(relative, destination, directory ? 'dir' : 'file');
    } else {
      symlinkSync(relative, destination);
    }
    return true;
  } catch {
    return false;
  }
}

function copyRelocatableTree(source: string, destination: string, context: RelocationContext): void {
  const metadata = lstatSync(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (metadata.isSymbolicLink()) {
    const target = mappedLinkTarget(context.sourceRoot, context.destinationRoot, source);
    if (!target) return;
    if (tryCreateRelativeLink(target, destination, statSync(source).isDirectory())) return;
    copyRelocatableTree(path.resolve(path.dirname(source), readlinkSync(source)), destination, context);
    return;
  }
  if (metadata.isDirectory()) {
    const resolved = realpathSync(source);
    if (context.active.has(resolved)) return;
    context.active.add(resolved);
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyRelocatableTree(path.join(source, entry), path.join(destination, entry), context);
    }
    context.active.delete(resolved);
    return;
  }
  const resolved = realpathSync(source);
  const previous = context.hardlinks.get(resolved);
  if (previous) {
    try {
      linkSync(previous, destination);
      return;
    } catch {
      // Files may cross a filesystem boundary in a downloaded artifact; copy
      // the bytes when a hardlink cannot be recreated.
    }
  }
  copyFileSync(source, destination);
  context.hardlinks.set(resolved, destination);
}

function relocateTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  copyRelocatableTree(source, destination, {
    sourceRoot: source,
    destinationRoot: destination,
    active: new Set(),
    hardlinks: new Map(),
  });
}

function removeWorkspaceSelfLink(stage: string): void {
  const link = path.join(stage, WORKSPACE_SELF_LINK);
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
}

function verifyRelocatableTree(stage: string): void {
  const oldRoot = path.resolve(stage);
  const links: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        if (path.isAbsolute(readlinkSync(current))) fail(`artifact link is not relocatable: ${path.relative(oldRoot, current)}`);
        const resolved = realpathSync(current);
        if (!pathInside(oldRoot, resolved)) fail(`artifact link escapes the delivered root: ${path.relative(oldRoot, current)}`);
        links.push(path.relative(oldRoot, current));
      } else if (metadata.isDirectory()) {
        walk(current);
      }
    }
  };
  walk(oldRoot);
  void links;
}

function verifyPackage(stage: string): {
  piRoot: string;
  piManifest: JsonObject;
  photonRoot: string;
  photonManifest: JsonObject;
  photonWasm: string;
} {
  const piRoot = packageRoot(stage);
  const piManifest = readJson(path.join(piRoot, 'package.json'));
  if (piManifest.name !== hostedPiPackageName || piManifest.version !== hostedPiVersion) {
    fail(`staged Pi package is not ${hostedPiPackageName}@${hostedPiVersion}`);
  }
  const entrypoint = path.join(piRoot, 'dist', 'rpc-entry.js');
  if (!lstatSync(entrypoint).isFile()) fail('staged Pi RPC entrypoint is missing');

  const lockfile = path.join(stage, 'node_modules', '.pnpm', 'lock.yaml');
  if (!existsSync(lockfile)) fail('staged production lockfile is missing');
  const lockText = readFileSync(lockfile, 'utf8');
  if (!lockText.includes(`${hostedPiPackageName}@${hostedPiVersion}`)) {
    fail('staged lockfile does not contain the pinned Pi package');
  }
  if (!lockText.includes(hostedPiIntegrity)) fail('staged lockfile lost the pinned Pi integrity');

  let photonRoot: string;
  try {
    const requireFromPi = createRequire(path.join(piRoot, 'package.json'));
    photonRoot = path.dirname(requireFromPi.resolve('@silvia-odwyer/photon-node'));
  } catch {
    fail('Photon dependency is missing from the staged Pi package');
  }
  const photonManifest = readJson(path.join(photonRoot, 'package.json'));
  if (photonManifest.version !== photonVersion) fail(`Photon version must be ${photonVersion}`);
  const photonWasm = path.join(photonRoot, 'photon_rs_bg.wasm');
  if (!lstatSync(photonWasm).isFile()) fail('Photon WASM asset is missing');
  if (!existsSync(path.join(photonRoot, 'LICENSE.md'))) fail('Photon license file is missing');
  if (existsSync(path.join(stage, 'node_modules', '@mariozechner', 'clipboard'))) {
    fail('optional clipboard package must not be required by the hosted artifact');
  }

  return { piRoot, piManifest, photonRoot: realpathSync(photonRoot), photonManifest, photonWasm };
}

function collectDependencies(stage: string): Array<Record<string, unknown>> {
  const store = path.join(stage, 'node_modules', '.pnpm');
  const entries = new Map<string, Record<string, unknown>>();
  for (const packageStore of readdirSync(store, { withFileTypes: true })) {
    if (!packageStore.isDirectory() || packageStore.name === '.bin') continue;
    const modules = path.join(store, packageStore.name, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const scopeOrPackage of readdirSync(modules, { withFileTypes: true })) {
      const candidates = scopeOrPackage.name.startsWith('@')
        ? readdirSync(path.join(modules, scopeOrPackage.name), { withFileTypes: true }).map((child) => path.join(scopeOrPackage.name, child.name))
        : [scopeOrPackage.name];
      for (const relative of candidates) {
        const manifestPath = path.join(modules, relative, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = readJson(manifestPath);
        if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
        const key = `${manifest.name}@${manifest.version}`;
        if (entries.has(key)) continue;
        entries.set(key, {
          name: manifest.name,
          version: manifest.version,
          license: manifest.license ?? null,
          repository: manifest.repository ?? null,
        });
      }
    }
  }
  return [...entries.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function verifyArtifact(stage: string, writeManifest: boolean): void {
  if (!existsSync(stage)) fail(`artifact does not exist: ${stage}`);
  const { piRoot, piManifest, photonManifest, photonWasm } = verifyPackage(stage);
  const manifest = {
    schemaVersion: 1,
    builtOn: { platform: process.platform, arch: process.arch, node: process.version },
    packageManager: 'pnpm deploy --prod --no-optional --ignore-scripts --legacy',
    pi: {
      name: hostedPiPackageName,
      version: hostedPiVersion,
      integrity: hostedPiIntegrity,
      license: piManifest.license ?? null,
      entrypoint: path.relative(stage, path.join(piRoot, 'dist', 'rpc-entry.js')),
    },
    photon: {
      name: '@silvia-odwyer/photon-node',
      version: photonVersion,
      license: photonManifest.license ?? null,
      wasm: path.relative(stage, photonWasm),
      wasmSha256: sha256(photonWasm),
    },
    dependencies: collectDependencies(stage),
    lockfileSha256: sha256(path.join(stage, 'node_modules', '.pnpm', 'lock.yaml')),
  };
  if (writeManifest) writeFileSync(path.join(stage, 'hosted-pi-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  else {
    const recorded = readJson(path.join(stage, 'hosted-pi-manifest.json'));
    const recordedPi = recorded.pi as JsonObject | undefined;
    const recordedPhoton = recorded.photon as JsonObject | undefined;
    if (recorded.schemaVersion !== manifest.schemaVersion
      || recordedPi?.name !== manifest.pi.name
      || recordedPi.version !== hostedPiVersion
      || recordedPi.integrity !== hostedPiIntegrity
      || recordedPi.license !== manifest.pi.license
      || recordedPi.entrypoint !== manifest.pi.entrypoint) {
      fail('hosted manifest does not match the pinned Pi package');
    }
    if (recordedPhoton?.name !== manifest.photon.name
      || recordedPhoton.version !== photonVersion
      || recordedPhoton.license !== manifest.photon.license
      || recordedPhoton.wasm !== manifest.photon.wasm
      || recordedPhoton.wasmSha256 !== manifest.photon.wasmSha256) {
      fail('hosted manifest does not match the staged Photon WASM');
    }
    if (!Array.isArray(recorded.dependencies) || recorded.dependencies.length === 0) {
      fail('hosted manifest is missing the dependency inventory');
    }
    if (JSON.stringify(recorded.dependencies) !== JSON.stringify(manifest.dependencies)) {
      fail('hosted manifest dependency inventory does not match the staged artifact');
    }
    if (recorded.lockfileSha256 !== manifest.lockfileSha256) fail('hosted manifest lockfile hash does not match the staged lockfile');
  }
}

function packageManagerCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runBuildCommand(args: string[]): void {
  const result = spawnSync(packageManagerCommand(), args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) fail(`failed to run pnpm: ${result.error.message}`);
  if (result.status !== 0) fail(`pnpm ${args.join(' ')} exited with ${result.status ?? 'signal'}`);
}

function auditHostedProductionGraph(stage: string): void {
  const auditRoot = mkdtempSync(path.join(os.tmpdir(), 'readable-hosted-pi-audit-'));
  try {
    // Running from outside the workspace prevents pnpm from silently auditing
    // unrelated web/tools importers. The deployed package manifest and its
    // production lockfile are the complete graph being shipped.
    copyFileSync(path.join(stage, 'package.json'), path.join(auditRoot, 'package.json'));
    copyFileSync(path.join(stage, 'node_modules', '.pnpm', 'lock.yaml'), path.join(auditRoot, 'pnpm-lock.yaml'));
    const result = spawnSync(packageManagerCommand(), ['audit', '--dir', auditRoot, '--prod', '--no-optional', '--audit-level', 'high', '--json'], {
      cwd: auditRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (result.error) fail(`failed to run the hosted production dependency audit: ${result.error.message}`);
    let report: JsonObject;
    try {
      report = JSON.parse(result.stdout) as JsonObject;
    } catch (error) {
      fail(`hosted production dependency audit did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const advisories = report.advisories as Record<string, JsonObject> | undefined;
    const violations: string[] = [];
    for (const advisory of Object.values(advisories ?? {})) {
      const severity = advisory.severity;
      if (severity !== 'high' && severity !== 'critical') continue;
      for (const finding of (advisory.findings as JsonObject[] | undefined) ?? []) {
        violations.push(`${String(advisory.module_name)}@${String(finding.version)} (${String(severity)})`);
      }
    }
    if (violations.length > 0 || result.status !== 0) {
      fail(`hosted production dependency graph has high/critical advisories: ${[...new Set(violations)].join(', ') || 'audit failed'}`);
    }
  } finally {
    rmSync(auditRoot, { recursive: true, force: true });
  }
}

function parseOutput(): string {
  const index = process.argv.indexOf('--out');
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return path.resolve(repoRoot, raw ?? defaultOutput);
}

function build(stage: string): void {
  const tmpRoot = path.join(repoRoot, '.tmp');
  const relative = path.relative(tmpRoot, stage);
  const deployStage = `${stage}.deploy-${process.pid}`;
  if (stage === repoRoot || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || existsSync(stage) || existsSync(deployStage)) {
    fail(`refusing to overwrite output outside a fresh .tmp directory: ${stage}`);
  }
  mkdirSync(path.dirname(stage), { recursive: true });
  runBuildCommand(['--filter', '@readable-studio/daemon', 'build']);
  runBuildCommand(['--filter', '@readable-studio/daemon', 'deploy', '--prod', '--no-optional', '--ignore-scripts', '--legacy', deployStage]);
  removeWorkspaceSelfLink(deployStage);
  relocateTree(deployStage, stage);
  rmSync(deployStage, { recursive: true, force: true });
  verifyRelocatableTree(stage);
  verifyArtifact(stage, true);
  auditHostedProductionGraph(stage);
  process.stdout.write(`Hosted Pi artifact staged at ${stage}\n`);
}

type Child = ReturnType<typeof spawn>;

const HOSTED_PI_FIXTURE_PROVIDER = `
import { appendFileSync } from 'node:fs';
const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(stopReason = 'stop', useBroker = false, text = 'hosted fixture response') {
  return {
    role: 'assistant',
    content: useBroker
      ? [{ type: 'toolCall', id: 'hosted-broker-call', name: 'readable_hosted_broker', arguments: { operation: 'project:file:read', path: 'large.txt' } }]
      : [{ type: 'text', text: stopReason === 'stop' ? text : '' }],
    api: 'openai-completions',
    provider: 'hosted-fixture',
    model: 'fixture-model',
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}
function stream(context = {}, options = {}) {
  if (process.env.HOSTED_PI_PROVIDER_MARKER) {
    appendFileSync(process.env.HOSTED_PI_PROVIDER_MARKER, 'invoked\\n');
  }
  const hasToolResult = Array.isArray(context.messages)
    && context.messages.some((item) => item?.role === 'toolResult');
  const contextSentinel = process.env.HOSTED_PI_CONTEXT_SENTINEL;
  const contextText = JSON.stringify(context);
  const semanticNonce = contextText.match(/semantic-nonce:([0-9a-f-]+)/)?.[1];
  const responseText = semanticNonce ? 'semantic-nonce:' + semanticNonce : 'semantic-nonce:missing';
  const projectContextLoaded = typeof contextSentinel === 'string'
    && contextSentinel.length > 0
    && contextText.includes(contextSentinel);
  const useBroker = Boolean(process.env.READABLE_HOSTED_PI_BROKER_SOCKET)
    && !hasToolResult
    && !projectContextLoaded;
  let final = message(useBroker ? 'toolUse' : 'stop', useBroker, responseText);
  if (projectContextLoaded) {
    final = message('stop', false);
    final.content = [{ type: 'text', text: 'hosted-project-context-sentinel:' + contextSentinel }];
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
  const events = async function* () {
    if (options.signal?.aborted) { final = message('aborted'); yield { type: 'error', reason: 'aborted', error: final }; return; }
    yield { type: 'start', partial: final };
    if (process.env.HOSTED_PI_FORCE_HANG === '1') {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return;
    }
    await pause();
    if (options.signal?.aborted) { final = message('aborted'); yield { type: 'error', reason: 'aborted', error: final }; return; }
    if (useBroker) {
      const block = final.content[0];
      const delta = JSON.stringify(block.arguments);
      yield { type: 'toolcall_start', contentIndex: 0, partial: final };
      await pause();
      yield { type: 'toolcall_delta', contentIndex: 0, delta, partial: final };
      await pause();
      yield { type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: final };
      yield { type: 'done', reason: 'toolUse', message: final };
      return;
    }
    yield { type: 'text_start', contentIndex: 0, partial: final };
    await pause();
    yield { type: 'text_delta', contentIndex: 0, delta: responseText, partial: final };
    await pause();
    yield { type: 'text_end', contentIndex: 0, content: responseText, partial: final };
    await pause();
    yield { type: 'done', reason: 'stop', message: final };
  };
  return { [Symbol.asyncIterator]: events, result: async () => final };
}
export default function hostedPiFixtureProvider(pi) {
  pi.registerProvider({
    id: 'hosted-fixture',
    name: 'Hosted fixture',
    auth: { apiKey: { name: 'Hosted fixture', check: async () => ({ type: 'api_key', source: 'fixture' }), resolve: async () => ({ auth: { apiKey: 'fixture' }, source: 'fixture' }) } },
    getModels: () => [{
      id: 'fixture-model', name: 'Hosted fixture', api: 'openai-completions', provider: 'hosted-fixture', baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, supportsStrictMode: false, maxTokensField: 'max_tokens' },
    }],
    stream: (_model, context, options) => stream(context, options),
    streamSimple: (_model, context, options) => stream(context, options),
  });
}
`;

const HOSTED_PI_NETWORK_GUARD = `
const fs = require('node:fs');
fs.writeFileSync(process.env.HOSTED_PI_GUARD_MARKER, 'loaded');
const deny = () => { throw new Error('hosted Pi smoke attempted network or process execution'); };
global.fetch = deny;
const net = require('node:net');
const brokerSocket = process.env.READABLE_HOSTED_PI_BROKER_SOCKET;
const allowBrokerSocket = (original) => function (...args) {
  const first = args[0];
  const socket = typeof first === 'string' ? first : first && typeof first.path === 'string' ? first.path : undefined;
  if (socket !== brokerSocket) return deny();
  return original.apply(this, args);
};
for (const method of ['connect', 'createConnection']) if (method in net) net[method] = allowBrokerSocket(net[method]);
for (const name of ['node:http', 'node:https', 'node:tls', 'node:dgram', 'node:dns', 'node:http2']) {
  const mod = require(name);
  for (const method of ['request', 'get', 'connect', 'createConnection', 'lookup', 'lookupService', 'resolve']) if (method in mod) mod[method] = deny;
}
const childProcess = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = deny;
`;

function send(child: Child, value: JsonObject): void {
  child.stdin?.write(`${JSON.stringify(value)}\n`);
}

type StagedPiRpcSession = {
  readonly ownsAbortLifecycle: true;
  hasFatalError(): boolean;
  abort(): void;
  getLastSessionPath(): string | null;
};

type StagedPiRpc = {
  attachPiRpcSession(options: {
    child: Child;
    prompt: string;
    cwd: string;
    sessionDir: string;
    model: string;
    send(channel: string, payload: JsonObject): void;
    resumeSession?: {
      path: string;
      root: string;
    };
  }): StagedPiRpcSession;
};

type StagedInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
};

async function waitForChildClose(child: Child, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timed out waiting for hosted Pi child to close'));
    }, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runSemanticResumeSmoke(options: {
  piRpc: StagedPiRpc;
  invocation: StagedInvocation;
  nonce: string;
}): Promise<void> {
  const runTurn = async (prompt: string, turnOptions: {
    resumePath?: string;
    abortOn?: 'turn_start' | 'message_start';
    forceExitFallback?: boolean;
  } = {}) => {
    const previousGrace = process.env.PI_GRACEFUL_SHUTDOWN_MS;
    if (turnOptions.forceExitFallback) process.env.PI_GRACEFUL_SHUTDOWN_MS = '100';
    const child = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.invocation.cwd,
      env: {
        ...options.invocation.env,
        ...(turnOptions.forceExitFallback ? { HOSTED_PI_FORCE_HANG: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rawLines: JsonObject[] = [];
    const events: Array<{ channel: string } & JsonObject> = [];
    let session: StagedPiRpcSession | null = null;
    let pending = '';
    let stderr = '';
    let abortSent = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonObject;
            rawLines.push(parsed);
            if (!abortSent && turnOptions.abortOn === parsed.type) {
              abortSent = true;
              session?.abort();
            }
          } catch { /* stderr carries diagnostics */ }
        }
        newline = pending.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    session = options.piRpc.attachPiRpcSession({
      child,
      prompt,
      cwd: options.invocation.cwd,
      sessionDir: options.invocation.sessionDir,
      model: 'hosted-fixture/fixture-model',
      send: (channel, payload) => events.push({ channel, ...payload }),
      ...(turnOptions.resumePath
        ? { resumeSession: { path: turnOptions.resumePath, root: options.invocation.sessionDir } }
        : {}),
    });
    try {
      await waitForChildClose(child, hostedPiSmokeTimeoutMs);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPi stdout types: ${rawLines.map((line) => String(line.type ?? '?')).join(', ')}${stderr.trim() ? `\nPi stderr:\n${stderr.trim()}` : ''}`);
    } finally {
      if (turnOptions.forceExitFallback) {
        if (previousGrace === undefined) delete process.env.PI_GRACEFUL_SHUTDOWN_MS;
        else process.env.PI_GRACEFUL_SHUTDOWN_MS = previousGrace;
      }
    }
    if (session.hasFatalError()) fail(`semantic Pi turn failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    return { rawLines, events, sessionPath: session.getLastSessionPath() };
  };

  const first = await runTurn(`Remember this exact semantic-nonce:${options.nonce}.`);
  if (!first.sessionPath) fail('settled Pi turn did not capture its authoritative session path');
  const settledIndex = first.rawLines.findIndex((line) => line.type === 'agent_settled');
  const stateIndex = first.rawLines.findIndex((line) => line.type === 'response' && line.command === 'get_state');
  if (settledIndex < 0 || stateIndex <= settledIndex) {
    fail('Pi session state was not captured through get_state after agent_settled');
  }

  const second = await runTurn('Return the exact semantic continuity nonce from the prior turn.', {
    resumePath: first.sessionPath,
  });
  const output = second.events
    .filter((event) => event.channel === 'agent' && event.type === 'text_delta')
    .map((event) => String(event.delta ?? ''))
    .join('');
  if (!output.includes(`semantic-nonce:${options.nonce}`)) {
    fail('a new turn-scoped Pi child did not semantically resume the prior session');
  }

  const cancelled = await runTurn('Cancel this fixture turn after it starts.', {
    abortOn: 'turn_start',
  });
  const cancelledEnd = cancelled.rawLines.findIndex((line) => line.type === 'agent_end');
  const cancelledSettled = cancelled.rawLines.findIndex((line) => line.type === 'agent_settled');
  const cancelledState = cancelled.rawLines.findIndex(
    (line) => line.type === 'response' && line.command === 'get_state',
  );
  if (!cancelled.sessionPath || cancelledEnd < 0 || cancelledSettled <= cancelledEnd || cancelledState <= cancelledSettled) {
    fail('cancelled Pi turn did not settle and capture authoritative session state before close');
  }

  const fallback = await runTurn('Cancel this fixture turn and force the bounded exit fallback.', {
    resumePath: first.sessionPath,
    abortOn: 'message_start',
    forceExitFallback: true,
  });
  if (!fallback.sessionPath || fallback.rawLines.some((line) => line.type === 'agent_settled')) {
    const lines = fallback.rawLines.map((line) => String(line.type)).join(', ');
    fail(`cancelled Pi turn did not use the child-exit session fallback (path=${fallback.sessionPath ?? 'null'}; lines=${lines})`);
  }
}

async function runRejectedResumeSmoke(options: {
  piRpc: StagedPiRpc;
  invocation: StagedInvocation;
  smokeRoot: string;
}): Promise<void> {
  const otherRoot = path.join(options.smokeRoot, 'invalid-owner-root');
  const otherCwd = path.join(options.smokeRoot, 'invalid-project');
  mkdirSync(otherRoot, { recursive: true });
  mkdirSync(otherCwd, { recursive: true });
  const validPath = path.join(options.invocation.sessionDir, 'valid.jsonl');
  const wrongCwdPath = path.join(options.invocation.sessionDir, 'wrong-cwd.jsonl');
  const cyclePath = path.join(options.invocation.sessionDir, 'cycle.jsonl');
  const header = (cwd: string, parentSession?: string) => `${JSON.stringify({
    type: 'session',
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
    ...(parentSession ? { parentSession } : {}),
  })}\n`;
  writeFileSync(validPath, header(options.invocation.cwd));
  writeFileSync(wrongCwdPath, header(otherCwd));
  writeFileSync(cyclePath, header(options.invocation.cwd, cyclePath));

  const cases = [
    { name: 'missing', path: path.join(options.invocation.sessionDir, 'missing.jsonl'), root: options.invocation.sessionDir },
    { name: 'out-of-root', path: validPath, root: otherRoot },
    { name: 'wrong-cwd', path: wrongCwdPath, root: options.invocation.sessionDir },
    { name: 'parent-cycle', path: cyclePath, root: options.invocation.sessionDir },
  ];
  for (const testCase of cases) {
    const providerMarker = path.join(options.smokeRoot, `invalid-provider-${testCase.name}`);
    rmSync(providerMarker, { force: true });
    const child = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.invocation.cwd,
      env: { ...options.invocation.env, HOSTED_PI_PROVIDER_MARKER: providerMarker },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = options.piRpc.attachPiRpcSession({
      child,
      prompt: 'must never reach the fixture provider',
      cwd: options.invocation.cwd,
      sessionDir: options.invocation.sessionDir,
      model: 'hosted-fixture/fixture-model',
      resumeSession: { path: testCase.path, root: testCase.root },
      send: () => {},
    });
    await waitForChildClose(child, 10_000);
    if (!session.hasFatalError() || existsSync(providerMarker)) {
      fail(`${testCase.name} session was not rejected before prompt/provider invocation`);
    }
  }
}

async function runRpcSmoke(stage: string): Promise<void> {
  const runtimeDir = path.join(stage, 'dist', 'runtimes');
  const fixturePath = path.join(runtimeDir, 'hosted-pi-fixture-provider.ts');
  const runtime = await import(pathToFileURL(path.join(runtimeDir, 'hosted-pi-runtime.js')).href);
  const piRpc = await import(pathToFileURL(path.join(stage, 'dist', 'pi-rpc.js')).href) as StagedPiRpc;
  const brokerModule = await import(pathToFileURL(path.join(runtimeDir, 'hosted-pi-broker.js')).href);
  const smokeRoot = path.join(os.tmpdir(), `readable-hosted-pi-smoke-${process.pid}-${Date.now()}`);
  const project = path.join(smokeRoot, 'project');
  const runtimeRoot = path.join(smokeRoot, 'runtime');
  const sessionDir = path.join(smokeRoot, 'sessions');
  const networkGuardPath = path.join(smokeRoot, 'deny-runtime.cjs');
  const networkGuardMarker = path.join(smokeRoot, 'network-guard.loaded');
  const maliciousMarker = path.join(smokeRoot, 'malicious-project-context.loaded');
  const contextSentinel = 'hosted-pi-project-context-sentinel-7f2c';
  mkdirSync(project, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(fixturePath, HOSTED_PI_FIXTURE_PROVIDER);
  const stagedRuntimeRoot = realpathSync(runtimeDir);
  const fixture = realpathSync(fixturePath);
  if (!lstatSync(fixture).isFile() || !pathInside(stagedRuntimeRoot, fixture)) {
    fail('hosted Pi smoke fixture escaped the staged runtime directory');
  }
  writeFileSync(networkGuardPath, HOSTED_PI_NETWORK_GUARD);
  writeFileSync(path.join(project, 'fixture.txt'), 'fixture');
  writeFileSync(path.join(project, 'large.txt'), `large-fixture-${'x'.repeat(128 * 1024)}${'\0'.repeat(1024 * 1024)}`);
  mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
  mkdirSync(path.join(project, '.pi', 'skills'), { recursive: true });
  mkdirSync(path.join(project, '.pi', 'prompts'), { recursive: true });
  mkdirSync(path.join(project, '.pi', 'themes'), { recursive: true });
  writeFileSync(path.join(project, '.pi', 'extensions', 'malicious.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(maliciousMarker)}, 'loaded');`);
  writeFileSync(path.join(project, '.pi', 'skills', 'malicious.md'), `malicious-skill-${contextSentinel}`);
  writeFileSync(path.join(project, '.pi', 'prompts', 'malicious.md'), `---\ndescription: malicious-prompt-${contextSentinel}\n---\nmalicious prompt`);
  writeFileSync(path.join(project, '.pi', 'themes', 'malicious.json'), `{"marker":${JSON.stringify(contextSentinel)}}`);
  writeFileSync(path.join(project, 'AGENTS.md'), `malicious-context-${contextSentinel}`);
  const semanticInvocation = runtime.createHostedPiInvocation({
    cwd: project,
    sessionDir: path.join(smokeRoot, 'semantic-sessions'),
    model: 'hosted-fixture/fixture-model',
  });
  semanticInvocation.args.push('--extension', fixture);
  semanticInvocation.env.NODE_OPTIONS = `--require=${networkGuardPath}`;
  semanticInvocation.env.HOSTED_PI_GUARD_MARKER = networkGuardMarker;
  await runRejectedResumeSmoke({
    piRpc,
    invocation: semanticInvocation,
    smokeRoot,
  });
  await runSemanticResumeSmoke({
    piRpc,
    invocation: semanticInvocation,
    nonce: randomUUID(),
  });
  const broker = await brokerModule.createHostedPiBroker({
    runtimeRoot,
    binding: {
      generation: 1,
      userKey: 'artifact-user',
      runId: 'artifact-run',
      projectId: 'artifact-project',
      projectRoot: project,
    },
  });
  const secondProject = path.join(smokeRoot, 'second-project');
  const secondRuntimeRoot = path.join(smokeRoot, 'second-runtime');
  mkdirSync(secondProject, { recursive: true });
  mkdirSync(secondRuntimeRoot, { recursive: true });
  writeFileSync(path.join(secondProject, 'fixture.txt'), 'second fixture');
  const secondBroker = await brokerModule.createHostedPiBroker({
    runtimeRoot: secondRuntimeRoot,
    binding: {
      generation: 1,
      userKey: 'second-user',
      runId: 'second-run',
      projectId: 'second-project',
      projectRoot: secondProject,
    },
  });
  const invocation = runtime.createHostedPiInvocation({
    cwd: project,
    sessionDir,
    model: 'hosted-fixture/fixture-model',
    broker,
  });
  // This explicit fixture argument is owned by this build/check script, not
  // by the production runtime API. The production invocation only accepts
  // the fixed broker extension.
  invocation.args.push('--extension', fixture);
  invocation.env.NODE_OPTIONS = `--require=${networkGuardPath}`;
  invocation.env.HOSTED_PI_GUARD_MARKER = networkGuardMarker;
  invocation.env.HOSTED_PI_CONTEXT_SENTINEL = contextSentinel;
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: JsonObject[] = [];
  let pending = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        try { lines.push(JSON.parse(line) as JsonObject); } catch { /* stderr carries diagnostics */ }
      }
      newline = pending.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  let cursor = 0;
  const waitForLine = (predicate: (line: JsonObject) => boolean): Promise<JsonObject> => new Promise((resolve, reject) => {
    let check: () => void;
    const timeout = setTimeout(() => {
      child.stdout?.off('data', check);
      reject(new Error('timed out waiting for hosted Pi RPC line'));
    }, hostedPiSmokeTimeoutMs);
    check = (): void => {
      for (; cursor < lines.length; cursor++) {
        const line = lines[cursor];
        if (line && predicate(line)) {
          cursor += 1;
          clearTimeout(timeout);
          child.stdout?.off('data', check);
          resolve(line);
          return;
        }
      }
    };
    child.stdout?.on('data', check);
    check();
  });
  try {
    const wrongSocketToken = await brokerSocketRequest(secondBroker.socketPath, {
      token: broker.token,
      operation: 'project:file:read',
      path: 'fixture.txt',
    });
    if (wrongSocketToken.code !== 'BROKER_TOKEN_INVALID') fail('broker token crossed a socket grant boundary');
    const outside = path.join(smokeRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
    for (const request of [
      { operation: 'project:file:read', path: '../outside/secret.txt' },
      { operation: 'project:file:read', path: path.join(outside, 'secret.txt') },
      { operation: 'project:file:read', path: '/etc/passwd' },
      { operation: 'project:file:write', path: '../outside/escape.txt', content: 'nope' },
    ]) {
      const denied = await broker.invoke({ token: broker.token, ...request });
      if (denied.ok !== false) fail(`broker accepted an unsafe path: ${request.path}`);
    }
    const linkedDirectory = path.join(project, 'linked-outside');
    try {
      symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      fail(`hosted artifact could not create its required junction/symlink attack fixture: ${error instanceof Error ? error.message : String(error)}`);
    }
    const linkedDenied = await broker.invoke({
      token: broker.token,
      operation: 'project:file:read',
      path: 'linked-outside/secret.txt',
    });
    if (linkedDenied.ok !== false) fail('broker followed a project junction/symlink');
    const brokerWrite = await broker.invoke({
      token: broker.grant.token,
      operation: 'project:file:write',
      path: 'broker-fixture.txt',
      content: 'broker fixture',
    });
    if (!brokerWrite.ok) fail(`staged broker write failed: ${brokerWrite.message}`);
    const brokerRead = await broker.invoke({
      token: broker.grant.token,
      operation: 'project:file:read',
      path: 'broker-fixture.txt',
    });
    if (!brokerRead.ok || brokerRead.content !== 'broker fixture') fail('staged broker read failed');
    const brokerList = await broker.invoke({
      token: broker.grant.token,
      operation: 'project:file:list',
      path: '',
    });
    if (!brokerList.ok || !brokerList.entries?.includes('fixture.txt')) fail('staged broker list failed');
    if (invocation.command !== process.execPath || invocation.env.PATH !== '') fail('smoke did not use the package-local Node invocation boundary');
    for (const command of ['pi', 'npm', 'pnpm', 'npx']) {
      const unavailable = spawnSync(command, ['--version'], {
        cwd: project,
        env: invocation.env,
        shell: false,
        stdio: 'ignore',
      });
      if (unavailable.status !== null) fail(`package manager or global Pi command resolved despite an empty PATH: ${command}`);
    }
    send(child, { id: 1, type: 'get_state' });
    const state = await waitForLine((line) => line.type === 'response' && line.id === 1);
    if (state.success !== true || !(state.data as JsonObject | undefined)?.sessionFile) fail('get_state did not return a session reference');
    if (!existsSync(networkGuardMarker)) fail('runtime network/process guard was not loaded');
    const sessionFile = (state.data as JsonObject).sessionFile as string;

    send(child, { id: 8, type: 'get_commands' });
    const commands = await waitForLine((line) => line.type === 'response' && line.id === 8);
    const commandText = JSON.stringify(commands.data);
    if (commands.success !== true
      || commandText.includes(contextSentinel)
      || commandText.includes('skill:malicious')
      || commandText.includes('malicious')) {
      fail('Pi exposed project-controlled prompt or skill commands');
    }

    send(child, { id: 2, type: 'prompt', message: 'deterministic fixture turn' });
    await waitForLine((line) => line.type === 'agent_end');
    await waitForLine((line) => line.type === 'agent_settled');
    if (!lines.some((line) => line.type === 'turn_end' && (line.message as JsonObject | undefined)?.usage)) {
      fail('fixture turn did not emit usage');
    }
    const brokerToolEnd = lines.find((line) => line.type === 'tool_execution_end'
      && line.toolName === 'readable_hosted_broker');
    if (!brokerToolEnd || brokerToolEnd.isError === true || !JSON.stringify(brokerToolEnd.result).includes('large-fixture')) {
      fail('Pi did not execute the staged readable_hosted_broker extension through the broker socket');
    }
    if (existsSync(maliciousMarker) || lines.some((line) => {
      const text = JSON.stringify(line);
      return text.includes(maliciousMarker) || text.includes(contextSentinel);
    })) {
      fail('Pi loaded project-controlled extensions, skills, themes, or context');
    }

    send(child, { id: 3, type: 'switch_session', sessionPath: sessionFile });
    const resumed = await waitForLine((line) => line.type === 'response' && line.id === 3);
    if (resumed.success !== true) fail('session resume was rejected');
    send(child, { id: 4, type: 'prompt', message: 'resumed fixture turn' });
    await waitForLine((line) => line.type === 'agent_end');
    await waitForLine((line) => line.type === 'agent_settled');

    send(child, { id: 5, type: 'prompt', message: 'cancel fixture turn' });
    await waitForLine((line) => line.type === 'turn_start');
    send(child, { id: 6, type: 'abort' });
    await waitForLine((line) => line.type === 'agent_end');
    const abortedTurn = lines.find((line) => line.type === 'turn_end'
      && ((line.message as JsonObject | undefined)?.stopReason === 'aborted'));
    if (!abortedTurn) fail('RPC cancellation did not produce an aborted turn');

    send(child, { id: 7, type: 'set_model', provider: 'missing', modelId: 'missing' });
    const error = await waitForLine((line) => line.type === 'response' && line.id === 7);
    if (error.success !== false) fail('invalid model error path unexpectedly succeeded');

    const rawChildClosed = waitForChildClose(child, 5_000);
    child.stdin?.end();
    child.kill();
    await rawChildClosed;
  } catch (error) {
    const detail = stderr.trim();
    const observed = lines.map((line) => String(line.type)).join(', ');
    const details = lines
      .filter((line) => line.type === 'turn_end' || line.type === 'response')
      .map((line) => {
        const serialized = JSON.stringify(line);
        return serialized.length > 4_096 ? `${serialized.slice(0, 4_096)}…` : serialized;
      })
      .join('\n');
    fail(`${error instanceof Error ? error.message : String(error)}\nObserved RPC lines: ${observed}\nRPC details:\n${details}${detail ? `\nPi stderr:\n${detail}` : ''}`);
  } finally {
    child.stdin?.end();
    if (!child.killed) child.kill();
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await broker.close();
    await secondBroker.close();
    rmSync(fixturePath, { force: true });
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

async function check(stage: string): Promise<void> {
  verifyArtifact(stage, false);
  verifyRelocatableTree(stage);
  const extractedRoot = mkdtempSync(path.join(os.tmpdir(), 'readable-hosted-pi-extracted-'));
  const extracted = path.join(extractedRoot, 'artifact');
  try {
    relocateTree(stage, extracted);
    verifyRelocatableTree(extracted);
    verifyArtifact(extracted, false);
    auditHostedProductionGraph(extracted);
    await runRpcSmoke(extracted);
  } finally {
    rmSync(extractedRoot, { recursive: true, force: true });
  }
  process.stdout.write(`Hosted Pi artifact check passed for ${process.platform}/${process.arch}\n`);
}

const command = process.argv[2] ?? 'build';
const output = parseOutput();
if (command === 'build') build(output);
else if (command === 'check') await check(output);
else fail(`unknown command ${command}; use build or check`);
