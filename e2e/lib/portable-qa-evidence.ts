import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { PortableQaError, runCommand, toRecord, writeEvidence, type CleanupResult } from '../scripts/portable-qa-support.ts';

export type ActionEvidence = {
  readonly cleanActionCount: number;
  readonly conflictActionsRetained: boolean;
  readonly conflictStatus: number;
  readonly discardExited: boolean;
  readonly discardRestored: boolean;
  readonly dirtyActionCount: number;
  readonly orderedVisibleLabels: readonly string[];
  readonly saveExited: boolean;
  readonly saveStatus: number;
  readonly undoClean: boolean;
  readonly writesAfterDiscard: number;
  readonly writesAfterSave: number;
  readonly writesBeforeSave: number;
};

export type RunLifecycle = {
  readonly extractionRoots: readonly string[];
  readonly listenerPorts: readonly number[];
  readonly rootPids: readonly number[];
  readonly runtimePaths: readonly string[];
};

export type FullRunResult = {
  readonly actionEvidence: ActionEvidence;
  readonly detail: Record<string, unknown>;
  readonly lifecycle: RunLifecycle;
};

type CleanupReceiptInput = {
  readonly cleanup: CleanupResult;
  readonly evidenceRoot: string;
  readonly lifecycle: RunLifecycle;
  readonly proxyPort: number;
  readonly zipPath: string;
};

type PostCleanupState = {
  readonly connections: readonly Record<string, unknown>[];
  readonly listeners: readonly Record<string, unknown>[];
  readonly processes: readonly Record<string, unknown>[];
  readonly stampedProcesses: readonly Record<string, unknown>[];
};

export async function observeTransactionActions(page: Page): Promise<readonly string[]> {
  const labels = await page.locator('.manual-edit-left-inspector-footer button:visible').allTextContents();
  return labels.map((label) => label.trim());
}

export async function transactionActionCount(page: Page): Promise<number> {
  return (await observeTransactionActions(page)).length;
}

export async function writeActionsEvidence(root: string, evidence: ActionEvidence): Promise<void> {
  await writeEvidence(root, 'actions.json', {
    observables: evidence,
    status: 'workflow-passed',
    workflow: 'full',
  });
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectHash);
    stream.once('end', resolveHash);
  });
  return hash.digest('hex').toUpperCase();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function capturePostCleanupState(input: RunLifecycle & { readonly listenerPorts: readonly number[] }): Promise<PostCleanupState> {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const script = [
    `$input=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    '$roots=@($input.extractionRoots | ForEach-Object {([string]$_).ToLowerInvariant()})',
    '$all=@(Get-CimInstance Win32_Process)',
    '$processes=@($all | Where-Object { $command=[string]$_.CommandLine; $executable=[string]$_.ExecutablePath; $joined=($command+" "+$executable).ToLowerInvariant(); @($roots | Where-Object {$joined.Contains($_)}).Count -gt 0 } | ForEach-Object {@{pid=[int]$_.ProcessId;name=[string]$_.Name;commandLine=[string]$_.CommandLine;executablePath=[string]$_.ExecutablePath}})',
    '$stampedProcesses=@($processes | Where-Object {([string]$_.commandLine) -like "*--readable-studio-stamp-*"})',
    '$processIds=@($processes | ForEach-Object {[int]$_.pid})',
    '$ports=@($input.listenerPorts | ForEach-Object {[int]$_})',
    '$activeStates=@("Listen","Established","SynSent","SynReceived","FinWait1","FinWait2","CloseWait","Closing","LastAck")',
    '$connections=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $activeStates -contains [string]$_.State -and (($ports -contains [int]$_.LocalPort) -or ($ports -contains [int]$_.RemotePort) -or ($processIds -contains [int]$_.OwningProcess)) } | ForEach-Object {@{owningProcess=[int]$_.OwningProcess;localAddress=[string]$_.LocalAddress;localPort=[int]$_.LocalPort;remoteAddress=[string]$_.RemoteAddress;remotePort=[int]$_.RemotePort;state=[string]$_.State}})',
    '$listeners=@($connections | Where-Object {$_.state -eq "Listen"})',
    '@{processes=$processes;stampedProcesses=$stampedProcesses;connections=$connections;listeners=$listeners} | ConvertTo-Json -Depth 5 -Compress',
  ].join(';');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script]);
  if (result.exitCode !== 0) throw new PortableQaError(`post-cleanup inspection failed: ${result.stderr}`);
  const record = toRecord(JSON.parse(result.stdout), 'post-cleanup state');
  return {
    connections: Array.isArray(record.connections) ? record.connections.map((value) => toRecord(value)) : [],
    listeners: Array.isArray(record.listeners) ? record.listeners.map((value) => toRecord(value)) : [],
    processes: Array.isArray(record.processes) ? record.processes.map((value) => toRecord(value)) : [],
    stampedProcesses: Array.isArray(record.stampedProcesses)
      ? record.stampedProcesses.map((value) => toRecord(value))
      : [],
  };
}

export async function writeCleanupReceipt(input: CleanupReceiptInput): Promise<void> {
  const listenerPorts = [...input.lifecycle.listenerPorts, input.proxyPort];
  const postCleanup = await capturePostCleanupState({ ...input.lifecycle, listenerPorts });
  const remainingRoots = [];
  for (const path of input.lifecycle.extractionRoots) {
    if (await pathExists(path)) remainingRoots.push(path);
  }
  const zip = await stat(input.zipPath);
  const failures = [
    ...(input.cleanup.leftoverPath == null && input.cleanup.warning == null ? [] : ['primary extraction cleanup failed']),
    ...(remainingRoots.length === 0 ? [] : ['extraction/runtime roots remain']),
    ...(postCleanup.processes.length === 0 ? [] : ['run-bound processes remain']),
    ...(postCleanup.stampedProcesses.length === 0 ? [] : ['stamped processes remain']),
    ...(postCleanup.connections.length === 0 ? [] : ['relevant TCP connections remain']),
    ...(postCleanup.listeners.length === 0 ? [] : ['relevant listeners remain']),
  ];
  const receipt = {
    cleanupOperations: [
      'closed independent Chromium context/browser',
      'closed secondary Electron/browser/daemon process tree',
      'removed secondary extraction/runtime root',
      'closed primary Electron/browser/daemon process tree',
      'closed offline network trap',
      'removed primary extraction/runtime root',
      'inspected stamped processes and relevant active TCP/listeners',
    ],
    extractionRoots: input.lifecycle.extractionRoots,
    failures,
    finishedAt: new Date().toISOString(),
    postCleanup: {
      connections: postCleanup.connections,
      relevantListenerCount: postCleanup.listeners.length,
      relevantTcpCount: postCleanup.connections.length,
      remainingRoots,
      runBoundProcessCount: postCleanup.processes.length,
      runBoundProcesses: postCleanup.processes,
      stampedProcessCount: postCleanup.stampedProcesses.length,
      stampedProcesses: postCleanup.stampedProcesses,
    },
    rootPids: input.lifecycle.rootPids,
    runStatus: 'passed',
    runtimePaths: input.lifecycle.runtimePaths,
    status: failures.length === 0 ? 'passed' : 'failed',
    summaryCleanup: input.cleanup,
    zip: { length: zip.size, path: input.zipPath, sha256: await fileSha256(input.zipPath) },
  };
  await writeEvidence(input.evidenceRoot, 'cleanup-receipt.json', receipt);
  if (failures.length > 0) throw new PortableQaError(`successful-run cleanup verification failed: ${failures.join(', ')}`);
}
