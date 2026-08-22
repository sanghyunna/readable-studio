import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import {
  canonicalProductName,
  PortableQaError,
  runCommand,
  toRecord,
  workspaceRoot,
  type CommandResult,
} from './portable-qa-support.ts';

const sevenZipPath = join(workspaceRoot, 'tools', 'pack', 'resources', 'win', '7zip', '7z.exe');

export type NetworkAttempt = {
  bytes: number;
  firstData: string;
  remoteAddress: string | undefined;
};

export type NetworkTrap = {
  readonly attempts: NetworkAttempt[];
  readonly proxyUrl: string;
  close(): Promise<void>;
};

export type AppCapture = {
  readonly app: ElectronApplication;
  readonly consoleMessages: string[];
  readonly namespace: string;
  readonly networkRequests: string[];
  readonly page: Page;
};

type ProcessRecord = {
  readonly commandLine: string;
  readonly executablePath: string;
  readonly name: string;
  readonly pid: number;
  readonly parentPid: number;
};

type ConnectionRecord = {
  readonly localAddress: string;
  readonly localPort: number;
  readonly owningProcess: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
};

export type ProcessEvidence = {
  readonly connections: readonly ConnectionRecord[];
  readonly processes: readonly ProcessRecord[];
};

export async function extractPortable(zipPath: string): Promise<string> {
  const archive = await stat(zipPath);
  assert.ok(archive.isFile(), `portable ZIP is not a file: ${zipPath}`);
  const extractionRoot = await mkdtemp(join(tmpdir(), 'readable-task30-portable-'));
  const result = await runCommand(sevenZipPath, ['x', zipPath, `-o${extractionRoot}`, '-y']);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const executablePath = join(extractionRoot, `${canonicalProductName}.exe`);
  assert.ok((await stat(executablePath)).isFile(), `missing ${executablePath}`);
  return extractionRoot;
}

export async function createNetworkTrap(): Promise<NetworkTrap> {
  const attempts: NetworkAttempt[] = [];
  const server: Server = createServer((socket) => {
    const attempt: NetworkAttempt = { bytes: 0, firstData: '', remoteAddress: socket.remoteAddress };
    attempts.push(attempt);
    socket.once('data', (chunk: Buffer) => {
      attempt.bytes = chunk.length;
      attempt.firstData = chunk.toString('utf8', 0, 512);
      socket.destroy();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new PortableQaError('network trap did not bind');
  return {
    attempts,
    proxyUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error == null ? resolveClose() : rejectClose(error));
    }),
  };
}

export function launchEnvironment(namespace: string, trap: NetworkTrap, offline: boolean): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
  return {
    ...inherited,
    READABLE_DESKTOP_LOG_ECHO: '1',
    READABLE_PACKAGED_NAMESPACE: namespace,
    ...(offline ? {
      ALL_PROXY: trap.proxyUrl,
      HTTP_PROXY: trap.proxyUrl,
      HTTPS_PROXY: trap.proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
    } : {}),
  };
}

function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  return new Promise<Page>((resolveWindow, rejectWindow) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      app.off('window', observeWindow);
      rejectWindow(new PortableQaError('timed out waiting for the packaged main window'));
    }, 600_000);
    const accept = (page: Page) => {
      if (settled || !page.url().startsWith('readable-studio://app/')) return;
      settled = true;
      clearTimeout(timeout);
      app.off('window', observeWindow);
      resolveWindow(page);
    };
    const observeWindow = (page: Page) => {
      accept(page);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) accept(page);
      });
    };
    app.on('window', observeWindow);
    for (const page of app.windows()) observeWindow(page);
  });
}

export async function launchPortable(extractionRoot: string, namespace: string, trap: NetworkTrap, offline: boolean): Promise<AppCapture> {
  const consoleMessages: string[] = [];
  const networkRequests: string[] = [];
  const app = await electron.launch({
    executablePath: join(extractionRoot, `${canonicalProductName}.exe`),
    env: launchEnvironment(namespace, trap, offline),
    timeout: 180_000,
  });
  app.on('console', (message) => consoleMessages.push(`[main:${message.type()}] ${message.text()}`));
  try {
    const page = await waitForMainWindow(app);
    page.on('console', (message) => consoleMessages.push(`[renderer:${message.type()}] ${message.text()}`));
    page.on('request', (request) => networkRequests.push(request.url()));
    await page.waitForFunction((expectedTitle) => document.title === expectedTitle, canonicalProductName, { timeout: 600_000 });
    await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 600_000 });
    return { app, consoleMessages, namespace, networkRequests, page };
  } catch (error) {
    await closePortable(app);
    throw error;
  }
}

export async function captureProcesses(rootPid: number): Promise<ProcessEvidence> {
  const script = [
    `$root=${rootPid}`,
    '$all=@(Get-CimInstance Win32_Process)',
    '$ids=New-Object System.Collections.Generic.HashSet[int]',
    '[void]$ids.Add($root)',
    'do { $before=$ids.Count; foreach($p in $all){ if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)} } } while($ids.Count -gt $before)',
    '$processes=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}})',
    '$connections=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$ids.Contains([int]$_.OwningProcess)} | ForEach-Object {@{owningProcess=[int]$_.OwningProcess;localAddress=[string]$_.LocalAddress;localPort=[int]$_.LocalPort;remoteAddress=[string]$_.RemoteAddress;remotePort=[int]$_.RemotePort;state=[string]$_.State}})',
    '@{processes=$processes;connections=$connections} | ConvertTo-Json -Depth 5 -Compress',
  ].join(';');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script]);
  assert.equal(result.exitCode, 0, result.stderr);
  return parseProcessEvidence(JSON.parse(result.stdout));
}

function parseProcessEvidence(value: unknown): ProcessEvidence {
  const source = toRecord(value, 'process evidence');
  const processValues = Array.isArray(source.processes) ? source.processes : source.processes == null ? [] : [source.processes];
  const connectionValues = Array.isArray(source.connections) ? source.connections : source.connections == null ? [] : [source.connections];
  const processes = processValues.map((entry) => {
    const record = toRecord(entry, 'process record');
    return {
      commandLine: String(record.commandLine ?? ''),
      executablePath: String(record.executablePath ?? ''),
      name: String(record.name ?? ''),
      parentPid: Number(record.parentPid),
      pid: Number(record.pid),
    };
  });
  const connections = connectionValues.map((entry) => {
    const record = toRecord(entry, 'connection record');
    return {
      localAddress: String(record.localAddress ?? ''),
      localPort: Number(record.localPort),
      owningProcess: Number(record.owningProcess),
      remoteAddress: String(record.remoteAddress ?? ''),
      remotePort: Number(record.remotePort),
      state: String(record.state ?? ''),
    };
  });
  return { connections, processes };
}

export function daemonUrlFromProcesses(evidence: ProcessEvidence): string {
  const daemon = evidence.processes.find((entry) => entry.commandLine.includes('--readable-studio-stamp-app=daemon'));
  assert.ok(daemon, 'packaged daemon process was not observed');
  const listener = evidence.connections.find((entry) => entry.owningProcess === daemon.pid && entry.state === 'Listen');
  assert.ok(listener, 'packaged daemon listening socket was not observed');
  return `http://127.0.0.1:${listener.localPort}`;
}

export async function runCli(extractionRoot: string, args: readonly string[], daemonUrl?: string, input?: string): Promise<CommandResult> {
  const node = join(extractionRoot, 'resources', 'readable-studio', 'bin', 'node.exe');
  const entry = join(extractionRoot, 'resources', 'app', 'prebundled', 'daemon', 'daemon-cli.mjs');
  const command = await runCommand(node, [entry, ...args, ...(daemonUrl == null ? [] : ['--daemon-url', daemonUrl])], input);
  assert.equal(command.exitCode, 0, `${command.stderr}\n${command.stdout}`);
  return command;
}

export async function closePortable(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  const closed = app.close();
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new PortableQaError('Electron application did not close within 15 seconds')), 15_000);
  });
  try {
    await Promise.race([closed, timeout]);
  } catch (error) {
    if (!(error instanceof PortableQaError)) throw error;
  } finally {
    if (pid != null) {
      try {
        await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], undefined, { timeoutMs: 10_000 });
      } catch {
        // process tree already gone; ignore
      }
    }
  }
}

export async function registrySnapshot(): Promise<Record<string, CommandResult>> {
  const entries = await Promise.all([canonicalProductName].map(async (name) => {
    const key = `HKCU\\Software\\${name}`;
    return [name, await runCommand('reg.exe', ['query', key, '/s'])] as const;
  }));
  return Object.fromEntries(entries);
}

export function assertPortableBoundaries(extractionRoot: string, capture: AppCapture, evidence: ProcessEvidence, trap: NetworkTrap): void {
  const namespaceRoot = join(extractionRoot, 'ReadableStudioData', 'namespaces', capture.namespace);
  assert.ok(evidence.processes.length >= 3, 'portable process tree is incomplete');
  for (const entry of evidence.processes) {
    const joined = `${entry.executablePath} ${entry.commandLine}`.toLowerCase();
    // The renderer can intentionally launch user tools (for example the
    // configured agent CLI). Those are not Electron children and may live in
    // the user's AppData; only processes belonging to this extraction are
    // subject to the portable Electron boundary.
    if (!joined.includes(extractionRoot.toLowerCase())) continue;
    const outsideExtraction = joined.replaceAll(extractionRoot.toLowerCase(), '<extraction>');
    assert.equal(outsideExtraction.includes('\\appdata\\'), false, `AppData fallback leak in pid ${entry.pid}`);
  }
  const services = evidence.processes.filter((entry) => /gpu-process|network\.mojom\.NetworkService/u.test(entry.commandLine));
  assert.ok(services.length >= 2, 'Chromium GPU/network service processes were not observed');
  for (const entry of services) assert.ok(entry.commandLine.includes(namespaceRoot), `pid ${entry.pid} is not namespace portable`);
  const externalConnections = evidence.connections.filter((entry) => entry.state === 'Established' && !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(entry.remoteAddress));
  assert.deepEqual(externalConnections, [], 'external TCP connections were observed');
  const externalRequests = capture.networkRequests.filter((url) => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) && !['127.0.0.1', 'localhost'].includes(parsed.hostname);
    } catch {
      return false;
    }
  });
  assert.deepEqual(externalRequests, [], 'external renderer requests were observed');
  assert.deepEqual(trap.attempts, [], 'offline proxy trap received traffic');
}
